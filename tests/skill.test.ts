import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerSkillProvider } from '../src/skill.ts'

function harness(): { ctx: Context; registered: ReturnType<typeof vi.fn> } {
  const registered = vi.fn()
  const ctx = {
    skills: { registerProvider: registered },
  } as unknown as Context
  registerSkillProvider(ctx)
  return { ctx, registered }
}

describe('registerSkillProvider', () => {
  it('registers the bundled provider on ctx.skills', () => {
    const { registered } = harness()
    expect(registered).toHaveBeenCalledTimes(1)
  })

  it('lists the configure-approval-llm candidate as bundled', async () => {
    const { registered } = harness()
    const provider = registered.mock.calls[0]![0]!({ signal: new AbortController().signal, invalidate: vi.fn() })
    const listed = await provider.list({ cwd: process.cwd(), signal: new AbortController().signal })
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.name).toBe('configure-approval-llm')
    expect(candidate.source).toBe('bundled')
    expect(candidate.rank).toBe(600)
    expect(candidate.provider).toBe('dsh-approval-llm')
    expect(candidate.description).toContain('approval')
  })

  it('loads the skill body from assets/', async () => {
    const { registered } = harness()
    const provider = registered.mock.calls[0]![0]!({ signal: new AbortController().signal, invalidate: vi.fn() })
    const listed = await provider.list({ cwd: process.cwd(), signal: new AbortController().signal })
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    const definition = await provider.get(candidates[0]!, { cwd: process.cwd(), signal: new AbortController().signal })
    expect(definition).toBeDefined()
    expect(definition!.name).toBe('configure-approval-llm')
    expect(definition!.content).toContain('# 配置 dsh-approval-llm 评审模型')
    expect(definition!.content).toContain('AI 先配置，用户确认')
    expect(definition!.resourceBase).toEqual({
      kind: 'directory',
      path: expect.stringContaining('assets'),
    })
  })
})
