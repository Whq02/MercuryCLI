import type { ApiTool } from '../types/wire.js'
import type { Tool, Tools } from '../Tool.js'


const toolSchemaCache = new Map<string, ApiTool>()

export function getToolSchemaCache(): Map<string, ApiTool> {
  return toolSchemaCache
}

export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}

const conversationSchemas = new Map<string, Map<string, string>>()

type RequestedSchemaChange = {
  tool: Tool
  previous: string
  scope: string
  reason: string
}

const requestedSchemaChanges = new Map<string, Map<string, RequestedSchemaChange>>()

export function requestToolSchemaChange(scope: string, tools: Tools, reason: string): void {
  for (const [key, schemas] of conversationSchemas) {
    if (!key.startsWith(scope + '|')) continue
    for (const tool of tools) {
      const previous = schemas.get(tool.name)
      if (previous === undefined) continue
      let changes = requestedSchemaChanges.get(key)
      if (changes === undefined) {
        changes = new Map()
        requestedSchemaChanges.set(key, changes)
      }
      changes.set(tool.name, { tool, previous, scope, reason })
    }
  }
  clearToolSchemaCache()
}

export function requestedToolSchemaChange(key: string, tool: Tool): RequestedSchemaChange | undefined {
  const change = requestedSchemaChanges.get(key)?.get(tool.name)
  return change?.tool === tool ? change : undefined
}

export function settleToolSchemaChange(key: string, change: RequestedSchemaChange): boolean {
  const changes = requestedSchemaChanges.get(key)
  if (changes?.get(change.tool.name) !== change) return false
  changes.delete(change.tool.name)
  if (changes.size === 0) requestedSchemaChanges.delete(key)
  return true
}

export function getConversationToolSchemas(key: string): Map<string, string> {
  let schemas = conversationSchemas.get(key)
  if (schemas === undefined) {
    schemas = new Map()
    conversationSchemas.set(key, schemas)
  }
  return schemas
}

export function clearConversationToolSchemas(prefix?: string): void {
  for (const store of [conversationSchemas, requestedSchemaChanges]) {
    if (prefix === undefined) store.clear()
    else for (const key of store.keys()) if (key.startsWith(prefix + '|')) store.delete(key)
  }
}
