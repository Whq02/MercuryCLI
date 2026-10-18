import type { Message } from 'src/types/message.js'
import { automaticMemoryCandidates, type AutomaticMemoryHit } from '../../mneme/mnemeLookup.js'
import { isMnemeEnabled } from '../../mneme/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { Attachment, MemoryDelivery } from './types.js'
import { recordGrade } from '../../mneme/memoryEvidence.js'
import { mnemeLibraryDir } from '../../mneme/mnemeGates.js'
import { getSystemPromptSectionCache } from '../../bootstrap/state.js'
import { isOperatorTurn } from '../messages/operatorTurns.js'
import { markMemorySurfaced, memorySurfacedThisSession } from './memorySurfaced.js'

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
  return blocks.some(block => block.includes(identity) && (block.includes(hit.text) || block.includes(`witness:${hit.witness.slice(0, 16)}`)))
}

function latestPrompt(messages: readonly Message[]): string | null {
  const row = messages.findLast(message => isOperatorTurn(message))
  if (row?.type !== 'user') return null
  const content = row.message.content
  return typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

const PATH_TOKEN = /(?:^|[\s"'`=(])((?:~\/|\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)/g

function recentToolPaths(messages: readonly Message[]): string[] {
  const start = messages.findLastIndex(message => isOperatorTurn(message))
  const paths = new Set<string>()
  for (const message of messages.slice(start + 1)) {
    if (message.type !== 'assistant' || typeof message.message.content === 'string') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || typeof block.input !== 'object' || block.input === null) continue
      for (const [key, value] of Object.entries(block.input as Record<string, unknown>)) {
        if (typeof value !== 'string') continue
        if (key === 'file_path' || key === 'notebook_path' || key === 'path') paths.add(value)
        else if (key === 'command') for (const match of value.matchAll(PATH_TOKEN)) paths.add(match[1]!.replace(/[.,;:)]+$/, ''))
      }
    }
  }
  return [...paths]
}

const RESERVE_EVENTS_PER_TURN = 3

function turnAllowance(messages: readonly Message[], newInput: boolean): { records: number; chars: number; reserve: boolean } {
  if (newInput) return { records: 2, chars: 1200, reserve: true }
  const start = messages.findLastIndex(message => isOperatorTurn(message))
  const rows = messages.slice(start + 1).flatMap(message => message.type === 'attachment' && message.attachment.type === 'relevant_memories' ? message.attachment.memories : [])
  const deliveries = new Map<string, MemoryDelivery>()
  for (const row of rows) {
    const delivery = row.delivery ?? { key: row.content, ids: row.ids ?? [], chars: row.content.length + (row.header ?? '').length + 41 }
    deliveries.set(delivery.key, delivery)
  }
  for (const message of messages.slice(start + 1)) if (message.type === 'attachment' && message.attachment.type === 'context_capsule') for (const delivery of message.attachment.memoryDeliveries ?? []) deliveries.set(delivery.key, delivery)
  const delivered = [...deliveries.values()]
  const counted = delivered.filter(row => !row.reserve)
  return { records: Math.max(0, 2 - counted.reduce((n, row) => n + row.ids.length, 0)), chars: Math.max(0, 1200 - counted.reduce((n, row) => n + row.chars, 0)), reserve: delivered.filter(row => row.event).length < RESERVE_EVENTS_PER_TURN }
}

const FULL_TEXT_CAP = 350
const PREVIEW_CHARS = 140
const CONSTRAINT_RESERVE_CHARS = 560

function historicalMark(hit: AutomaticMemoryHit): string {
  return hit.historical ? ` [historical — names beta.${hit.historical.names}; the library's latest cycle is beta.${hit.historical.latest}; not a current obligation]` : ''
}

function renderHit(hit: AutomaticMemoryHit, form: 'full' | 'preview' | 'compact'): string {
  const grade = recordGrade(hit.id, hit.signature)
  const identity = `witness:${hit.witness.slice(0, 16)}${hit.seq === undefined ? '' : ` <seq=${hit.seq}>`}`
  if (form === 'full') return `- ${grade} ${hit.text} ${hit.signature}${historicalMark(hit)}`
  if (form === 'compact') return `- ${grade} [${hit.id}] on the same subject as the rule above (${hit.text.slice(0, 60)}…): Recall read:"${hit.id}" before relying; ${identity}${historicalMark(hit)}`
  return `- ${grade} [${hit.id}] ${hit.text.slice(0, PREVIEW_CHARS)}… (cropped: read the whole record with Recall read:"${hit.id}" before relying; ${identity})${historicalMark(hit)}`
}

function pack(hits: readonly AutomaticMemoryHit[], visible: (hit: AutomaticMemoryHit) => boolean, allowance: { records: number; chars: number; reserve: boolean }): Attachment[] {
  const memories: Extract<Attachment, { type: 'relevant_memories' }>['memories'] = []
  const header = 'Memory (task-matched):'
  let chars = 0
  let slots = allowance.records
  let reserve = allowance.reserve ? CONSTRAINT_RESERVE_CHARS : 0
  for (const hit of hits) {
    const exact = hit.admission === 'constraint' || hit.admission === 'companion'
    if (slots <= 0 && !(exact && reserve > 0)) break
    if (visible(hit)) {
      if (!exact) slots--
      continue
    }
    let content = renderHit(hit, hit.text.length <= FULL_TEXT_CAP ? 'full' : 'preview')
    if (chars + header.length + content.length + 41 > allowance.chars) content = renderHit(hit, 'preview')
    let size = header.length + content.length + 41
    let reserved = false
    if (chars + size > allowance.chars || slots <= 0) {
      if (!exact || reserve <= 0) continue
      if (hit.admission === 'companion') { content = renderHit(hit, 'compact'); size = header.length + content.length + 41 }
      if (size > reserve + header.length + 41) continue
      reserve -= size - header.length - 41
      reserved = true
    } else slots--
    memories.push({ path: hit.pagePath, content, header, mtimeMs: 0, ids: [hit.id], delivery: { key: hit.witness, ids: [hit.id], chars: size, ...(reserved ? { reserve: true, ...(hit.admission === 'constraint' ? { event: true } : {}) } : {}) } })
    chars += size
  }
  return memories.length ? [{ type: 'relevant_memories', memories }] : []
}

function currentFiles(messages: readonly Message[], cache: ToolUseContext['readFileState'] | undefined): string[] {
  const turn = messages.findLast(message => isOperatorTurn(message))
  const since = turn && 'timestamp' in turn && typeof turn.timestamp === 'string' ? Date.parse(turn.timestamp) : Number.NaN
  const files = new Set(recentToolPaths(messages))
  if (cache) {
    for (const [path, state] of cache.entries()) {
      const stamp = (state as { timestamp?: number } | undefined)?.timestamp
      if (!Number.isFinite(since) || typeof stamp !== 'number' || stamp >= since) files.add(path)
    }
  }
  return [...files]
}

export function getRelevantMemoryAttachments(input: string | null, messages: ReadonlyArray<Message> | undefined, toolUseContext: ToolUseContext): Attachment[] {
  if (toolUseContext.agentId || !isMnemeEnabled()) return []
  const visible = messages ?? []
  const query = input?.trim() || latestPrompt(visible)
  if (!query) return []
  try {
    const hits = automaticMemoryCandidates(query, { dir: mnemeLibraryDir(), files: input === null ? currentFiles(visible, toolUseContext.readFileState) : [], limit: Infinity })
    const blocks = visibleMemoryBlocks(visible)
    const surfaced = memorySurfacedThisSession(toolUseContext, visible)
    const packed = pack(hits, hit => surfaced.has(hit.id) || delivered(hit, blocks), turnAllowance(visible, input !== null))
    markMemorySurfaced(toolUseContext, packed.flatMap(attachment => attachment.type === 'relevant_memories' ? attachment.memories.flatMap(row => row.ids ?? []) : []))
    return packed
  } catch (error) {
    logForDebugging(`memory lookup failed: ${String(error)}`)
    return []
  }
}
