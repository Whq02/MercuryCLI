import type { ApiTool } from '../types/wire.js'


const toolSchemaCache = new Map<string, ApiTool>()

export function getToolSchemaCache(): Map<string, ApiTool> {
  return toolSchemaCache
}

export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}

const conversationSchemas = new Map<string, Map<string, string>>()

export function getConversationToolSchemas(key: string): Map<string, string> {
  let schemas = conversationSchemas.get(key)
  if (schemas === undefined) {
    schemas = new Map()
    conversationSchemas.set(key, schemas)
  }
  return schemas
}

export function clearConversationToolSchemas(prefix?: string): void {
  if (prefix === undefined) conversationSchemas.clear()
  else for (const key of conversationSchemas.keys()) if (key.startsWith(prefix + '|')) conversationSchemas.delete(key)
}
