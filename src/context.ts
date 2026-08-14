/**
 * Review-input assembly: the facts the reviewer model sees for one request.
 * The approval request deliberately carries no tool arguments (the answerer
 * attaches the decision to the already-streamed tool call via `callId`), so
 * the plugin recovers the arguments from the durable `tool/call` session event
 * and the tool description from the live tool registry — PLAN-058's dynamic
 * tool-description injection, resolved at review time instead of build time.
 * @module dsh-approval-llm/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ApprovalLlmConfig, ReviewInput } from './types.ts'

// The plugin injects the `tools` service; declare its ctx key the same way the
// owning package does (the augmentation only loads when that package is
// imported, and the plugin deliberately imports no dsh-tools runtime code).
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }
}

/** A conversation model route recovered from the session log. */
export interface ModelRoute {
  provider: string
  model: string
}

/**
 * Recover the exact tool-call arguments from the session log by call id.
 * @param session - session whose log holds the `tool/call` record.
 * @param callId - the tool call under review.
 * @param maxArgsChars - cap on the rendered JSON; longer input is truncated.
 * @returns the raw arguments JSON, or undefined when the record is absent.
 */
export function findToolCallArguments(
  session: Session,
  callId: CallId,
  maxArgsChars: number,
): string | undefined {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'tool/call' || event.data.callId !== callId) continue
    const raw = event.data.arguments
    if (raw.length <= maxArgsChars) return raw
    return `${raw.slice(0, maxArgsChars)}\n…[truncated]`
  }
  return undefined
}

/** The tool description the main model sees, from the live tool registry. */
export function findToolDescription(ctx: Context, toolName: string): string | undefined {
  return ctx.tools.schemas().find(schema => schema.name === toolName)?.description
}

/**
 * The conversation route from the last request header, used as the reviewer
 * fallback when the plugin config pins no explicit provider/model pair.
 * @param session - session whose log holds the `request/header` record.
 * @returns the last logged route, or undefined when the log has none.
 */
export function conversationRoute(session: Session): ModelRoute | undefined {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const config = event.data.header.config
    const provider = config.provider
    const model = config.model
    if (typeof provider === 'string' && provider.length > 0
      && typeof model === 'string' && model.length > 0) {
      return { provider, model }
    }
    return undefined
  }
  return undefined
}

/**
 * Assemble the review facts for one approval request.
 * @param ctx - context exposing the tool registry.
 * @param session - session whose log supplies tool arguments and the route.
 * @param callId - the tool call under review, when the asker has one.
 * @param toolName - the tool under review.
 * @param reason - the asker's explanation of why it is asking.
 * @param config - validated policy controlling arguments inclusion.
 * @returns the assembled review input.
 */
export function buildReviewInput(
  ctx: Context,
  session: Session,
  callId: CallId | undefined,
  toolName: string,
  reason: string | undefined,
  config: ApprovalLlmConfig,
): ReviewInput {
  const description = findToolDescription(ctx, toolName)
  const argumentsJson = config.includeArgs && callId !== undefined
    ? findToolCallArguments(session, callId, config.maxArgsChars)
    : undefined
  return {
    toolName,
    ...(description === undefined ? {} : { description }),
    ...(reason === undefined ? {} : { reason }),
    ...(argumentsJson === undefined ? {} : { arguments: argumentsJson }),
  }
}
