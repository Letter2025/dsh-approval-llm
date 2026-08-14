/**
 * Bundled `configure-approval-llm` skill provider.
 *
 * Ships the reviewer-configuration guide with the npm package, so installing
 * the plugin also puts the skill in the catalog (source `bundled`, rank 600,
 * the standard precedence for packaged skill providers). The body lives in
 * `assets/` and is read lazily on `get()`.
 * @module dsh-approval-llm/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'dsh-approval-llm'
const SKILL_BODY_URL = new URL('../assets/configure-approval-llm.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Configure the dsh-approval-llm reviewer model (provider/model) and its allowlist, denyList, humanOnlyList, and circuit-breaker policy with an AI-proposes / user-confirms flow. Use when the user asks to configure the approval reviewer, the approval model, or the approve-for-me policy, or to change what the model reviewer auto-allows or must hand to a human.'
const CANDIDATE: SkillCandidate = {
  name: 'configure-approval-llm',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Register the bundled reviewer-configuration provider on `ctx.skills`. */
export function registerSkillProvider(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
