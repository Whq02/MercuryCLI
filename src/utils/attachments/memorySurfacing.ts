import type { Message } from 'src/types/message.js'
import { lookupFacts, type LookupHit } from '../../mneme/mnemeLookup.js'
import { isMnemeEnabled } from '../../mneme/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { Attachment } from './types.js'

export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  ids: Set<string>
  paths: Set<string>
  totalBytes: number
} {
  const ids = new Set<string>()
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        for (const id of mem.ids ?? []) ids.add(id)
        totalBytes += mem.content.length
      }
    }
  }
  return { ids, paths, totalBytes }
}

export function memoryHeader(path: string, _mtimeMs: number, facts = 1, slug?: string): string {
  const where = slug ? (slug === '(recent)' ? 'recent facts, not yet on a page, ' : `topic ${slug}, `) : ''
  return `Memory (${where}${facts} fact${facts === 1 ? '' : 's'}): ${path}:`
}

function groupByPage(hits: readonly LookupHit[]): Attachment[] {
  const groups = new Map<string, LookupHit[]>()
  for (const hit of hits) {
    const list = groups.get(hit.pagePath) ?? []
    list.push(hit)
    groups.set(hit.pagePath, list)
  }
  const memories = [...groups.entries()].map(([path, rows]) => {
    const pending = rows[0]!.pending
    const slug = pending ? '(recent)' : rows[0]!.slug
    const content = rows.map(r => `- ${r.text} ${r.signature}`).join('\n')
    return {
      path,
      content,
      mtimeMs: 0,
      header: memoryHeader(path, 0, rows.length, slug),
      ids: rows.map(r => r.id),
    }
  })
  return memories.length === 0 ? [] : [{ type: 'relevant_memories' as const, memories }]
}

export function getRelevantMemoryAttachments(
  input: string | null,
  messages: ReadonlyArray<Message> | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (toolUseContext.agentId) return []
  if (!isMnemeEnabled()) return []
  if (!input || !/\s/.test(input.trim())) return []
  try {
    const surfaced = collectSurfacedMemories(messages ?? [])
    return groupByPage(lookupFacts(input, { exclude: surfaced.ids }))
  } catch (error) {
    logForDebugging(`memory lookup failed: ${String(error)}`)
    return []
  }
}
