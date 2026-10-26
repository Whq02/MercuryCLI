import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { conversationRosterKey, toolRosterLatchFor } from '../../services/providers/toolEconomy.js'
import { rosterOwnerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { isDeferredToolFor } from '../../tools/ToolSearchTool/prompt.js'
import { toolToAPISchema } from '../api.js'
import { getConversationToolSchemas } from '../toolSchemaCache.js'
import type { Attachment } from './types.js'

export const TOOL_SCHEMA_DELTA_HEAD =
  'These tools take different input now than the definition in your tool list shows. Call each with the parameters below; the tool list keeps the earlier definition for the life of this conversation.'

function referencedNamesOf(messages: readonly Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const carried = (message as { compactMetadata?: { preCompactDiscoveredTools?: unknown } }).compactMetadata?.preCompactDiscoveredTools
      if (Array.isArray(carried)) for (const name of carried) if (typeof name === 'string') names.add(name)
      continue
    }
    if (message.type === 'assistant') {
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) if (block.type === 'tool_use' && typeof block.name === 'string') names.add(block.name)
      continue
    }
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; content?: unknown }>) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue
      for (const item of block.content as Array<{ type?: string; tool_name?: unknown }>) {
        if (item.type === 'tool_reference' && typeof item.tool_name === 'string') names.add(item.tool_name)
      }
    }
  }
  return names
}

function recordedDefinitions(messages: readonly Message[], key: string): Map<string, string> {
  const live = getConversationToolSchemas(key)
  if (live.size > 0) return live
  const recorded = new Map<string, string>()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== 'attachment' || message.attachment.type !== 'bound_prefix' || message.attachment.boundKey !== key) continue
    for (const mark of message.attachment.roster) {
      if (typeof mark.definition === 'string') recorded.set(mark.name, mark.definition)
    }
    break
  }
  return recorded
}

function announcedDigests(messages: readonly Message[]): Map<string, string> {
  const announced = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'attachment' || message.attachment.type !== 'tool_schema_delta') continue
    for (const entry of message.attachment.tools) announced.set(entry.name, entry.digest)
  }
  return announced
}

const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12)

function toolSchemaDeltaBody(changes: ReadonlyArray<{ name: string; inputSchema: unknown }>): string {
  return `${TOOL_SCHEMA_DELTA_HEAD}\n${changes.map(change => `${change.name}: ${JSON.stringify(change.inputSchema ?? null)}`).join('\n')}`
}

export async function getToolSchemaDeltaAttachment(toolUseContext: ToolUseContext, messages: readonly Message[]): Promise<Attachment[]> {
  const model = toolUseContext.options.engineModel
  const tools = toolUseContext.options.tools
  if (!model || tools.length === 0 || messages.length === 0) return []
  const owner = String(rosterOwnerFromToolUseContext(toolUseContext))
  const key = conversationRosterKey(owner, messages, model)
  const recorded = recordedDefinitions(messages, key)
  if (recorded.size === 0) return []
  const latch = toolRosterLatchFor(owner, messages, model)
  const deferred = (tool: Tool): boolean => (latch !== undefined ? latch.deferred.has(tool.name) : isDeferredToolFor(tool, model, undefined, messages))
  const referenced = referencedNamesOf(messages)
  const announced = announcedDigests(messages)
  const getToolPermissionContext = async () => toolUseContext.getAppState().toolPermissionContext
  const agents = toolUseContext.options.agentDefinitions?.activeAgents ?? []
  const changes: Array<{ name: string; inputSchema: unknown; digest: string }> = []
  for (const tool of tools) {
    const sent = recorded.get(tool.name)
    if (sent === undefined || typeof tool.prompt !== 'function') continue
    if (deferred(tool) && !referenced.has(tool.name)) continue
    let sentSchema: unknown
    try {
      sentSchema = (JSON.parse(sent) as { input_schema?: unknown }).input_schema
    } catch {
      continue
    }
    const live = await toolToAPISchema(tool, { getToolPermissionContext, tools, agents, model })
    const liveSchema = (live as { input_schema?: unknown }).input_schema
    const digest = digestOf(liveSchema)
    if (digest === digestOf(sentSchema) || announced.get(tool.name) === digest) continue
    changes.push({ name: tool.name, inputSchema: liveSchema, digest })
  }
  if (changes.length === 0) return []
  changes.sort((a, b) => a.name.localeCompare(b.name))
  return [{ type: 'tool_schema_delta', tools: changes.map(change => ({ name: change.name, digest: change.digest })), body: toolSchemaDeltaBody(changes) }]
}
