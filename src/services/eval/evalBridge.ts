// ============================================================================
//  services/eval/evalBridge — the host side of in-cell tool re-entry.
//
//  Every bridge request re-enters Mercury through the SAME transaction a
//  direct model tool call takes (runToolUse: kill-switch, THEMIS, schema,
//  hooks, the permission decision chain, execution, result mapping) under
//  the SAME owner — the identity floor holds inside cells, and the session
//  permission mode governs re-entered calls exactly as direct ones (ruled).
//  completion() rides routedCallModel — any signed-in family,
//  multi-auth by construction. Eval can never re-enter ITSELF (the one
//  structural recursion guard: the retained-kernel chain would deadlock).
// ============================================================================

import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import type { AssistantMessage, Message, NormalizedUserMessage, UserMessage } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { smallFastModelFor } from '../../utils/model/providerFrontier.js'
import { runToolUse } from '../tools/toolExecution.js'
import { routedCallModel } from '../providers/callModelRouter.js'
import { governorCeilings } from '../capacity/governor.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { EVAL_TOOL_NAME } from '../../tools/EvalTool/constants.js'
import { compileJsonSchema, formatSchemaIssues } from '../schema/jsonSchemaEngine.js'
import { extractJsonValue } from './jsonExtract.js'
import type { BridgeServer, CellBudgetHooks } from './kernelManager.js'
import type { BridgeRequestFrame } from './protocol.js'
import { logForDebugging } from '../../utils/debug.js'

const toolPayload = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()).default({}) })
const agentPayload = z.object({
  prompt: z.string().min(1),
  agentType: z.string().nullish(),
  label: z.string().nullish(),
  schema: z.unknown().nullish(),
  strict: z.boolean().default(true),
  worktree: z.boolean().default(false),
})
const completionPayload = z.object({
  prompt: z.string().min(1),
  system: z.string().nullish(),
  model: z.string().nullish(),
  tier: z.enum(['main', 'fast']).nullish(),
  schema: z.unknown().nullish(),
})

export interface EvalBridgeDeps {
  context: ToolUseContext
  canUseTool: CanUseToolFn
  /** Aborts every nested call when the CELL settles (budget kill, abort,
   *  normal end) — dangling bridge work must die with its cell. */
  cellAbort: AbortController
  /** Nested transcript events (the cell card renders them like agent
   *  progress). */
  onNested?: (message: AssistantMessage | NormalizedUserMessage) => void
}

interface BridgeAnswer {
  ok: boolean
  value?: unknown
  error?: string
}

/** One tool_result extraction: the first tool_result block addressed to the
 *  given id, flattened to text (image blocks become a bounded note — binary
 *  never crosses into the kernel). */
function extractToolResult(
  message: UserMessage,
  toolUseId: string,
): { text: string; isError: boolean } | null {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
    if (b.type !== 'tool_result' || b.tool_use_id !== toolUseId) continue
    let text: string
    if (typeof b.content === 'string') text = b.content
    else if (Array.isArray(b.content)) {
      text = b.content
        .map(part => {
          const p = part as { type?: string; text?: string }
          if (p.type === 'text' && typeof p.text === 'string') return p.text
          if (p.type === 'image') return '[image result — view it in the transcript; binary does not cross the bridge]'
          return ''
        })
        .filter(Boolean)
        .join('\n')
    } else text = ''
    return { text, isError: b.is_error === true }
  }
  return null
}

function toNormalizedUser(message: UserMessage): NormalizedUserMessage {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return {
    ...(message as object),
    message: { role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }] },
  } as NormalizedUserMessage
}

/**
 * Apply an optional JSON schema to a model reply — judged by THE one
 * validation engine (spec 03 C1; the same strictness the workflow's
 * structured-output path enforces, spec 01 C2's "per spec 03 §C").
 * Module-level and exported so the conformance prover pins eval ≡ workflow
 * verdicts on the same corpus through the REAL seam.
 */
export function applySchemaToReply(text: string, schema: unknown, strict: boolean): BridgeAnswer {
  if (schema === null || schema === undefined) return { ok: true, value: text }
  const compiled = compileJsonSchema(schema)
  if (!compiled.ok) {
    // The retired permissive-lite validator tolerated schemas the engine
    // refuses; the flip is typed and TEACHING, never silent. Non-strict
    // keeps its value-over-refusal contract: the reply rides through
    // unvalidated — exactly the observable the lite validator produced.
    if (strict) {
      return { ok: false, error: `the requested schema was refused by the validation engine — ${compiled.error}` }
    }
    const tolerated = extractJsonValue(text)
    return { ok: true, value: tolerated.ok ? tolerated.value : text }
  }
  const parsed = extractJsonValue(text)
  if (!parsed.ok) {
    return strict
      ? { ok: false, error: `schema requested but ${parsed.error}` }
      : { ok: true, value: text }
  }
  const issues = compiled.check(parsed.value)
  if (issues.length > 0) {
    const detail = formatSchemaIssues(issues.slice(0, 5))
    return strict
      ? { ok: false, error: `the reply failed schema validation — ${detail}` }
      : { ok: true, value: parsed.value }
  }
  return { ok: true, value: parsed.value }
}

/** Refuse a strict schema request BEFORE spending the dispatch: a schema
 *  the engine refuses cannot validate any reply, and the teaching error is
 *  worth more than a wasted agent run or model call. */
function refuseUncompilableSchema(schema: unknown, strict: boolean): BridgeAnswer | null {
  if (schema === null || schema === undefined || !strict) return null
  const compiled = compileJsonSchema(schema)
  if (compiled.ok) return null
  return { ok: false, error: `the requested schema was refused by the validation engine — ${compiled.error}` }
}

export function makeEvalBridgeServer(deps: EvalBridgeDeps): BridgeServer {
  const { context, canUseTool, cellAbort } = deps

  const nestedContext: ToolUseContext = {
    ...context,
    abortController: cellAbort,
  }

  /** The permission callback with the wall-ceiling pause around every
   *  decision: the decision path includes the interactive ask, and an
   *  operator-paced wait must never burn the cell's wall budget. */
  const makeWrappedCanUse = (budget: CellBudgetHooks): CanUseToolFn =>
    async (tool, input, ctx, message, id, force) => {
      budget.askBegin()
      try {
        return await canUseTool(tool, input, ctx, message, id, force)
      } finally {
        budget.askEnd()
      }
    }

  /** Run one re-entered tool call through the full transaction. */
  async function reenterTool(name: string, input: Record<string, unknown>, budget: CellBudgetHooks): Promise<BridgeAnswer> {
    if (toolMatchesName({ name: EVAL_TOOL_NAME }, name)) {
      return { ok: false, error: 'Eval cannot re-enter itself — run the code in this cell instead' }
    }
    const toolUseId = `evalb_${randomUUID()}`
    const block = { type: 'tool_use' as const, id: toolUseId, name, input }
    const assistant = createAssistantMessage({ content: [block as never], isVirtual: true })
    deps.onNested?.(assistant)
    let result: { text: string; isError: boolean } | null = null
    for await (const update of runToolUse(block as never, assistant, makeWrappedCanUse(budget), nestedContext)) {
      const message = (update as { message?: Message }).message
      if (!message || message.type !== 'user') continue
      const extracted = extractToolResult(message as UserMessage, toolUseId)
      if (extracted) {
        result = extracted
        deps.onNested?.(toNormalizedUser(message as UserMessage))
      }
    }
    if (!result) return { ok: false, error: `the ${name} call produced no result` }
    if (result.isError) return { ok: false, error: result.text || `the ${name} call failed` }
    return { ok: true, value: result.text }
  }

  return async function serve(frame: BridgeRequestFrame, budget: CellBudgetHooks): Promise<BridgeAnswer> {
    try {
      switch (frame.kind) {
        case 'width': {
          return { ok: true, value: governorCeilings().delegationLanes }
        }
        case 'tool': {
          const parsed = toolPayload.safeParse(frame.payload)
          if (!parsed.success) return { ok: false, error: `bad tool payload: ${parsed.error.message}` }
          return await reenterTool(parsed.data.name, parsed.data.input, budget)
        }
        case 'agent': {
          const parsed = agentPayload.safeParse(frame.payload)
          if (!parsed.success) return { ok: false, error: `bad agent payload: ${parsed.error.message}` }
          const p = parsed.data
          const refusedSchema = refuseUncompilableSchema(p.schema, p.strict)
          if (refusedSchema) return refusedSchema
          let prompt = p.prompt
          if (p.schema !== null && p.schema !== undefined) {
            prompt += `\n\nYour FINAL message must be exactly one JSON value matching this JSON Schema — no prose around it:\n${JSON.stringify(p.schema)}`
          }
          const input: Record<string, unknown> = {
            description: (p.label ?? p.prompt.slice(0, 40)).slice(0, 60),
            prompt,
            ...(p.agentType ? { subagent_type: p.agentType } : {}),
            ...(p.worktree ? { isolation: 'worktree' } : {}),
          }
          const answer = await reenterTool(AGENT_TOOL_NAME, input, budget)
          if (!answer.ok) return answer
          return applySchemaToReply(String(answer.value ?? ''), p.schema, p.strict)
        }
        case 'completion': {
          const parsed = completionPayload.safeParse(frame.payload)
          if (!parsed.success) return { ok: false, error: `bad completion payload: ${parsed.error.message}` }
          const p = parsed.data
          const refusedSchema = refuseUncompilableSchema(p.schema, /*strict*/ true)
          if (refusedSchema) return refusedSchema
          // tier 'fast' rides the SESSION FAMILY's small-fast tier (trust-
          // combo census): the family's recorded fact where one
          // exists, else the session's own model — the dispatch below routes
          // by id, so the tier always rides the wire the session's account
          // already serves.
          const model =
            p.model ??
            (p.tier === 'fast'
              ? smallFastModelFor(context.options.mainLoopModel)
              : context.options.mainLoopModel)
          let prompt = p.prompt
          if (p.schema !== null && p.schema !== undefined) {
            prompt += `\n\nAnswer with exactly one JSON value matching this JSON Schema — no prose around it:\n${JSON.stringify(p.schema)}`
          }
          const text = await oneShotCompletion({
            model,
            prompt,
            system: p.system ?? undefined,
            signal: cellAbort.signal,
          })
          return applySchemaToReply(text, p.schema, /*strict*/ true)
        }
      }
    } catch (error) {
      logForDebugging(`eval bridge ${frame.kind} failed: ${String(error)}`)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** A stateless, tool-free model call over the ONE routing seam — any
 *  provider family a signed-in seat serves. */
export async function oneShotCompletion(args: {
  model: string
  prompt: string
  system?: string
  signal: AbortSignal
}): Promise<string> {
  const messages: Message[] = [createUserMessage({ content: args.prompt })]
  const stream = routedCallModel({
    messages,
    systemPrompt: asSystemPrompt(args.system ? [args.system] : []),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: args.signal,
    options: {
      model: args.model,
      querySource: 'eval_completion',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      async getToolPermissionContext() {
        const { getEmptyToolPermissionContext } = await import('../../Tool.js')
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  let final: string | null = null
  let apiError: string | null = null
  for await (const event of stream) {
    const e = event as {
      type?: string
      isApiErrorMessage?: boolean
      message?: { content?: unknown }
    }
    if (e.type === 'assistant' && e.message) {
      const content = e.message.content
      let text: string | null = null
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content
          .map(b => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
          .join('')
      }
      // A provider refusal (account absent, quota, transport) arrives as an
      // API-ERROR assistant message — that is a FAILURE of the completion,
      // never its answer.
      if (e.isApiErrorMessage) apiError = text ?? 'provider error'
      else final = text
    }
  }
  if (apiError !== null && (final === null || final.trim() === '')) {
    throw new Error(apiError.trim() || 'the provider refused the completion')
  }
  if (final === null || final.trim() === '') {
    throw new Error('the completion returned no text (is a provider signed in for this model?)')
  }
  return final.trim()
}
