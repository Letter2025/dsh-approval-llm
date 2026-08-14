/**
 * Shared types for the model-approval reviewer plugin.
 * The decision vocabulary mirrors AGENTSCOPE-PLAN-058 (ALLOW / DENY / ESCALATE)
 * mapped onto the dsh approval outcomes at the plugin boundary.
 * @module dsh-approval-llm
 */

/** Decision vocabulary of the reviewer model (PLAN-058 three-way outcome). */
export type ReviewerDecision = 'ALLOW' | 'DENY' | 'ESCALATE'

/** Reviewer risk classification, as requested in the structured decision. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/** Deterministic routing outcome decided before any model call. */
export type RouteDecision = 'SAFE_ALLOW' | 'DENY' | 'HUMAN_ONLY' | 'REVIEW'

/** Deployment policy for the model-approval reviewer. */
export interface ApprovalLlmConfig {
  /** Master switch; when false the plugin delegates every request unchanged. */
  enabled: boolean
  /**
   * The permission preset that activates the reviewer. When set, the plugin
   * only answers asks from sessions whose effective preset equals this name;
   * every other session delegates to the next answerer (the human channel).
   * When empty, the plugin reviews every ask. Defaults to `model-approval`
   * when omitted, so model review happens only in the dedicated mode.
   */
  modePreset?: string
  /** Explicit reviewer provider route; must be paired with `model`. */
  provider?: string
  /** Explicit reviewer model id; must be paired with `provider`. */
  model?: string
  /** End-to-end reviewer request deadline in milliseconds. */
  timeoutMs: number
  /** Reviewer output-token cap. */
  maxOutputTokens: number
  /** Custom security-policy system prompt; the built-in policy applies when absent. */
  systemPrompt?: string
  /** Tool names auto-approved without a model call (SAFE_ALLOW). */
  allowlist: string[]
  /** Tool names rejected without a model call. */
  denyList: string[]
  /** Tool names that must be decided by a human (HUMAN_ONLY); never auto-reviewed. */
  humanOnlyList: string[]
  /** Consecutive DENY threshold before the reviewer hands off to a human; 0 disables. */
  maxConsecutiveDenials: number
  /** Cap on tool-argument JSON rendered to the reviewer. */
  maxArgsChars: number
  /** Include tool arguments recovered from the session log in the review input. */
  includeArgs: boolean
  /** Append a user-visible decision message to the session after ALLOW/DENY. */
  notifyUser: boolean
}

/** Facts assembled for one review, fed to the reviewer model. */
export interface ReviewInput {
  toolName: string
  description?: string
  reason?: string
  arguments?: string
}

/** Classification of reviewer model failures (PLAN-058 fail-to-human taxonomy). */
export interface ReviewerFailure {
  kind: 'TIMEOUT' | 'PARSE_ERROR' | 'MODEL_ERROR'
  message: string
}

/** One completed review: a decision plus the route and any failure. */
export interface ReviewerResult {
  decision: ReviewerDecision
  riskLevel?: RiskLevel
  reason?: string
  /** Route used for the review; absent only when route resolution failed. */
  route?: { provider: string; model: string }
  failure?: ReviewerFailure
}
