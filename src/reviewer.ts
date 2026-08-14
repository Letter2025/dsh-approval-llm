/**
 * The model reviewer: one isolated security-policy request per approval
 * (PLAN-058 §4.5 — the reviewer, never the main agent, holds the full policy),
 * with JSON-framed facts so tool output cannot break structural delimiters,
 * and fail-to-human classification (TIMEOUT / PARSE_ERROR / MODEL_ERROR) on
 * the ESCALATE path.
 * @module dsh-approval-llm/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Session } from '@deepseek-ai/dsh-session'
import { conversationRoute } from './context.ts'
import type {
  ApprovalLlmConfig,
  ReviewInput,
  ReviewerDecision,
  ReviewerFailure,
  ReviewerResult,
  RiskLevel,
} from './types.ts'

/** Capability-owned timeout code for reviewer requests. */
export const APPROVAL_TIMEOUT_CODE = 'APPROVAL_LLM_TIMEOUT'

/**
 * Built-in security policy. Kept apart from any main-agent prompt so the
 * requesting agent cannot learn the review rules and tailor its asks.
 */
export const DEFAULT_APPROVAL_POLICY = [
  'You are a permission reviewer for an AI coding agent. Decide whether one tool call may proceed.',
  'Return ONLY a JSON object with exactly this shape:',
  '{"decision":"ALLOW|DENY|ESCALATE","risk_level":"LOW|MEDIUM|HIGH|CRITICAL","reason":"<one short sentence>"}',
  'Rules:',
  '- ALLOW: the action is safe, reversible, or explicitly required by the user. Most requests are ALLOW.',
  '- DENY: the action would exfiltrate data, steal credentials, or destroy data irreversibly. CRITICAL risks are denied even when the user asked for them.',
  '- ESCALATE: you cannot decide. Never guess; escalate so a human decides.',
  '- Deleting, sending, or modifying files is NOT by itself a reason to deny. What matters is the target and the intent.',
  '- A tool can be tricked by its arguments: review the actual arguments, not just the tool name.',
].join('\n')

function buildSystemPrompt(config: ApprovalLlmConfig): string {
  return config.systemPrompt ?? DEFAULT_APPROVAL_POLICY
}

/** Resolve the reviewer route: explicit config pair, else the logged conversation route. */
function resolveReviewerRoute(
  config: ApprovalLlmConfig,
  session: Session,
): { provider: string; model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const route = conversationRoute(session)
  if (route === undefined) {
    throw new Error('dsh-approval-llm: no logged conversation route; configure provider and model together')
  }
  return route
}

/** Frame review facts as JSON so tool output cannot break structural delimiters. */
function frameReviewInput(input: ReviewInput): string {
  return JSON.stringify({
    tool_name: input.toolName,
    description: input.description ?? null,
    reason: input.reason ?? null,
    arguments: input.arguments ?? null,
  })
}

/** Translate a terminal finish into a reviewer failure error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return new Error('reviewer output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('reviewer model unexpectedly requested a tool')
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    default:
      return new Error(`unsupported reviewer finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

function isDecision(value: unknown): value is ReviewerDecision {
  return value === 'ALLOW' || value === 'DENY' || value === 'ESCALATE'
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' || value === 'CRITICAL'
}

/** Extract the first JSON object from a model reply, tolerating code fences and prose. */
function extractJsonObject(text: string): unknown | undefined {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = stripped.indexOf('{')
  if (start === -1) return undefined
  const end = stripped.lastIndexOf('}')
  if (end <= start) return undefined
  try {
    return JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * Parse and validate the structured decision from reviewer text.
 * @param text - the assembled reviewer text output.
 * @returns the validated decision fields.
 * @throws when the output carries no valid JSON decision.
 */
export function parseDecision(text: string): {
  decision: ReviewerDecision
  riskLevel?: RiskLevel
  reason?: string
} {
  const parsed = extractJsonObject(text)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    throw new Error('reviewer output contains no JSON object')
  }
  const record = parsed as Record<string, unknown>
  const decision = record['decision']
  if (!isDecision(decision)) {
    throw new Error(`reviewer output has invalid decision "${String(decision)}"`)
  }
  const riskLevel = record['risk_level']
  if (riskLevel !== undefined && !isRiskLevel(riskLevel)) {
    throw new Error(`reviewer output has invalid risk_level "${String(riskLevel)}"`)
  }
  const reason = record['reason']
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('reviewer output has a non-string reason')
  }
  return {
    decision,
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function classifyFailure(error: unknown, timedOut: boolean): ReviewerFailure {
  const message = error instanceof Error ? error.message : String(error)
  return timedOut ? { kind: 'TIMEOUT', message } : { kind: 'MODEL_ERROR', message }
}

/**
 * Run one review through the reviewer model.
 * @param ctx - context exposing the LLM service.
 * @param session - session whose log supplies the fallback route.
 * @param input - the assembled review facts.
 * @param config - validated policy.
 * @param signal - cancellation from the approval request.
 * @returns a decision, or ESCALATE with a failure classification for fail-to-human.
 */
export async function reviewRequest(
  ctx: Context,
  session: Session,
  input: ReviewInput,
  config: ApprovalLlmConfig,
  signal?: AbortSignal,
): Promise<ReviewerResult> {
  const callDeadline = deadline(signal, config.timeoutMs, APPROVAL_TIMEOUT_CODE)
  let route: { provider: string; model: string } | undefined
  try {
    // Route resolution is inside the try so a missing route fails to human
    // (ESCALATE + MODEL_ERROR) instead of throwing out of the answerer.
    route = resolveReviewerRoute(config, session)
    const system = buildSystemPrompt(config)
    const framed = frameReviewInput(input)
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: framed }],
      source: { kind: 'plugin', plugin: 'dsh-approval-llm' },
    })]
    const options: GenerateOptions = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      system,
      maxTokens: config.maxOutputTokens,
      sessionId: session.id,
      signal: callDeadline.signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) throw terminalError
    const blocks = assembler.blocks()
    const text = blocks
      .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    let parsed: ReturnType<typeof parseDecision>
    try {
      parsed = parseDecision(text)
    } catch (error) {
      return {
        decision: 'ESCALATE',
        route,
        failure: {
          kind: 'PARSE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    return { ...parsed, route }
  } catch (error) {
    const timedOut = timeoutOf(callDeadline.signal, APPROVAL_TIMEOUT_CODE) !== undefined
    return { decision: 'ESCALATE', ...(route === undefined ? {} : { route }), failure: classifyFailure(error, timedOut) }
  } finally {
    callDeadline[Symbol.dispose]()
  }
}
