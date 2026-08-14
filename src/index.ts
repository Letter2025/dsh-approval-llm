/**
 * dsh-approval-llm: model-based permission approval for DeepSeek Harness.
 *
 * The plugin answers the `approval/request` waterfall (Codex's
 * approvals_reviewer=auto_review) with a separate reviewer model, but only in
 * the dedicated permission preset (`modePreset`, default `model-approval`):
 * outside that mode every request delegates to the next answerer (the human
 * channel), so model review never front-runs human approval. Inside the mode:
 * a deterministic routing policy decides SAFE_ALLOW / DENY / HUMAN_ONLY up
 * front, the reviewer model decides everything else (ALLOW / DENY / ESCALATE),
 * and model failures and ESCALATE hand the request back to a human via
 * `next()`. Consecutive DENY hits a circuit breaker that also hands off.
 * Model decisions are appended to the session as a user-visible message, so
 * the main chain records why a call was approved or denied.
 * @module dsh-approval-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { routeTool } from './routing.ts'
import { buildReviewInput } from './context.ts'
import { reviewRequest } from './reviewer.ts'
import { registerSkillProvider } from './skill.ts'
import type { ApprovalLlmConfig, ReviewerResult } from './types.ts'

// The plugin injects the permission-presets service; declare its ctx key (the
// owning package's augmentation only loads when that package is imported, and
// the plugin imports no dsh-permission-presets runtime code).
declare module '@deepseek-ai/cordis' {
  interface Context {
    permissionPresets: PermissionPresetService
  }
}

export const name = 'dsh-approval-llm'
export const inject = ['llm', 'tools', 'permissionPresets', 'skills']

export const Config: z<ApprovalLlmConfig> = z.object({
  enabled: z.boolean().default(true),
  modePreset: z.string(),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().default(60000).min(1),
  maxOutputTokens: z.number().default(256).min(1),
  systemPrompt: z.string(),
  allowlist: z.array(z.string()).default([]),
  denyList: z.array(z.string()).default([]),
  humanOnlyList: z.array(z.string()).default([]),
  maxConsecutiveDenials: z.number().default(3).min(0),
  maxArgsChars: z.number().default(4000).min(1),
  includeArgs: z.boolean().default(true),
  notifyUser: z.boolean().default(true),
})

/** Validate and detach configuration; fails loud on a malformed route pair. */
function resolveConfig(config: ApprovalLlmConfig): ApprovalLlmConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('dsh-approval-llm: provider and model must be configured together')
  }
  return config
}

/**
 * The mode the reviewer activates on. Empty string disables the gate; an
 * omitted value defaults to the dedicated `model-approval` preset.
 */
function reviewerMode(config: ApprovalLlmConfig): string | undefined {
  return config.modePreset === '' ? undefined : (config.modePreset ?? 'model-approval')
}

/**
 * Append a user-visible decision message to the session so the main chain
 * records why a call was approved or denied. A failure here is logged and
 * never changes the approval outcome.
 */
function notifyDecision(
  ctx: Context,
  session: import('@deepseek-ai/dsh-session').Session,
  req: ApprovalRequest,
  result: ReviewerResult,
  enabled: boolean,
): void {
  if (!enabled) return
  const mark = result.decision === 'ALLOW' ? '✅' : '❌'
  const verb = result.decision === 'ALLOW' ? '通过' : '拒绝'
  const risk = result.riskLevel ?? 'n/a'
  const reason = result.reason ?? ''
  const text = `${mark} 模型审批${verb} "${req.toolName}"（风险 ${risk}）${reason === '' ? '' : `— ${reason}`}`
  try {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-approval-llm' },
    }), { surfaceOp: 'append' })
  } catch (error) {
    ctx.logger.error(
      '[dsh-approval-llm] failed to append decision notice: %s',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Register the approval answerer and the bundled reviewer-configuration skill.
 * @param ctx - context exposing the LLM, tool-registry, permission-preset, and skills services.
 * @param rawConfig - untrusted plugin configuration, validated by the schema.
 */
export function apply(ctx: Context, rawConfig: ApprovalLlmConfig): void {
  registerSkillProvider(ctx)
  const config = resolveConfig(rawConfig)
  const mode = reviewerMode(config)
  const denials = new Map<string, number>()

  ctx.on('approval/request', async (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (!config.enabled) return next()

    const session = req.agent.session
    // Mode gate: outside the dedicated preset the reviewer does not exist —
    // every request, allowlist included, delegates to the human channel.
    if (mode !== undefined && ctx.permissionPresets.current(session.events) !== mode) {
      return next()
    }

    switch (routeTool(config.allowlist, config.denyList, config.humanOnlyList, req.toolName)) {
      case 'SAFE_ALLOW':
        return 'allowed-once'
      case 'DENY':
        return 'rejected'
      case 'HUMAN_ONLY':
        return next()
      case 'REVIEW':
        break
    }

    const prior = denials.get(session.id) ?? 0
    if (config.maxConsecutiveDenials > 0 && prior >= config.maxConsecutiveDenials) {
      ctx.logger.info(
        '[dsh-approval-llm] circuit breaker (%d consecutive denials): handing "%s" to a human',
        prior,
        req.toolName,
      )
      return next()
    }

    const input = buildReviewInput(ctx, session, req.callId, req.toolName, req.reason, config)
    const result = await reviewRequest(ctx, session, input, config, req.signal)
    const failure = result.failure === undefined
      ? ''
      : ` (${result.failure.kind}: ${result.failure.message})`
    ctx.logger.info(
      '[dsh-approval-llm] "%s": %s risk=%s via %s/%s%s',
      req.toolName,
      result.decision,
      result.riskLevel ?? 'n/a',
      result.route?.provider ?? 'n/a',
      result.route?.model ?? 'n/a',
      failure,
    )

    switch (result.decision) {
      case 'ALLOW':
        denials.set(session.id, 0)
        notifyDecision(ctx, session, req, result, config.notifyUser)
        return 'allowed-once'
      case 'DENY':
        denials.set(session.id, prior + 1)
        notifyDecision(ctx, session, req, result, config.notifyUser)
        return 'rejected'
      default:
        return next()
    }
  })
}
