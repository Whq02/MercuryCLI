import type { Message } from 'src/types/message.js'
import { automaticMemoryCandidates, type AutomaticMemoryHit } from '../../mneme/mnemeLookup.js'
import { isMnemeEnabled } from '../../mneme/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { Attachment, MemoryDelivery } from './types.js'
import { recordGrade } from '../../mneme/memoryEvidence.js'
import { mnemeLibraryDir } from '../../mneme/mnemeGates.js'
import { getSystemPromptSectionCache } from '../../bootstrap/state.js'
import { cacheKeys } from '../fileStateCache.js'
import { isOperatorTurn } from '../messages/operatorTurns.js'

export function collectSurfacedMemories(messages: ReadonlyArray<Message>): { ids: Set<string>; paths: Set<string>; totalBytes: number } {
  const ids = new Set<string>()
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'system' && m.subtype === 'compact_boundary') { ids.clear(); paths.clear(); totalBytes = 0 }
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        for (const id of mem.ids ?? []) ids.add(id)
        totalBytes += mem.content.length
      }
    }
    if (m.type === 'attachment' && m.attachment.type === 'bound_prefix') {
      for (const section of m.attachment.sections) if (section.name === 'memory_at_start' || section.name === 'memory') {
        for (const match of (section.value ?? '').matchAll(/<seq=(\d+)|\[(pending:[^\]]+)\]/g)) ids.add(match[1] ? `seq:${match[1]}` : match[2]!)
      }
    }
  }
  return { ids, paths, totalBytes }
}

export function memoryHeader(path: string, _mtimeMs: number, facts = 1, slug?: string): string {
  const where = slug ? (slug === '(recent)' ? 'recent facts, not yet on a page, ' : `topic ${slug}, `) : ''
  return `Memory (${where}${facts} fact${facts === 1 ? '' : 's'}): ${path}:`
}

function visibleMemoryBlocks(messages: readonly Message[]): string[] {
  const blocks: string[] = []
  for (const message of messages) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') blocks.length = 0
    if (message.type !== 'attachment') continue
    const attachment = message.attachment
    if (attachment.type === 'relevant_memories') blocks.push(...attachment.memories.map(row => row.content))
    if (attachment.type === 'bound_prefix') blocks.push(...attachment.sections.filter(row => row.name === 'memory' || row.name === 'memory_at_start').map(row => row.value ?? ''))
    if (attachment.type === 'context_capsule') for (const section of attachment.sections ?? []) if (section.kinds.includes('relevant_memories')) blocks.push(...section.content.flatMap(row => row.type === 'text' ? [row.text] : []))
  }
  const cache = getSystemPromptSectionCache()
  for (const name of ['memory', 'memory_at_start']) {
    const value = cache.get(name)?.value
    if (typeof value === 'string') blocks.push(value)
  }
  return blocks
}

function delivered(hit: AutomaticMemoryHit, blocks: readonly string[]): boolean {
  const identity = hit.seq === undefined ? hit.id : `<seq=${hit.seq}`
  return blocks.some(block => block.includes(identity) && (block.includes(hit.text) || block.includes(`witness:${hit.witness}`)))
}

function latestPrompt(messages: readonly Message[]): string | null {
  const row = messages.findLast(message => isOperatorTurn(message))
  if (row?.type !== 'user') return null
  const content = row.message.content
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function turnAllowance(messages: readonly Message[], newInput: boolean): { records: number; chars: number } {
  if (newInput) return { records: 2, chars: 1200 }
  const start = messages.findLastIndex(message => isOperatorTurn(message))
  const rows = messages.slice(start + 1).flatMap(message => message.type === 'attachment' && message.attachment.type === 'relevant_memories' ? message.attachment.memories : [])
  const deliveries = new Map<string, MemoryDelivery>()
  for (const row of rows) {
    const delivery = row.delivery ?? { key: row.content, ids: row.ids ?? [], chars: row.content.length + (row.header ?? '').length + 41 }
    deliveries.set(delivery.key, delivery)
  }
  for (const message of messages.slice(start + 1)) if (message.type === 'attachment' && message.attachment.type === 'context_capsule') for (const delivery of message.attachment.memoryDeliveries ?? []) deliveries.set(delivery.key, delivery)
  const delivered = [...deliveries.values()]
  return { records: Math.max(0, 2 - delivered.reduce((n, row) => n + row.ids.length, 0)), chars: Math.max(0, 1200 - delivered.reduce((n, row) => n + row.chars, 0)) }
}

function pack(hits: readonly AutomaticMemoryHit[], allowance: { records: number; chars: number }): Attachment[] {
  const memories: Extract<Attachment, { type: 'relevant_memories' }>['memories'] = []
  const header = 'Memory (task-matched; read pointers before relying):'
  let chars = 0
  for (const hit of hits.slice(0, allowance.records)) {
    const grade = recordGrade(hit.id, hit.signature)
    let content = `- ${grade} ${hit.text} ${hit.signature}`
    if (chars + header.length + content.length + 41 > allowance.chars) content = `- ${grade} [${hit.id}] full rule requires Recall read:"${hit.id}"; witness:${hit.witness}${hit.seq === undefined ? '' : ` <seq=${hit.seq}>`}`
    const size = header.length + content.length + 41
    if (chars + size > allowance.chars) continue
    memories.push({ path: hit.pagePath, content, header, mtimeMs: 0, ids: [hit.id], delivery: { key: hit.witness, ids: [hit.id], chars: size } })
    chars += size
  }
  return memories.length ? [{ type: 'relevant_memories', memories }] : []
}

export function getRelevantMemoryAttachments(input: string | null, messages: ReadonlyArray<Message> | undefined, toolUseContext: ToolUseContext): Attachment[] {
  if (toolUseContext.agentId || !isMnemeEnabled()) return []
  const visible = messages ?? []
  const query = input?.trim() || latestPrompt(visible)
  if (!query) return []
  try {
    const hits = automaticMemoryCandidates(query, { dir: mnemeLibraryDir(), files: toolUseContext.readFileState ? cacheKeys(toolUseContext.readFileState) : [] })
    const blocks = visibleMemoryBlocks(visible)
    return pack(hits.filter(hit => !delivered(hit, blocks)), turnAllowance(visible, input !== null))
  } catch (error) {
    logForDebugging(`memory lookup failed: ${String(error)}`)
    return []
  }
}
