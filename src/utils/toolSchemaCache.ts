import type { ApiTool } from '../types/wire.js'
import type { Tools } from '../Tool.js'

const toolSchemaCache = new Map<string, ApiTool>()

export function getToolSchemaCache(): Map<string, ApiTool> {
  return toolSchemaCache
}

export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}

const conversationSchemas = new Map<string, Map<string, string>>()

export function requestToolSchemaChange(_scope: string, _tools: Tools, _reason: string): void {
  clearToolSchemaCache()
}

export function getConversationToolSchemas(key: string): Map<string, string> {
  let schemas = conversationSchemas.get(key)
  if (schemas === undefined) {
    schemas = new Map()
    conversationSchemas.set(key, schemas)
  }
  return schemas
}

export function restoreConversationToolSchema(key: string, name: string, definition: string): void {
  getConversationToolSchemas(key).set(name, definition)
}

export function resetConversationToolSchemas(key: string): void {
  conversationSchemas.get(key)?.clear()
}

export function clearConversationToolSchemas(prefix?: string): void {
  if (prefix === undefined) {
    conversationSchemas.clear()
    return
  }
  for (const key of conversationSchemas.keys()) if (key.startsWith(prefix + '|')) conversationSchemas.delete(key)
}
