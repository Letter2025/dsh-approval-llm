/**
 * Deterministic routing policy (PLAN-058 §4.3): decides BEFORE any model call
 * whether a request is auto-approved, rejected, reserved for a human, or sent
 * to the model reviewer. Exact-name membership only; the reviewer model
 * evaluates arguments for everything that reaches REVIEW.
 * @module dsh-approval-llm/routing
 */

import type { RouteDecision } from './types.ts'

/**
 * Route one tool name through the deterministic policy.
 * DENY outranks the allowlist so a tool cannot be both listed and approved.
 * @param allowlist - tool names auto-approved (SAFE_ALLOW).
 * @param denyList - tool names rejected outright.
 * @param humanOnlyList - tool names reserved for human decision.
 * @param toolName - the tool under review.
 * @returns the routing outcome.
 */
export function routeTool(
  allowlist: readonly string[],
  denyList: readonly string[],
  humanOnlyList: readonly string[],
  toolName: string,
): RouteDecision {
  if (denyList.includes(toolName)) return 'DENY'
  if (allowlist.includes(toolName)) return 'SAFE_ALLOW'
  if (humanOnlyList.includes(toolName)) return 'HUMAN_ONLY'
  return 'REVIEW'
}
