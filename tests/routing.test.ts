import { describe, expect, it } from 'vitest'
import { routeTool } from '../src/routing.ts'

const allowlist = ['read', 'grep', 'glob']
const denyList = ['destroy', 'exfiltrate']
const humanOnlyList = ['delete']

describe('routeTool', () => {
  it('denies tools on the deny list before the allowlist', () => {
    expect(routeTool(allowlist, denyList, humanOnlyList, 'destroy')).toBe('DENY')
  })

  it('auto-approves allowlisted tools', () => {
    expect(routeTool(allowlist, denyList, humanOnlyList, 'read')).toBe('SAFE_ALLOW')
  })

  it('reserves human-only tools for a human', () => {
    expect(routeTool(allowlist, denyList, humanOnlyList, 'delete')).toBe('HUMAN_ONLY')
  })

  it('routes everything else to REVIEW', () => {
    expect(routeTool(allowlist, denyList, humanOnlyList, 'pwsh')).toBe('REVIEW')
  })

  it('routes unknown tools to REVIEW when all lists are empty', () => {
    expect(routeTool([], [], [], 'anything')).toBe('REVIEW')
  })
})
