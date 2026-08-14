import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { parseDecision, reviewRequest } from '../src/reviewer.ts'
import { Config } from '../src/index.ts'
import type { ApprovalLlmConfig, ReviewInput } from '../src/types.ts'

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

function failingStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      throw new Error('provider exploded')
    },
  }
}

function fakeContext(stream: AsyncIterable<StreamChunk>): Context {
  return {
    llm: { stream: vi.fn(async function* () { yield* stream }) },
    tools: { schemas: () => [] },
    logger: { info: vi.fn() },
  } as unknown as Context
}

function fakeSession(events: unknown[] = []) {
  return { id: SessionId('review-session'), events } as never
}

const input: ReviewInput = { toolName: 'pwsh', reason: 'run tests' }

describe('parseDecision', () => {
  it('parses a plain JSON decision', () => {
    expect(parseDecision('{"decision":"ALLOW","risk_level":"LOW","reason":"safe"}')).toEqual({
      decision: 'ALLOW',
      riskLevel: 'LOW',
      reason: 'safe',
    })
  })

  it('parses a fenced JSON decision', () => {
    expect(parseDecision('```json\n{"decision":"DENY","risk_level":"CRITICAL"}\n```')).toEqual({
      decision: 'DENY',
      riskLevel: 'CRITICAL',
    })
  })

  it('tolerates prose around the JSON object', () => {
    expect(parseDecision('Decision:\n{"decision":"ESCALATE","risk_level":"MEDIUM"}')).toEqual({
      decision: 'ESCALATE',
      riskLevel: 'MEDIUM',
    })
  })

  it('omits absent optional fields', () => {
    expect(parseDecision('{"decision":"ALLOW"}')).toEqual({ decision: 'ALLOW' })
  })

  it('rejects a missing decision', () => {
    expect(() => parseDecision('{"risk_level":"LOW"}')).toThrow()
  })

  it('rejects an invalid decision value', () => {
    expect(() => parseDecision('{"decision":"MAYBE"}')).toThrow()
  })

  it('rejects an invalid risk level', () => {
    expect(() => parseDecision('{"decision":"ALLOW","risk_level":"EXTREME"}')).toThrow()
  })

  it('rejects output without JSON', () => {
    expect(() => parseDecision('no json here')).toThrow()
  })
})

describe('reviewRequest', () => {
  it('returns ALLOW for an ALLOW decision', async () => {
    const ctx = fakeContext(textStream('{"decision":"ALLOW","risk_level":"LOW","reason":"fine"}'))
    const result = await reviewRequest(ctx, fakeSession(), input, config())
    expect(result.decision).toBe('ALLOW')
    expect(result.riskLevel).toBe('LOW')
    expect(result.failure).toBeUndefined()
    expect(result.route).toEqual({ provider: 'deepseek-official', model: 'reviewer-model' })
  })

  it('returns DENY for a DENY decision', async () => {
    const ctx = fakeContext(textStream('{"decision":"DENY","risk_level":"HIGH","reason":"no"}'))
    const result = await reviewRequest(ctx, fakeSession(), input, config())
    expect(result.decision).toBe('DENY')
  })

  it('returns ESCALATE for an ESCALATE decision', async () => {
    const ctx = fakeContext(textStream('{"decision":"ESCALATE","risk_level":"MEDIUM"}'))
    const result = await reviewRequest(ctx, fakeSession(), input, config())
    expect(result.decision).toBe('ESCALATE')
  })

  it('classifies unparseable output as PARSE_ERROR and escalates', async () => {
    const ctx = fakeContext(textStream('I am not sure about this one'))
    const result = await reviewRequest(ctx, fakeSession(), input, config())
    expect(result.decision).toBe('ESCALATE')
    expect(result.failure?.kind).toBe('PARSE_ERROR')
  })

  it('classifies a provider failure as MODEL_ERROR and escalates', async () => {
    const ctx = fakeContext(failingStream())
    const result = await reviewRequest(ctx, fakeSession(), input, config())
    expect(result.decision).toBe('ESCALATE')
    expect(result.failure?.kind).toBe('MODEL_ERROR')
  })

  it('falls back to the logged conversation route without an explicit pair', async () => {
    const ctx = fakeContext(textStream('{"decision":"ALLOW"}'))
    const session = fakeSession([
      { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'main-model' } }, reason: 'initial' } },
    ])
    const result = await reviewRequest(ctx, session, input, Config({} as unknown as ApprovalLlmConfig))
    expect(result.route).toEqual({ provider: 'deepseek-official', model: 'main-model' })
  })

  it('escalates when no route is available', async () => {
    const ctx = fakeContext(textStream('{"decision":"ALLOW"}'))
    const result = await reviewRequest(ctx, fakeSession(), input, Config({} as unknown as ApprovalLlmConfig))
    expect(result.decision).toBe('ESCALATE')
    expect(result.failure?.kind).toBe('MODEL_ERROR')
  })
})
