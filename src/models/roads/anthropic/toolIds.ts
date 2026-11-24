import { createHash } from 'node:crypto'
import type { MessageParam } from '../../../engine/message-shapes/wire.js'

export function normalizeAnthropicToolIds(rows: MessageParam[]): MessageParam[] {
  const ids = new Set<string>()
  for (const row of rows) if (Array.isArray(row.content)) for (const block of row.content) {
    if (block === undefined || block === null) continue
    if (block.type === 'tool_use') ids.add(block.id)
    if (block.type === 'tool_result') ids.add(block.tool_use_id)
  }
  const replacements = new Map<string, string>()
  for (const id of [...ids].sort()) {
    if (id === '' || /^[a-zA-Z0-9_-]+$/.test(id)) continue
    const base = `toolu_${createHash('sha256').update(id).digest('hex')}`
    let safe = base
    let suffix = 0
    while (ids.has(safe)) safe = `${base}_${++suffix}`
    ids.add(safe)
    replacements.set(id, safe)
  }
  if (replacements.size === 0) return rows
  const replace = (value: string): string => replacements.get(value) ?? value
  return rows.map(row => ({ ...row, content: typeof row.content === 'string' ? row.content : row.content.map(block => {
    if (block === undefined || block === null) return block
    if (block.type === 'tool_use') return { ...block, id: replace(block.id) }
    if (block.type === 'tool_result') return { ...block, tool_use_id: replace(block.tool_use_id) }
    return block
  }) }))
}
