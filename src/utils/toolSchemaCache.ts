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

const restoredSchemas = new Map<string, Set<string>>()
const movedRestoredSchemas = new Map<string, Set<string>>()

export function restoreConversationToolSchema(key: string, name: string, definition: string): void {
  getConversationToolSchemas(key).set(name, definition)
  let names = restoredSchemas.get(key)
  if (names === undefined) {
    names = new Set()
    restoredSchemas.set(key, names)
  }
  names.add(name)
}

export function restoredToolSchemaPending(key: string, name: string): boolean {
  return restoredSchemas.get(key)?.has(name) === true
}

export function settleRestoredToolSchema(key: string, name: string, moved: boolean): string[] {
  restoredSchemas.get(key)?.delete(name)
  if (!moved) return []
  let names = movedRestoredSchemas.get(key)
  if (names === undefined) {
    names = new Set()
    movedRestoredSchemas.set(key, names)
  }
  names.add(name)
  return [...names]
}

export function resetConversationToolSchemas(key: string): void {
  conversationSchemas.get(key)?.clear()
  restoredSchemas.delete(key)
  movedRestoredSchemas.delete(key)
}

export function clearConversationToolSchemas(prefix?: string): void {
  for (const store of [conversationSchemas, requestedSchemaChanges, restoredSchemas, movedRestoredSchemas]) {
    if (prefix === undefined) store.clear()
    else for (const key of store.keys()) if (key.startsWith(prefix + '|')) store.delete(key)
  }
}
