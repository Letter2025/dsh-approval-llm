import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, Config } from '../src/index.ts'
import type { ApprovalLlmConfig } from '../src/types.ts'

type Answerer = (req: never, next: any) => Promise<never>

function config(overrides: Partial<ApprovalLlmConfig> = {}): ApprovalLlmConfig {
  return Config({ provider: 'deepseek-official', model: 'reviewer-model', ...overrides } as unknown as ApprovalLlmConfig)
}

function textStream(text: string): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

interface FakeHarness {
  ctx: Context
  answer: Answerer
  stream: ReturnType<typeof vi.fn>
  next: ReturnType<typeof vi.fn>
  setPreset: (preset: string) => void
}

function harness(cfg: ApprovalLlmConfig, streamText?: string): FakeHarness {
  const listeners: Answerer[] = []
  let activePreset = 'model-approval'
  const stream = vi.fn(async function* () {
    if (streamText !== undefined) yield* textStream(streamText)
  })
  const ctx = {
    on: (event: string, cb: Answerer) => {
      if (event === 'approval/request') listeners.push(cb)
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: { stream },
    tools: { schemas: () => [] },
    permissionPresets: { current: vi.fn(() => activePreset) },
  } as unknown as Context
  apply(ctx, cfg)
  return {
    ctx,
    answer: listeners[0]!,
    stream,
    next: vi.fn(async () => 'unavailable' as never),
    setPreset: (preset: string) => { activePreset = preset },
  }
}

function request(toolName: string, overrides: { reason?: string; sessionId?: string } = {}) {
  const session = {
    id: SessionId(overrides.sessionId ?? 's1'),
    events: [],
    append: vi.fn(),
  }
  const req = {
    toolName,
    agent: { session },
    callId: 'call-1',
    reason: overrides.reason ?? 'test request',
    signal: new AbortController().signal,
  }
  return { req: req as never, session }
}

describe('dsh-approval-llm answerer', () => {
  it('auto-approves allowlisted tools without calling the model', async () => {
    const h = harness(config({ allowlist: ['read'] }))
    const { req } = request('read')
    const outcome = await h.answer(req, h.next)
    expect(outcome).toBe('allowed-once')
    expect(h.stream).not.toHaveBeenCalled()
    expect(h.next).not.toHaveBeenCalled()
  })

  it('rejects deny-listed tools without calling the model', async () => {
    const h = harness(config({ denyList: ['destroy'] }))
    const outcome = await h.answer(request('destroy').req, h.next)
    expect(outcome).toBe('rejected')
    expect(h.stream).not.toHaveBeenCalled()
  })

  it('hands human-only tools to the next answerer', async () => {
    const h = harness(config({ humanOnlyList: ['delete'] }))
    const outcome = await h.answer(request('delete').req, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('unavailable')
    expect(h.stream).not.toHaveBeenCalled()
  })

  it('delegates entirely when disabled', async () => {
    const h = harness(config({ enabled: false }))
    await h.answer(request('pwsh').req, h.next)
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
  })

  it('delegates every request outside the model-approval preset', async () => {
    const h = harness(config())
    h.setPreset('workspace-write')
    const { req } = request('pwsh')
    const outcome = await h.answer(req, h.next)
    expect(outcome).toBe('unavailable')
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.stream).not.toHaveBeenCalled()
  })

  it('reviews requests inside the model-approval preset', async () => {
    const h = harness(config(), '{"decision":"ALLOW","risk_level":"LOW"}')
    const { req } = request('pwsh')
    const outcome = await h.answer(req, h.next)
    expect(outcome).toBe('allowed-once')
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('reviews every ask when modePreset is empty', async () => {
    const h = harness(config({ modePreset: '' }), '{"decision":"ALLOW","risk_level":"LOW"}')
    h.setPreset('workspace-write')
    const { req } = request('pwsh')
    const outcome = await h.answer(req, h.next)
    expect(outcome).toBe('allowed-once')
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('reviews under a custom configured modePreset name', async () => {
    const h = harness(config({ modePreset: 'guardian' }), '{"decision":"ALLOW"}')
    h.setPreset('workspace-write')
    expect(await h.answer(request('pwsh').req, h.next)).toBe('unavailable')
    h.setPreset('guardian')
    expect(await h.answer(request('pwsh').req, h.next)).toBe('allowed-once')
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('approves on a model ALLOW and resets the denial counter', async () => {
    const h2 = harness(config({ maxConsecutiveDenials: 2 }), '{"decision":"ALLOW","risk_level":"LOW"}')
    expect(await h2.answer(request('pwsh').req, h2.next)).toBe('allowed-once')
    expect(h2.stream).toHaveBeenCalledTimes(1)
  })

  it('rejects on a model DENY', async () => {
    const h = harness(config(), '{"decision":"DENY","risk_level":"HIGH","reason":"risky"}')
    const outcome = await h.answer(request('pwsh').req, h.next)
    expect(outcome).toBe('rejected')
    expect(h.next).not.toHaveBeenCalled()
  })

  it('hands an ESCALATE decision to the next answerer', async () => {
    const h = harness(config(), '{"decision":"ESCALATE","risk_level":"MEDIUM"}')
    const outcome = await h.answer(request('pwsh').req, h.next)
    expect(outcome).toBe('unavailable')
    expect(h.next).toHaveBeenCalledTimes(1)
  })

  it('fails to human when the reviewer model throws', async () => {
    const h = harness(config())
    h.stream.mockImplementationOnce(async function* () {
      throw new Error('provider exploded')
    })
    const outcome = await h.answer(request('pwsh').req, h.next)
    expect(outcome).toBe('unavailable')
    expect(h.next).toHaveBeenCalledTimes(1)
  })

  it('trips the circuit breaker after maxConsecutiveDenials and hands off', async () => {
    const h = harness(config({ maxConsecutiveDenials: 1 }), '{"decision":"DENY","risk_level":"HIGH"}')
    expect(await h.answer(request('pwsh').req, h.next)).toBe('rejected')
    expect(h.stream).toHaveBeenCalledTimes(1)
    const outcome = await h.answer(request('pwsh').req, h.next)
    expect(outcome).toBe('unavailable')
    expect(h.next).toHaveBeenCalledTimes(1)
    expect(h.stream).toHaveBeenCalledTimes(1)
  })

  it('resets the denial counter on an ALLOW', async () => {
    const h = harness(config({ maxConsecutiveDenials: 2 }))
    h.stream
      .mockImplementationOnce(async function* () { yield* textStream('{"decision":"DENY"}') })
      .mockImplementationOnce(async function* () { yield* textStream('{"decision":"ALLOW"}') })
      .mockImplementationOnce(async function* () { yield* textStream('{"decision":"DENY"}') })
    expect(await h.answer(request('pwsh').req, h.next)).toBe('rejected')
    expect(await h.answer(request('pwsh').req, h.next)).toBe('allowed-once')
    expect(await h.answer(request('pwsh').req, h.next)).toBe('rejected')
    expect(h.next).not.toHaveBeenCalled()
  })

  it('keys the denial counter per session', async () => {
    const h = harness(config({ maxConsecutiveDenials: 1 }), '{"decision":"DENY","risk_level":"HIGH"}')
    expect(await h.answer(request('pwsh', { sessionId: 'a' }).req, h.next)).toBe('rejected')
    expect(await h.answer(request('pwsh', { sessionId: 'b' }).req, h.next)).toBe('rejected')
    expect(h.stream).toHaveBeenCalledTimes(2)
    expect(await h.answer(request('pwsh', { sessionId: 'a' }).req, h.next)).toBe('unavailable')
    expect(h.stream).toHaveBeenCalledTimes(2)
  })

  it('appends a decision message on ALLOW', async () => {
    const h = harness(config(), '{"decision":"ALLOW","risk_level":"LOW","reason":"safe"}')
    const { req, session } = request('pwsh')
    await h.answer(req, h.next)
    expect(session.append).toHaveBeenCalledWith(
      'user/message',
      expect.objectContaining({
        content: [{ type: 'text', text: '✅ 模型审批通过 "pwsh"（风险 LOW）— safe' }],
        source: { kind: 'plugin', plugin: 'dsh-approval-llm' },
      }),
      { surfaceOp: 'append' },
    )
  })

  it('appends a decision message on DENY', async () => {
    const h = harness(config(), '{"decision":"DENY","risk_level":"CRITICAL","reason":"no"}')
    const { req, session } = request('pwsh')
    await h.answer(req, h.next)
    expect(session.append).toHaveBeenCalledWith(
      'user/message',
      expect.objectContaining({
        content: [{ type: 'text', text: '❌ 模型审批拒绝 "pwsh"（风险 CRITICAL）— no' }],
      }),
      { surfaceOp: 'append' },
    )
  })

  it('does not append a message on ESCALATE', async () => {
    const h = harness(config(), '{"decision":"ESCALATE","risk_level":"MEDIUM"}')
    const { req, session } = request('pwsh')
    await h.answer(req, h.next)
    expect(session.append).not.toHaveBeenCalled()
  })

  it('skips the decision message when notifyUser is false', async () => {
    const h = harness(config({ notifyUser: false }), '{"decision":"ALLOW","risk_level":"LOW"}')
    const { req, session } = request('pwsh')
    await h.answer(req, h.next)
    expect(session.append).not.toHaveBeenCalled()
  })
})
