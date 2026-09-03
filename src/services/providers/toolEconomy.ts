// ============================================================================
//  providers/toolEconomy — the tool-payload plan: ONE owner for what a
//  request carries in tool schemas, on EVERY provider route.
//
//  Deferral is a Mercury-side context-assembly decision, not a provider-wire
//  feature. On any route, deferrable tools are omitted from the request's
//  tools term and announced name-only; a ToolSearch call admits matched
//  tools, and their full schemas ride every later request of the session.
//  The wire form — the beta block form or the client-side text form — is a
//  per-route capability (./deferralWire.ts), never a per-call guess.
//
//  THE ROSTER LAW (identical on every route): with deferral on, the request
//  carries the non-deferred tools, the ToolSearch tool itself, and exactly
//  the deferred tools this conversation has ADMITTED; with deferral off, it
//  carries everything except ToolSearch. Admission is derived from the
//  transcript (tool_reference records inside ToolSearch results, plus the
//  set a compaction boundary snapshotted), so it is additive and monotone
//  within a session by construction: the payload changes exactly once per
//  distinct admission and never shrinks.
//
//  THE ANNOUNCEMENT: the name-only list of every deferred tool, the same
//  bytes on every route (the Anthropic lane's own spelling, unchanged).
//
//  THE TEXT FORM's admission rendering: a tool_reference record inside a
//  ToolSearch result is the neutral transcript shape; a wire that cannot
//  expand it reads it as text naming the admitted tools, whose schemas that
//  same request carries in its tools term.
//
//  The Anthropic lane consumes the plan byte-for-byte as it always assembled
//  its roster (the first-party route is the control); every other lane
//  consumes the same plan instead of inlining the whole catalogue.
// ============================================================================
import { toolMatchesName, type Tool, type ToolPermissionContext, type Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { formatDeferredToolLine, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolReferenceBlock,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { deferralWireFormFor, type DeferralWireForm, type DeferralWireVerdict } from './deferralWire.js'

export interface ToolPayloadPlanInput {
  model: string
  tools: Tools
  messages: readonly Message[]
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  hasPendingMcpServers?: boolean
  /** The debug-line source label ('query', 'compact', …). */
  source?: string
  /** The conversation whose roster this plan freezes (the owner: the main
   *  thread or an agent id). Absent ⇒ no latch (a one-off caller). */
  latchKey?: string
}

/**
 * THE FREEZE: the deferral decision a conversation made at its first
 * request holds for every later one. The tools array is part of the prefix
 * every thinking block is bound to, so the roster may not move on a
 * request's own initiative — a threshold crossed because an MCP server
 * landed, a server no longer pending — only on a lawful change: a
 * compaction or /clear gives the conversation a new first row (a new key), a
 * model or mode change keys a new latch (the operator's action; the drop
 * receipt names it), an operator's in-session change clears the
 * conversation's latch through the lawful-change seam
 * (./lawfulPrefixChange.ts), and every conversation in a process — each
 * chat, fork and agent — keys its own by its first row. A tool that joins
 * after the latch is deferrable under
 * a deferring latch (it rides the announcement row, never the tools array)
 * and is HELD out of the roster under a non-deferring one until the next
 * lawful boundary.
 */
interface RosterLatch {
  enabled: boolean
  /** The tool names the roster could carry when the latch was taken. */
  names: ReadonlySet<string>
}
const rosterLatches = new Map<string, RosterLatch>()

/** Clear the latches: with an owner, that conversation's only (the
 *  lawful-change seam — services/providers/lawfulPrefixChange.ts); without,
 *  every roster in the process re-decides (a test seam). */
export function clearToolRosterLatches(owner?: string): void {
  if (owner === undefined) {
    rosterLatches.clear()
    return
  }
  for (const key of [...rosterLatches.keys()]) {
    if (key.startsWith(`${owner}|`)) rosterLatches.delete(key)
  }
}

/** The conversation a history belongs to: its first user or assistant row
 *  (a compaction replaces it with the summary — a new key at the lawful
 *  boundary; every chat, fork and agent in a process has its own). */
function firstConversationRow(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.type === 'user' || message.type === 'assistant') return message.uuid
  }
  return 'empty'
}

function rosterLatchKey(latchKey: string, messages: readonly Message[], model: string, mode: string): string {
  return `${latchKey}|${firstConversationRow(messages)}|${model}|${mode}`
}

/** Test seam: the latch a conversation holds. */
export function toolRosterLatchFor(
  latchKey: string,
  messages: readonly Message[],
  model: string,
  mode: string,
): RosterLatch | undefined {
  return rosterLatches.get(rosterLatchKey(latchKey, messages, model, mode))
}

export interface ToolPayloadPlan {
  /** Deferral is on for this request (the mode ladder, availability, and
   *  something to search — deferred tools or a still-connecting server). */
  enabled: boolean
  wireForm: DeferralWireForm
  wireWhy: DeferralWireVerdict['why']
  /** The tools whose schemas ride this request, in pool order. */
  roster: Tools
  /** Every deferrable tool in the pool (empty when deferral is off). */
  deferredNames: ReadonlySet<string>
  /** The deferred tools this conversation has admitted (⊆ deferredNames ∪ departed). */
  admittedNames: ReadonlySet<string>
  /** The name-only announcement block, or null when nothing rides (deferral
   *  off, the delta attachment carrying it instead, or nothing deferred). */
  announcement: string | null
  /** A deferred tool the model may call by name but whose schema this
   *  request did not carry — the typed refusals name the admission road. */
  isDeferredUnadmitted(name: string): boolean
}

const ANNOUNCEMENT_OPEN = '<available-deferred-tools>'
const ANNOUNCEMENT_CLOSE = '</available-deferred-tools>'

/** The announcement text: sorted name lines inside the tag pair — the exact
 *  bytes the Anthropic lane has always prepended. */
export function deferredToolsAnnouncement(tools: Tools, deferredNames: ReadonlySet<string>): string | null {
  const list = tools
    .filter(t => deferredNames.has(t.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')
  if (!list) return null
  return `${ANNOUNCEMENT_OPEN}\n${list}\n${ANNOUNCEMENT_CLOSE}`
}

export async function planToolPayload(input: ToolPayloadPlanInput): Promise<ToolPayloadPlan> {
  const { model, tools, messages } = input
  const wire = deferralWireFormFor(model)
  const rosterPermissionMode = (await input.getToolPermissionContext()).mode
  const latchKey =
    input.latchKey === undefined ? null : rosterLatchKey(input.latchKey, messages, model, rosterPermissionMode)
  const latched = latchKey === null ? undefined : rosterLatches.get(latchKey)

  let enabled: boolean
  if (latched !== undefined) {
    enabled = latched.enabled
  } else {
    enabled = await isToolSearchEnabled(
      model,
      tools,
      input.getToolPermissionContext,
      input.agents,
      input.source,
      wire.form,
    )
  }

  // isDeferredTool costs two feature lookups per call — resolve the set once.
  // The live permission mode rides along: a mode-exempt tool (the Apollo
  // closing-review tool in apollo mode) is force-loaded, so the roster tells
  // the truth — the tool is present exactly when it is callable.
  const deferredNames = new Set<string>()
  if (enabled) {
    for (const t of tools) {
      if (isDeferredTool(t, rosterPermissionMode)) deferredNames.add(t.name)
    }
  }

  // No deferred tools AND no servers still connecting ⇒ nothing to search.
  // While servers are pending, ToolSearch stays so the model can discover
  // their tools once they land — on every route. A latched decision holds
  // as taken: the roster never moves on a request's own initiative.
  if (latched === undefined && enabled && deferredNames.size === 0 && !input.hasPendingMcpServers) {
    enabled = false
  }

  if (latchKey !== null && latched === undefined) {
    rosterLatches.set(latchKey, { enabled, names: new Set(tools.map(t => t.name)) })
  }
  // Under a non-deferring latch a tool that joined since the latch is held
  // out of the roster (the tools array is frozen); the deferring case needs
  // no hold — a joiner is deferrable and rides the announcement row.
  const held = new Set<string>()
  if (latched !== undefined && !latched.enabled) {
    for (const t of tools) {
      if (!latched.names.has(t.name)) held.add(t.name)
    }
    if (held.size > 0) {
      logForDebugging(
        `tool roster frozen: ${held.size} tool(s) joined after the first request and stay out until the next compaction or /clear (${[...held].join(', ')})`,
      )
    }
  }

  const admittedNames = enabled ? extractDiscoveredToolNames(messages as Message[]) : new Set<string>()
  const roster: Tool[] = enabled
    ? tools.filter(tool => {
        if (!deferredNames.has(tool.name)) return true
        if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
        return admittedNames.has(tool.name)
      })
    : tools.filter(t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME) && !held.has(t.name))

  // With the delta attachment on, persisted deferred_tools_delta attachments
  // carry the announcement instead — the per-request prepend busts cache
  // every time the pool changes.
  const announcement = enabled && !isDeferredToolsDeltaEnabled() ? deferredToolsAnnouncement(tools, deferredNames) : null

  return {
    enabled,
    wireForm: wire.form,
    wireWhy: wire.why,
    roster,
    deferredNames,
    admittedNames,
    announcement,
    isDeferredUnadmitted: (name: string) => enabled && deferredNames.has(name) && !admittedNames.has(name),
  }
}

/** The announcement as its own meta user message (the Anthropic wire's
 *  shape — the API folds consecutive user turns). */
export function announcementMessage(plan: ToolPayloadPlan): UserMessage | null {
  if (plan.announcement === null) return null
  return createUserMessage({ content: plan.announcement, isMeta: true })
}

/**
 * The announcement folded into the FIRST user turn as a leading text block
 * (the chat-completions and Responses wires' shape: some chat templates
 * refuse two user rows in a row, and the announcement must never cost a
 * request its alternation). Returns the same array when nothing rides.
 */
export function foldAnnouncementIntoFirstUserTurn<M extends Message>(messages: M[], plan: ToolPayloadPlan): M[] {
  if (plan.announcement === null) return messages
  const index = messages.findIndex(m => m.type === 'user')
  if (index < 0) return messages
  const first = messages[index] as unknown as UserMessage
  const content = first.message.content
  const folded: UserMessage = {
    ...first,
    message: {
      ...first.message,
      content:
        typeof content === 'string'
          ? [
              { type: 'text' as const, text: plan.announcement },
              { type: 'text' as const, text: content },
            ]
          : [{ type: 'text' as const, text: plan.announcement }, ...content],
    },
  } as UserMessage
  const out = [...messages]
  out[index] = folded as unknown as M
  return out
}

/** The text a wire that cannot expand a tool_reference reads instead. */
export function admissionRecordText(names: readonly string[]): string {
  const list = names.map(n => `- ${n}`).join('\n')
  return `Tools admitted to this session:\n${list}\nTheir full schemas are in your tool list from this request on — call them like any other tool.`
}

/**
 * The text form of every admission record: inside each ToolSearch result,
 * the tool_reference items become one text block naming the admitted
 * tools. Other blocks are untouched; messages without a record return by
 * reference. Applied only on a text-form wire — the block form keeps the
 * records for the server to expand.
 */
export function renderAdmissionRecordsAsText<M extends Message | UserMessage | AssistantMessage>(messages: M[]): M[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as UserMessage).message.content
    if (!Array.isArray(content)) return message
    const hasRecord = content.some(
      block =>
        block.type === 'tool_result' &&
        Array.isArray((block as { content?: unknown }).content) &&
        ((block as { content: unknown[] }).content as unknown[]).some(isToolReferenceBlock),
    )
    if (!hasRecord) return message
    const rendered = content.map(block => {
      if (block.type !== 'tool_result') return block
      const inner = (block as { content?: unknown }).content
      if (!Array.isArray(inner)) return block
      const names: string[] = []
      const rest: unknown[] = []
      for (const item of inner as unknown[]) {
        if (isToolReferenceBlock(item)) {
          const name = (item as { tool_name?: unknown }).tool_name
          if (typeof name === 'string') names.push(name)
        } else {
          rest.push(item)
        }
      }
      if (names.length === 0) return block
      return {
        ...(block as object),
        content: [{ type: 'text' as const, text: admissionRecordText(names) }, ...rest],
      }
    })
    return {
      ...message,
      message: { ...(message as UserMessage).message, content: rendered },
    } as M
  })
}
