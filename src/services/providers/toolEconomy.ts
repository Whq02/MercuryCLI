import { toolMatchesName, type Tool, type ToolPermissionContext, type Tools } from '../../Tool.js'
import { expandLspFamily } from '../lsp/toolFamily.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { isDeferredTool, loadsInFullFor, TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/prompt.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { clearConversationToolSchemas, resetConversationToolSchemas, restoreConversationToolSchema } from '../../utils/toolSchemaCache.js'
import {
  extractDiscoveredToolNames,
  isToolReferenceBlock,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { deferralSearchIsServerSide, deferralWireFormFor, supportsToolDeferral, type DeferralWireForm, type DeferralWireVerdict } from './deferralWire.js'

interface ToolPayloadPlanInput {
  model: string
  tools: Tools
  messages: readonly Message[]
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  hasPendingMcpServers?: boolean
  source?: string
  latchKey?: string
  alsoDefer?: (tool: Tool) => boolean
}

interface RosterLatch {
  enabled: boolean
  names: string[]
  tools: Tool[]
  deferred: Set<string>
}
const rosterLatches = new Map<string, RosterLatch>()
const heldAtLastPlan = new Map<string, string[]>()

export function clearToolRosterLatches(owner?: string): void {
  clearConversationToolSchemas(owner)
  if (owner === undefined) {
    rosterLatches.clear()
    heldAtLastPlan.clear()
    return
  }
  for (const key of [...rosterLatches.keys()]) {
    if (key.startsWith(`${owner}|`)) rosterLatches.delete(key)
  }
  for (const key of [...heldAtLastPlan.keys()]) {
    if (key.startsWith(`${owner}|`)) heldAtLastPlan.delete(key)
  }
}

export function heldToolsAtLastPlan(latchKey: string, messages: readonly Message[]): readonly string[] {
  return heldAtLastPlan.get(`${latchKey}|${firstConversationRow(messages)}`) ?? []
}


export interface RosterRestore {
  key: string
  enabled: boolean
  marks: Array<{ name: string; deferred: boolean; definition?: string }>
}
const armedRosterRestores = new Map<string, RosterRestore[]>()
let lastArmedRosterRestore: RosterRestore | null = null

export function armToolRosterRestore(restore: RosterRestore): void {
  const suffix = conversationSuffixOf(restore.key)
  const kept = (armedRosterRestores.get(suffix) ?? []).filter(entry => entry.key !== restore.key)
  kept.push(restore)
  armedRosterRestores.set(suffix, kept)
  lastArmedRosterRestore = restore
}

export function pendingToolRosterRestore(): RosterRestore | null {
  return lastArmedRosterRestore
}

export function clearToolRosterRestore(): void {
  armedRosterRestores.clear()
  lastArmedRosterRestore = null
}

function armedRestoreFor(latchKey: string): RosterRestore | null {
  const list = armedRosterRestores.get(conversationSuffixOf(latchKey))
  if (list === undefined || list.length === 0) return null
  return list.find(entry => entry.key === latchKey) ?? list[list.length - 1]!
}

function seedRosterLatchFromRestore(latchKey: string, restore: RosterRestore, tools: Tools): string[] {
  const byName = new Map((tools as ReadonlyArray<Tool>).map(t => [t.name, t] as const))
  const names: string[] = []
  const seededTools: Tool[] = []
  const deferred = new Set<string>()
  const missingBound: string[] = []
  const expanded = new Set<string>()
  for (const mark of restore.marks) {
    const family = expandLspFamily(mark.name)
    if (family.length > 1) {
      missingBound.push(mark.name)
      for (const name of family) {
        const successor = byName.get(name)
        if (!successor || names.includes(name)) continue
        names.push(name)
        expanded.add(name)
        seededTools.push(successor)
        if (restore.enabled && (name === 'LspRead' ? mark.deferred : true)) deferred.add(name)
      }
      continue
    }
    if (expanded.has(mark.name)) continue
    if (mark.definition !== undefined) restoreConversationToolSchema(latchKey, mark.name, mark.definition)
    const tool = byName.get(mark.name) ?? (mark.definition !== undefined ? { name: mark.name } as Tool : undefined)
    if (tool === undefined) {
      if (!mark.deferred) missingBound.push(mark.name)
      continue
    }
    names.push(mark.name)
    seededTools.push(tool)
    if (mark.deferred) deferred.add(mark.name)
  }
  rosterLatches.set(latchKey, { enabled: restore.enabled, names, tools: seededTools, deferred })
  return missingBound
}

function rosterCannotReplay(missing: readonly string[]): string | null {
  const retired = missing.filter(name => expandLspFamily(name).length <= 1)
  if (retired.length > 0) return `the recorded roster names ${retired.join(', ')}, which this build no longer offers and the record carries no definition for`
  return null
}

function referencedToolNamesOf(messages: readonly Message[]): Set<string> {
  const names = extractDiscoveredToolNames(messages as Message[])
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string') names.add(block.name)
    }
  }
  return names
}

function firstConversationRow(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.type === 'assistant') return message.uuid
    if (message.type === 'user' && message.isMeta !== true) return message.uuid
  }
  return 'empty'
}

export function conversationRosterKey(latchKey: string, messages: readonly Message[], model: string): string {
  return `${latchKey}|${firstConversationRow(messages)}|${model}`
}

function conversationSuffixOf(key: string): string {
  return key.split('|').slice(-2).join('|')
}

function rosterLatchKey(latchKey: string, messages: readonly Message[], model: string): string {
  return conversationRosterKey(latchKey, messages, model)
}

export function toolRosterLatchFor(
  latchKey: string,
  messages: readonly Message[],
  model: string,
): RosterLatch | undefined {
  return rosterLatches.get(rosterLatchKey(latchKey, messages, model))
}

export interface ToolPayloadPlan {
  enabled: boolean
  conversationKey?: string
  wireForm: DeferralWireForm
  wireWhy: DeferralWireVerdict['why']
  roster: Tools
  deferredNames: ReadonlySet<string>
  admittedNames: ReadonlySet<string>
  isDeferredUnadmitted(name: string): boolean
  isBound(name: string): boolean
  restoredMissingTools: readonly string[]
  admissionDeclarations: readonly AdmissionDeclaration[]
}

interface AdmissionDeclaration {
  toolUseId: string
  tools: Tools
}

export async function planToolPayload(input: ToolPayloadPlanInput): Promise<ToolPayloadPlan> {
  const { model, tools, messages } = input
  const wire = deferralWireFormFor(model)
  const latchKey = input.latchKey === undefined ? null : rosterLatchKey(input.latchKey, messages, model)
  let restoredMissingTools: string[] = []
  if (latchKey !== null && !rosterLatches.has(latchKey)) {
    const restore = armedRestoreFor(latchKey)
    if (restore !== null) {
      restoredMissingTools = seedRosterLatchFromRestore(latchKey, restore, tools)
      const moved = rosterCannotReplay(restoredMissingTools)
      if (moved !== null) {
        rosterLatches.delete(latchKey)
        resetConversationToolSchemas(latchKey)
        logForDebugging(`tool roster: ${moved} — the conversation's roster is decided afresh from the live pool at this request`)
      }
    }
  }
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
    if (enabled && !supportsToolDeferral(model, wire.form)) enabled = false
  }

  const defers = (t: Tool): boolean => (isDeferredTool(t) && !loadsInFullFor(t, model)) || input.alsoDefer?.(t) === true

  const deferredNames = new Set<string>()
  if (latched !== undefined) {
    for (const name of latched.deferred) deferredNames.add(name)
  } else if (enabled) {
    const carried = boundaryAdmittedNames(messages)
    for (const t of tools) {
      if (defers(t) && !carried.has(t.name)) deferredNames.add(t.name)
    }
  }

  if (latched === undefined && enabled && deferredNames.size === 0 && !input.hasPendingMcpServers) {
    enabled = false
  }

  if (latchKey !== null && latched === undefined) {
    rosterLatches.set(latchKey, { enabled, names: tools.map(t => t.name), tools: [...tools], deferred: new Set(deferredNames) })
  }

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
  if (input.latchKey !== undefined) heldAtLastPlan.set(`${input.latchKey}|${firstConversationRow(messages)}`, held)

  const serverSearch = deferralSearchIsServerSide(wire.form)
  const admittedNames = enabled && !serverSearch ? extractDiscoveredToolNames(messages as Message[]) : new Set<string>()
  let roster: Tool[] = ordered.filter(tool => !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME) || enabled)
  let admissionDeclarations: AdmissionDeclaration[] = []
  if (enabled && (wire.form === 'text' || wire.form === 'text-append')) {
    const available = new Map(roster.map(tool => [tool.name, tool]))
    const carried = boundaryAdmittedNames(messages)
    const rides = (name: string): boolean => {
      const tool = available.get(name)
      return tool !== undefined && (deferredNames.has(name) || (carried.has(name) && defers(tool)))
    }
    const tail = wire.form === 'text' ? [...admittedNames, ...carried] : [...carried]
    const appended = new Set<string>()
    roster = [
      ...roster.filter(tool => !rides(tool.name)),
      ...tail.flatMap(name => {
        if (!rides(name) || appended.has(name)) return []
        appended.add(name)
        return [available.get(name)!]
      }),
    ]
    if (wire.form === 'text-append') admissionDeclarations = admissionDeclarationsOf(messages, available, deferredNames, new Set(roster.map(tool => tool.name)))
  } else if (enabled && serverSearch) {
    roster = roster.filter(tool => !toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
  }

  let referenced: Set<string> | null = null
  return {
    enabled,
    ...(latchKey !== null ? { conversationKey: latchKey } : {}),
    wireForm: wire.form,
    wireWhy: wire.why,
    roster,
    deferredNames,
    admittedNames,
    isDeferredUnadmitted: (name: string) => enabled && !serverSearch && deferredNames.has(name) && !admittedNames.has(name),
    isBound: (name: string) => {
      if (!deferredNames.has(name)) return true
      referenced ??= referencedToolNamesOf(messages)
      return referenced.has(name)
    },
    restoredMissingTools,
    admissionDeclarations,
  }
}

export function toolsOnTheWire(plan: ToolPayloadPlan): Tool[] {
  return [...plan.roster, ...plan.admissionDeclarations.flatMap(declaration => declaration.tools)]
}

export async function planToolPayloadUnseeded(input: ToolPayloadPlanInput & { latchKey: string }): Promise<ToolPayloadPlan> {
  const { latchKey, ...unlatched } = input
  return planToolPayload(toolRosterLatchFor(latchKey, input.messages, input.model) === undefined ? unlatched : input)
}

function boundaryAdmittedNames(messages: readonly Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'system' || (message as { subtype?: string }).subtype !== 'compact_boundary') continue
    const carried = (message as { compactMetadata?: { preCompactDiscoveredTools?: unknown } }).compactMetadata?.preCompactDiscoveredTools
    if (!Array.isArray(carried)) continue
    for (const name of carried) {
      if (typeof name === 'string') names.add(name)
    }
  }
  return names
}

function admissionDeclarationsOf(
  messages: readonly Message[],
  available: ReadonlyMap<string, Tool>,
  deferredNames: ReadonlySet<string>,
  listed: ReadonlySet<string>,
): AdmissionDeclaration[] {
  const declared = new Set<string>()
  const out: AdmissionDeclaration[] = []
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const inner = (block as { content?: unknown }).content
      if (!Array.isArray(inner)) continue
      const tools: Tool[] = []
      for (const item of inner as unknown[]) {
        if (!isToolReferenceBlock(item)) continue
        const name = (item as { tool_name?: unknown }).tool_name
        if (typeof name !== 'string' || !deferredNames.has(name) || listed.has(name) || declared.has(name)) continue
        const tool = available.get(name)
        if (tool === undefined) continue
        declared.add(name)
        tools.push(tool)
      }
      if (tools.length > 0) out.push({ toolUseId: block.tool_use_id, tools })
    }
  }
  return out
}

export function admissionRecordText(names: readonly string[], form: DeferralWireForm = 'text'): string {
  const list = names.map(n => `- ${n}`).join('\n')
  if (form === 'text-append') {
    return `Tools admitted to this session:\n${list}\nTheir complete definitions follow this result — call them like any other tool.`
  }
  return `Tools admitted to this session:\n${list}\nTheir full schemas are in your tool list from this request on — call them like any other tool.`
}

export function renderAdmissionRecordsAsText<M extends Message | UserMessage | AssistantMessage>(messages: M[], form: DeferralWireForm = 'text'): M[] {
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
        content: [{ type: 'text' as const, text: admissionRecordText(names, form) }, ...rest],
      }
    })
    return {
      ...message,
      message: { ...(message as UserMessage).message, content: rendered },
    } as M
  })
}
