import { AMBER, CRIMSON, FAINT, SECOND, TEAL } from '../../theme/mercuryPalette.js'
import type { useFlatList } from '../../widgets/useFlatList.js'
import { factMemoryState, type MemoryRef } from '../../../sessions/mneme/memoryRefs.js'
import { SOVEREIGN_SOURCE_MARK } from '../../../sessions/mneme/memoryVerbs.js'
import { pinnedLine, type IndexLine } from '../../../sessions/mneme/mnemeFrontPage.js'
import type { JournalEntry } from '../../../sessions/mneme/journal.js'
import type { MnemeEntry, MnemeTopicDoc } from '../../../sessions/mneme/mnemeTopicDocs.js'
import { formatTextSize, readUsage, type PinRecord } from '../../../sessions/mneme/mnemeUsage.js'
import { getInstructionCompositionState, getInstructionFiles } from '../../../sessions/instructions/instructionFiles.js'
import { toRelativePath, toTildePath } from '../../../platform/files/path.js'
import { humanStamp, type ConventionHit, type LineageTableRow, type OverviewRow, type PageLine } from '../memoryCentreLayout.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

export const STATUS_TONE: Record<MemoryRef['status'], { glyph: string; color: string }> = {
  current: { glyph: '●', color: TEAL },
  unconsolidated: { glyph: '◌', color: SECOND },
  'needs-review': { glyph: '▲', color: AMBER },
  stale: { glyph: '◌', color: SECOND },
}

export const WARNING_STATES = new Set(['off', 'over', 'due', 'degraded', 'no note', 'unclosed'])

export const QUIET_STATES = new Set(['none', 'first', '—'])

export type View = 'overview' | 'facts' | 'pinned' | 'topics' | 'lineage' | 'journal'

export const VIEW_WORDS: Record<Exclude<View, 'overview'>, string> = {
  facts: 'facts and decisions',
  pinned: 'pinned rules',
  topics: 'topics',
  lineage: 'lineage',
  journal: 'journal',
}

export const EMPTY_WORDS: Record<Exclude<View, 'overview'>, string> = {
  facts: 'the first fact Mercury saves lands here',
  pinned: 'open a fact and press p to pin it as said',
  topics: 'the first fact Mercury saves opens a page',
  lineage: 'the ledger starts with this session',
  journal: 'the model writes an entry, in its own words, when a session ends',
}

export const NEXT_SESSION_WORDS = 'this chat keeps what it loaded; new sessions get this'

export interface CentreRow {
  id: string
  kind: 'overview' | 'ref' | 'pin' | 'missing-pin' | 'topic' | 'session' | 'journal' | 'convention'
  label: string
  cells?: string[]
  overview?: OverviewRow
  ref?: MemoryRef
  session?: LineageTableRow
  entry?: JournalEntry
  convention?: ConventionHit
}

export interface Page {
  kind: 'topic' | 'note' | 'journal' | 'file'
  crumb: string
  title: string
  meta: string
  lines: PageLine[]
  path?: string
  focus?: number
}

export type OpenRef = MemoryRef & { missing?: boolean }

export function seqOf(ref: MemoryRef): number | null {
  const m = /^mneme:(\d+)$/.exec(ref.refId)
  return m ? Number(m[1]) : null
}

export function sourceWords(source: string | undefined, text?: string): string {
  if (!source) return ''
  const sovereign = source.endsWith(SOVEREIGN_SOURCE_MARK) ? ' under sovereign' : ''
  if (source === 'operator') return 'from /memory'
  if (source.startsWith('tool:Retain')) return sovereign ? `replaced from the chat${sovereign}` : 'from the chat'
  if (source.startsWith('tool:Correct')) return sovereign && text?.startsWith('retired: ') ? `unpinned and struck from the chat${sovereign}` : `corrected from the chat${sovereign}`
  if (source.startsWith('handover:')) return `taken in from ${source.slice('handover:'.length)}`
  return source
}

export function fileWords(path: string): string {
  const relative = toRelativePath(path)
  return relative === path ? toTildePath(path) : `./${relative}`
}

export function journalEntryRows(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => (a.at === b.at ? 0 : a.at > b.at ? -1 : 1))
}

export function journalRowLabel(entry: JournalEntry): string {
  return `${humanStamp(entry.at)}  ${entry.text.split('\n')[0] ?? ''}`
}

export function topicRef(row: IndexLine): MemoryRef {
  const slug = row.slugs[0] ?? row.key
  return {
    refId: `mneme-topic:${slug}`,
    kind: 'mneme-topic',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: row.line.slice(2),
    why: `${row.facts} fact${row.facts === 1 ? '' : 's'} on ${row.slugs.length} page${row.slugs.length === 1 ? '' : 's'}`,
    deref: `Recall read:"doc:${slug}"`,
    tier: 1,
  }
}

export function factRef(entry: MnemeEntry, slug: string, opts: Parameters<typeof factMemoryState>[1] = {}): MemoryRef {
  return {
    refId: `mneme:${entry.seq}`,
    kind: 'mneme-fact',
    store: 'mneme',
    scope: 'project',
    ...factMemoryState(entry, opts),
    summary: entry.text.length > 140 ? `${entry.text.slice(0, 139)}…` : entry.text,
    source: entry.source,
    capturedAt: entry.time,
    why: `saved ${humanStamp(entry.time)} ${sourceWords(entry.source)}`,
    deref: `Recall read:"doc:${slug}"`,
    tier: 2,
  }
}

export function pinnedRuleRow(row: { pin: PinRecord; entry: MnemeEntry; slug: string }): { label: string; ref: MemoryRef } {
  const size = pinnedLine(row.entry, row.pin).length + 1
  return {
    label: `${formatTextSize(size)} chars · ${row.pin.asked ? 'asked for by you' : 'pinned by Mercury'} · ${row.entry.text}`,
    ref: {
      ...factRef(row.entry, row.slug, { pins: [row.pin] }),
      why: `pinned ${humanStamp(row.pin.at)}${row.pin.asked ? ' · asked for by you' : ' · by Mercury'}`,
      tier: 1,
    },
  }
}

export function factListRows(docs: readonly MnemeTopicDoc[], pins: ReadonlySet<number>): { id: string; label: string; ref: MemoryRef }[] {
  const live: { entry: MnemeEntry; slug: string }[] = []
  for (const doc of docs) for (const section of doc.sections) for (const entry of section.entries) live.push({ entry, slug: doc.slug })
  live.sort((a, b) => (a.entry.time === b.entry.time ? b.entry.seq - a.entry.seq : a.entry.time > b.entry.time ? -1 : 1))
  const state = { pins: [...pins].map(seq => ({ seq, at: '' })), usage: readUsage(), now: new Date() }
  return live.map(({ entry, slug }) => {
    const ref = factRef(entry, slug, state)
    return {
      id: `fact-${entry.seq}`,
      label: `${humanStamp(entry.time)}  ${pins.has(entry.seq) ? 'pinned · ' : ref.status === 'stale' ? 'stale · ' : ''}${entry.text}`,
      ref,
    }
  })
}

export function pendingRef(row: { text: string; ts: string; source: string }, index: number): MemoryRef {
  return {
    refId: `mneme-pending:${index + 1}`,
    kind: 'mneme-pending',
    store: 'mneme',
    scope: 'project',
    status: 'unconsolidated',
    summary: row.text.length > 140 ? `${row.text.slice(0, 139)}…` : row.text,
    source: row.source,
    capturedAt: row.ts,
    why: `saved ${humanStamp(row.ts)} ${sourceWords(row.source)} · consolidates at the next maintenance pass`,
    deref: 'Recall',
    tier: 2,
  }
}

export function refHeader(ref: MemoryRef, pinned: boolean, asked: boolean): string {
  const seq = seqOf(ref)
  const id = seq !== null ? `seq ${seq}` : ref.kind === 'mneme-pending' ? 'recent' : ref.kind === 'mneme-topic' ? 'topic' : ''
  return [id, pinned ? 'pinned' : '', asked ? 'asked for by you' : ''].filter(Boolean).join(' · ')
}

export function refWhyLine(ref: MemoryRef, pins: readonly PinRecord[]): string {
  const seq = seqOf(ref)
  const pin = seq === null ? undefined : pins.find(p => p.seq === seq)
  const parts: string[] = []
  if (pin) parts.push(`pinned ${humanStamp(pin.at)}`)
  if (ref.capturedAt) parts.push(`saved ${humanStamp(ref.capturedAt)}${ref.source ? ` ${sourceWords(ref.source)}` : ''}`)
  const why = ref.why.replace(/^content matches/, 'matches').replace(/ · asked for by you$| · by Mercury$/, '')
  if (!/^(pinned|saved) /.test(why)) parts.push(why)
  return parts.join(' · ')
}

export function matches(query: string, text: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || text.toLowerCase().includes(needle)
}

export function printable(input: string): string {
  return Array.from(input).filter(ch => ch >= ' ' && ch !== '\u007f').join('')
}

export async function instructionFileFacts(): Promise<{ count: number; profile: string } | null> {
  try {
    const files = await getInstructionFiles()
    return { count: files.length, profile: getInstructionCompositionState().resolution.resolved }
  } catch (error) {
    passedOver(error)
    return null
  }
}

export async function instructionTexts(): Promise<{ path: string; text: string }[]> {
  try {
    return (await getInstructionFiles()).map(file => ({ path: file.path, text: file.rawContent ?? file.content }))
  } catch (error) {
    passedOver(error)
    return []
  }
}

export type CentreCorrecting = { seq: number | null; ts: string | null; buffer: string }

export type CentreFlatList = ReturnType<typeof useFlatList<CentreRow>>
