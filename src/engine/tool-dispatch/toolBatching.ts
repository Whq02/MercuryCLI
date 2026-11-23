import { realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type { Tool, ToolUseContext } from '../../tools/kit/tool.js'
import { findToolByName } from '../../tools/kit/tool.js'
import type { ToolUseBlock } from '../message-shapes/wire.js'
import { expandPath } from '../../platform/files/path.js'
import { foldHostCaseInsensitivePath } from '../../platform/host-os/paths.js'

export type BatchClaim =
  | { kind: 'exclusive' }
  | { kind: 'free' }
  | { kind: 'reads'; path: string }
  | { kind: 'writes'; path: string }

const EXCLUSIVE: BatchClaim = { kind: 'exclusive' }
const FREE: BatchClaim = { kind: 'free' }

export function canonicalPath(raw: string): string {
  let probe = expandPath(raw)
  const tail: string[] = []
  for (;;) {
    try {
      probe = realpathSync.native(probe)
      break
    } catch {
      const parent = dirname(probe)
      if (parent === probe) break
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  const resolved = tail.length === 0 ? probe : join(probe, ...tail)
  return foldHostCaseInsensitivePath(resolved)
}

export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = shorter === a ? b : a
  return longer.startsWith(shorter.endsWith(sep) ? shorter : shorter + sep)
}

export async function batchClaimOf(block: ToolUseBlock, context: ToolUseContext): Promise<BatchClaim> {
  try {
    const tool: Tool | undefined = findToolByName(context.options.tools, block.name)
    if (!tool) return EXCLUSIVE
    const parsed = tool.inputSchema.safeParse(block.input)
    if (!parsed.success) return EXCLUSIVE
    await tool.prepare?.(block.input)
    const safe = tool.isConcurrencySafe(parsed.data) === true
    const touched = tool.getPath?.(parsed.data)
    if (typeof touched !== 'string' || touched === '') return safe ? FREE : EXCLUSIVE
    if (tool.isReadOnly(parsed.data) === true) return safe ? { kind: 'reads', path: canonicalPath(touched) } : EXCLUSIVE
    return { kind: 'writes', path: canonicalPath(touched) }
  } catch {
    return EXCLUSIVE
  }
}

export function claimsCompatible(a: BatchClaim, b: BatchClaim): boolean {
  if (a.kind === 'exclusive' || b.kind === 'exclusive') return false
  if (a.kind === 'writes' || b.kind === 'writes') {
    if (a.kind === 'free' || b.kind === 'free') return false
    return !pathsOverlap(a.path, b.path)
  }
  return true
}
