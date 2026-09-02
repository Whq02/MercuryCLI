


import { createHash } from 'crypto'
import type { Tool } from '../../Tool.js'
import { mcpToolAllowed, type McpToolAnnotations } from './toolPolicy.js'

function toolFingerprint(tool: {
  name?: string
  annotations?: McpToolAnnotations
}): string {
  const a = tool.annotations
  const ro = a && typeof a === 'object' && a.readOnlyHint === true ? '1' : '0'
  const de =
    a && typeof a === 'object' && a.destructiveHint === true ? '1' : '0'
  const ow = a && typeof a === 'object' && a.openWorldHint === true ? '1' : '0'
  return `${tool.name ?? ''}\x00${ro}${de}${ow}`
}

export function toolsetHash(
  tools: ReadonlyArray<{ name?: string; annotations?: McpToolAnnotations }>,
): string {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  try {
    const parts = tools.map(toolFingerprint).sort()
    return createHash('sha256').update(parts.join('\x01')).digest('hex')
  } catch {
    return ''
  }
}

export function needsReadmission(
  admittedHash: string | undefined,
  liveHash: string | undefined,
): boolean {
  const admitted = typeof admittedHash === 'string' ? admittedHash : ''
  const live = typeof liveHash === 'string' ? liveHash : ''
  if (!admitted || !live) return true
  return admitted !== live
}

export function readmitTools(serverName: string, tools: Tool[]): Tool[] {
  if (!Array.isArray(tools)) return []
  return tools.filter(tool => {
    try {
      const toolName = tool.mcpInfo?.toolName ?? tool.name ?? ''
      const annotations = readToolAnnotations(tool)
      return mcpToolAllowed(serverName, toolName, annotations)
    } catch {
      return true
    }
  })
}

function readToolAnnotations(tool: Tool): McpToolAnnotations {
  const read = (fn: unknown): boolean => {
    if (typeof fn !== 'function') return false
    try {
      return (fn as () => boolean)() === true
    } catch {
      return false
    }
  }
  return {
    readOnlyHint: read(tool.isReadOnly),
    destructiveHint: read(tool.isDestructive),
    openWorldHint: read((tool as { isOpenWorld?: () => boolean }).isOpenWorld),
  }
}
