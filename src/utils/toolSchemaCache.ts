import type { ApiTool } from '../types/wire.js'


const toolSchemaCache = new Map<string, ApiTool>()

export function getToolSchemaCache(): Map<string, ApiTool> {
  return toolSchemaCache
}

export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}
