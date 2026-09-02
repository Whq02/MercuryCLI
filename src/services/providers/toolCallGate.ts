// ============================================================================
//  providers/toolCallGate — schema enforcement at the transport boundary:
//  ONE owner for every provider family whose wire delivers tool-call
//  arguments as raw text Mercury parses itself (the OpenAI Responses
//  runtime and the whole chat-completions family — Z.AI, Moonshot,
//  DeepSeek, OpenRouter, Gemini, Hugging Face, local servers, the compat
//  slot).
//
//  The law: an adapter mints a tool_use block ONLY for a call whose tool is
//  in the session catalog and whose settled arguments satisfy that tool's
//  input schema — the SAME zod schema the executor re-parses
//  (services/tools/toolExecution.ts) and the same wire schema the request
//  advertised (utils/api.ts toolToAPISchema). Anything else is a typed
//  refusal: the adapter mints a visible note instead of the block and
//  attaches the refusal record to that settled message; the turn machine
//  (run-core/turn-machine.ts) hands the model the correction on the next
//  user turn so it re-issues the call. No consumer between the wire and the
//  executor ever holds arguments the schema rejects, and no call is ever
//  half-executed.
//
//  Validation happens at SETTLEMENT — arguments fully accumulated; partial
//  streams paint for visibility only — and reads the raw object: a passing
//  call mints exactly the object the model sent (defaults and transforms
//  apply at execution, as on the Anthropic wire), so replay stays faithful.
//  Top-level nulls are dropped first (the null-optional law, one owner in
//  openai/openaiWire.ts) so an optional field spelled `null` reads as
//  omitted on every dialect.
// ============================================================================
import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { AssistantMessage, RefusedToolCall } from '../../types/message.js'
import { formatZodValidationError } from '../../utils/toolErrors.js'
import { stripNullArgs } from './openai/openaiWire.js'

/** The settled call as every decoder delivers it: identity + raw bytes, and
 *  the decoder's own malformed flag (set for unparseable JSON OR a missing
 *  id/name — the gate tells those apart by re-parsing). */
export interface IncomingToolCall {
  id: string
  name: string
  argumentsRaw: string
  malformed: boolean
}

export type ToolCallVerdict =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; refusal: RefusedToolCall }

/** The decoders' placeholder ids for calls that arrived without one. */
const PLACEHOLDER_ID = /^missing-(call-)?id(-\d+)?$/

function refused(call: IncomingToolCall, code: RefusedToolCall['code'], reason: string): ToolCallVerdict {
  return {
    ok: false,
    refusal: { id: call.id, name: call.name, argumentsRaw: call.argumentsRaw, code, reason },
  }
}

/** The admission road, named inside a schema refusal for a deferred tool
 *  whose schema this request never carried (the model called it by its
 *  announced name alone). Route-independent: every text-form lane passes
 *  the plan's predicate; the sentence is the SAME one the Anthropic wire's
 *  schema-validation hint speaks. */
export interface ToolCallGateHints {
  /** True for a deferred tool the conversation has not admitted. */
  deferredUnadmitted?: (name: string) => boolean
}

export function schemaNotSentSentence(toolName: string): string {
  return `This tool's schema was not sent to the model: ${toolName} is a deferred tool this session has not admitted yet. Load it first: call ToolSearch with query "select:${toolName}", then retry the call with the schema in hand.`
}

/**
 * Judge one settled call against the session catalog. Pure over its inputs;
 * never throws — a schema whose parse throws is a refusal, not a crash.
 */
export function gateToolCall(tools: Tools, call: IncomingToolCall, hints?: ToolCallGateHints): ToolCallVerdict {
  if (call.name.trim() === '') {
    return refused(call, 'unknown-tool', 'the call carried no tool name')
  }
  const tool = findToolByName(tools, call.name)
  if (!tool) {
    return refused(call, 'unknown-tool', `No such tool available: ${call.name}`)
  }
  const raw = call.argumentsRaw.trim() === '' ? '{}' : call.argumentsRaw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return refused(
      call,
      'invalid-json',
      `the arguments were not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (call.malformed && (call.id.trim() === '' || PLACEHOLDER_ID.test(call.id))) {
    return refused(call, 'missing-id', 'the provider delivered the call without a call id, so its result could not be paired')
  }
  const stripped = stripNullArgs(parsed)
  if (typeof stripped !== 'object' || stripped === null || Array.isArray(stripped)) {
    return refused(
      call,
      'not-an-object',
      `the arguments must be a JSON object, not ${Array.isArray(stripped) ? 'an array' : stripped === null ? 'null' : `a ${typeof stripped}`}`,
    )
  }
  const input = stripped as Record<string, unknown>
  try {
    const verdict = tool.inputSchema.safeParse(input)
    if (!verdict.success) {
      const reason = formatZodValidationError(tool.name, verdict.error, tool.inputJSONSchema)
      // An unadmitted deferred tool was called blind — the refusal is typed
      // and names the admission road, on every route.
      const unadmitted = hints?.deferredUnadmitted?.(tool.name) === true
      return refused(call, 'schema', unadmitted ? `${reason}\n${schemaNotSentSentence(tool.name)}` : reason)
    }
  } catch (error) {
    return refused(
      call,
      'schema',
      `the ${tool.name} tool's input schema could not validate these arguments (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return { ok: true, input }
}

/**
 * Judge a settled turn's calls together, in order: each goes through
 * gateToolCall, and a call whose id an EARLIER call of the same turn already
 * carries is refused as 'duplicate-id' — one id can only ever be answered
 * once (the Anthropic API rejects duplicate tool_use ids outright; the
 * Responses replay pairs one function_call_output per call_id; a chat
 * `tool` row answers one tool_call_id), so a second call under the same id
 * has no place on any wire. The first call keeps its id and runs. One
 * verdict per input, same order.
 */
export function gateToolCalls(tools: Tools, calls: readonly IncomingToolCall[], hints?: ToolCallGateHints): ToolCallVerdict[] {
  const seen = new Set<string>()
  return calls.map(call => {
    const verdict = gateToolCall(tools, call, hints)
    if (!verdict.ok) return verdict
    if (seen.has(call.id)) {
      return refused(
        call,
        'duplicate-id',
        `the provider reused call id ${call.id} for a second call in the same turn; only the first call carrying that id ran`,
      )
    }
    seen.add(call.id)
    return verdict
  })
}

const RAW_PREVIEW_CHARS = 600

function previewRaw(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return '(empty)'
  return trimmed.length > RAW_PREVIEW_CHARS
    ? `${trimmed.slice(0, RAW_PREVIEW_CHARS)}… [${trimmed.length - RAW_PREVIEW_CHARS} more characters]`
    : trimmed
}

/** The schema formatter's issue lines without its headline, joined for a
 *  one-line note. */
function issueSummary(reason: string): string {
  const lines = reason.split('\n').map(l => l.trim()).filter(Boolean)
  const body = lines.length > 1 && /failed due to the following issue/.test(lines[0]!) ? lines.slice(1) : lines
  return body.join('; ')
}

/** The operator-visible note the adapter settles in place of the block —
 *  the same voice as every other adapter note (`[lane] …`). */
export function toolCallRefusalNote(lane: string, refusal: RefusedToolCall): string {
  const name = refusal.name.trim() === '' ? 'unnamed' : refusal.name
  switch (refusal.code) {
    case 'unknown-tool':
      // The SAME core sentence the Anthropic wire returns ("No such tool
      // available: X"), plus the wire fact that the call was refused before
      // execution and the one line that unblocks the model.
      return `[${lane}] No such tool available: ${name} — it is not in this session's tool list, so it was not executed. Call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
    case 'missing-id':
      return `[${lane}] the provider emitted a malformed tool call (${name}): it carried no call id, so it was not executed.`
    case 'invalid-json':
      return `[${lane}] the provider emitted a malformed tool call (${name}): its arguments were not valid JSON, so it was not executed.`
    case 'not-an-object':
      return `[${lane}] the provider emitted a malformed tool call (${name}): its arguments were not a JSON object, so it was not executed.`
    case 'schema':
      return `[${lane}] the provider emitted a malformed tool call (${name}): the arguments do not match the tool's input schema (${issueSummary(refusal.reason)}) — it was not executed.`
    case 'duplicate-id':
      return `[${lane}] the provider emitted a second tool call (${name}) under a call id already used in this turn (${refusal.id}) — only the first call with that id was executed.`
  }
}

/** First line of the model-visible correction — the stable classifier
 *  transcript tooling keys on (the STREAM_FAULT_RECOVERY_NUDGE precedent). */
export const TOOL_CALL_REFUSAL_CORRECTION_HEAD =
  'One or more of your tool calls were refused by the harness before execution:'

/** The model-visible correction for a turn's refusals — injected as the next
 *  user turn. States what was refused, why, and what the model sent, then
 *  asks for a corrected call. Never executes anything. */
export function toolCallRefusalCorrection(refusals: readonly RefusedToolCall[]): string {
  const items = refusals.map(refusal => {
    const name = refusal.name.trim() === '' ? '(no tool name)' : refusal.name
    const headline =
      refusal.code === 'unknown-tool'
        ? `unknown tool ${name}: ${refusal.reason}`
        : refusal.code === 'duplicate-id'
          ? `duplicate call id for ${name}: ${refusal.reason}`
          : `malformed arguments for ${name}: ${refusal.reason}`
    return `- call ${refusal.id || '(no id)'} — ${headline}\n  Arguments received: ${previewRaw(refusal.argumentsRaw)}`
  })
  return (
    `${TOOL_CALL_REFUSAL_CORRECTION_HEAD}\n${items.join('\n')}\n` +
    `None of these calls ran, so nothing happened. Re-issue each one with a tool name from your tool list, a call id of its own, and arguments that match that tool's input schema exactly (required parameters present, correct types, no extra fields on strict tools).`
  )
}

export function isToolCallRefusalCorrectionText(text: string): boolean {
  return text.startsWith(TOOL_CALL_REFUSAL_CORRECTION_HEAD)
}

/** Every refusal the transports attached across a turn's settled messages. */
export function collectRefusedToolCalls(messages: readonly AssistantMessage[]): RefusedToolCall[] {
  const out: RefusedToolCall[] = []
  for (const message of messages) {
    if (message.refusedToolCalls) out.push(...message.refusedToolCalls)
  }
  return out
}
