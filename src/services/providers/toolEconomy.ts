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
  /** A lane's own extra deferral rule, judged when a tool first enters the
   *  frozen array and never again (the Anthropic lane defers an LSP tool
   *  whose server is still initializing; the mark then holds for the
   *  conversation's life). */
  alsoDefer?: (tool: Tool) => boolean
}

/**
 * THE FREEZE: the tools array is part of the prefix every thinking block is
 * bound to, so for a conversation's life it never grows, shrinks or
 * reorders on a request's own initiative — not for a ToolSearch admission,
 * a threshold crossed because an MCP server landed, a server no longer
 * pending, or a permission-mode change. The deferral decision a
 * conversation made at its first request holds for every later one (the
 * latch, keyed by the owner, the conversation's first row and the model —
 * never the mode); the roster carries EVERY tool from the first request —
 * the deferrable ones under the API's own deferred loading (the block form
 * marks them `defer_loading`; the tool_reference a ToolSearch result
 * carries expands server-side against the definition already on the wire),
 * the rest in full — so an admission adds NOTHING. The deferral mark is
 * part of a definition on the wire: judged once when a tool enters the
 * array and re-sent as first sent (a toggle that shrinks the pool, a server
 * finishing its start-up, moves nothing). A wire that cannot defer
 * lists every tool in full from the first request. A tool that joins after
 * the latch is appended at the END, deferred, when the latch defers and the
 * tool is deferrable (an unreferenced deferred tool is not part of the
 * prefix — the API's own contract); any other joiner is HELD out until a
 * compaction or /clear gives the conversation a new first row. A tool the
 * mode forbids stays listed and refuses at call time through the
 * permission engine.
 */
interface RosterLatch {
  enabled: boolean
  /** The tool names the array carries, in the order first sent (a joiner
   *  appended at the end stays at its position for good). */
  names: string[]
  /** The tools themselves: a tool the pool later drops (a mode's filter, a
   *  toggle, a project file gone) still rides the frozen array from here —
   *  its call refuses at the permission engine; the array never shrinks. */
  tools: Tool[]
  /** The deferral marks as first sent. The mark is part of a tool's
   *  definition on the wire, so a live re-read may never move it: a tool
   *  deferred at the first request stays `defer_loading` for the
   *  conversation's life — a toggle shrinking the pool, or a server
   *  finishing its start-up, changes nothing already sent. */
  deferred: Set<string>
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

function rosterLatchKey(latchKey: string, messages: readonly Message[], model: string): string {
  return `${latchKey}|${firstConversationRow(messages)}|${model}`
}

/** Test seam: the latch a conversation holds. */
export function toolRosterLatchFor(
  latchKey: string,
  messages: readonly Message[],
  model: string,
): RosterLatch | undefined {
  return rosterLatches.get(rosterLatchKey(latchKey, messages, model))
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
  const latchKey = input.latchKey === undefined ? null : rosterLatchKey(input.latchKey, messages, model)
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
    // Deferral rides the API's own deferred loading — the block form. A wire
    // that cannot defer lists every tool in full from the first request; an
    // admission may never grow its tools array.
    if (enabled && wire.form !== 'block') enabled = false
  }

  // A tool's deferral is judged ONCE, when it enters the frozen array (the
  // first request, or a later join): isDeferredTool's answer plus the
  // lane's own rule. Mode-independent: a tool the mode forbids stays listed
  // and refuses at call time through the permission engine.
  const defers = (t: Tool): boolean => isDeferredTool(t) || input.alsoDefer?.(t) === true

  // The marks: a latched conversation re-sends the marks it first sent; a
  // fresh one judges its pool once.
  const deferredNames = new Set<string>()
  if (latched !== undefined) {
    for (const name of latched.deferred) deferredNames.add(name)
  } else if (enabled) {
    for (const t of tools) {
      if (defers(t)) deferredNames.add(t.name)
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
    rosterLatches.set(latchKey, { enabled, names: tools.map(t => t.name), tools: [...tools], deferred: new Set(deferredNames) })
  }

  // The order the array was first sent in, then any joiner at the END —
  // never a reorder, never a shrink: a latched tool the pool no longer
  // carries still rides (its call refuses at the permission engine). A
  // joiner rides only when it is deferrable under a deferring latch (an
  // unreferenced deferred tool is not part of the prefix) and then joins
  // the latch itself — its position and its mark hold from there on; any
  // other joiner is held until the next compaction or /clear.
  const byName = new Map(tools.map(t => [t.name, t] as const))
  const ordered: Tool[] = []
  const held: string[] = []
  if (latched !== undefined) {
    const latchedNames = new Set(latched.names)
    for (const tool of tools) {
      if (latchedNames.has(tool.name)) continue
      if (latched.enabled && defers(tool)) {
        latched.names.push(tool.name)
        latched.tools.push(tool)
        latched.deferred.add(tool.name)
        deferredNames.add(tool.name)
        latchedNames.add(tool.name)
      } else {
        held.push(tool.name)
      }
    }
    for (const latchedTool of latched.tools) {
      ordered.push(byName.get(latchedTool.name) ?? latchedTool)
    }
    if (held.length > 0) {
      logForDebugging(
        `tool roster frozen: ${held.length} tool(s) joined after the first request and stay out until the next compaction or /clear (${held.join(', ')})`,
      )
    }
  } else {
    ordered.push(...tools)
  }

  const admittedNames = enabled ? extractDiscoveredToolNames(messages as Message[]) : new Set<string>()
  // THE ROSTER LAW: every tool rides every request — the deferrable ones
  // deferred (the wire marks them), the rest in full; ToolSearch itself only
  // while deferral is on. An admission changes nothing here.
  const roster: Tool[] = ordered.filter(tool => !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME) || enabled)

  // With the delta attachment on, persisted deferred_tools_delta attachments
  // carry the announcement instead — the per-request prepend busts cache
  // every time the pool changes.
  const announcement = enabled && !isDeferredToolsDeltaEnabled() ? deferredToolsAnnouncement(ordered, deferredNames) : null

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
