import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { indexTopics, liveCount } from './mnemeArchive.js'
import { listArchiveDocs, listTopicDocs, publishLibraryFile } from './mnemeLibrary.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import type { MnemeEntry, MnemeTopicDoc } from './mnemeTopicDocs.js'
import { pinnedTextLimit, readPins, readUsage, type PinRecord, type UsageRecord } from './mnemeUsage.js'

export const FRONT_PAGE_FILE = 'front-page.md'
export const PINNED_STATUS_FILE = 'pinned-status.json'
const INDEX_LINE_CAP = 160
export const MEMORY_WRITE_VERBS_SENTENCE = 'Retain saves a new fact; Correct supersedes a wrong one and keeps the old fact as history.'
export const EMPTY_INDEX_LINE = '(nothing saved yet — Retain saves the first fact)'
const EMPTY_INDEX_LINE_READ_ONLY = '(nothing saved yet)'

export interface PinnedStatus {
  pinned: number
  used: number
  limit: number
  over: boolean
  loaded: number[]
  asked: number[]
  renderedAt: string
}

export interface PinnedView {
  loaded: Array<{ pin: PinRecord; entry: MnemeEntry; slug: string }>
  missing: number[]
}

export function liveEntryIndex(docs: Iterable<MnemeTopicDoc>): Map<number, { entry: MnemeEntry; slug: string }> {
  const out = new Map<number, { entry: MnemeEntry; slug: string }>()
  for (const d of docs) for (const s of d.sections) for (const e of s.entries) out.set(e.seq, { entry: e, slug: d.slug })
  return out
}

export function pinnedView(pins: readonly PinRecord[], live: Map<number, { entry: MnemeEntry; slug: string }>): PinnedView {
  const present = [...pins.filter(p => live.has(p.seq))].sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
  const missing = pins.filter(p => !live.has(p.seq)).map(p => p.seq)
  return { loaded: present.map(p => ({ pin: p, ...live.get(p.seq)! })), missing }
}

function clipLine(text: string, cap: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one
}

export function pinnedLine(entry: MnemeEntry, pin: PinRecord): string {
  return `- ${entry.text} <seq=${entry.seq}${pin.asked ? ', asked for by the user' : ''}>`
}

export interface IndexLine {
  key: string
  slugs: string[]
  facts: number
  line: string
}

export function indexLines(topics: readonly MnemeTopicDoc[]): IndexLine[] {
  const out: IndexLine[] = []
  for (const [key, docs] of indexTopics(topics)) {
    const facts = docs.reduce((n, d) => n + liveCount(d), 0)
    const summary = docs[0]!.summary.replace(/ \(split\)$/, '').trim()
    const pages = docs.length > 1 ? `, ${docs.length} pages: ${docs.map(d => d.slug).join(', ')}` : ''
    const bare = summary === '' || summary.toLowerCase() === key || summary.toLowerCase().replace(/[^a-z0-9]+/g, '-') === key
    out.push({ key, slugs: docs.map(d => d.slug), facts, line: clipLine(`- ${key}${bare ? '' : ` — ${summary}`} (${facts} fact${facts === 1 ? '' : 's'}${pages})`, INDEX_LINE_CAP) })
  }
  return out
}

export function renderFrontPage(input: {
  dir: string
  topics: readonly MnemeTopicDoc[]
  archives: readonly MnemeTopicDoc[]
  pins: readonly PinRecord[]
  usage: Record<string, UsageRecord>
  now: Date
  limit?: number
}): { text: string; status: PinnedStatus } {
  const { dir, topics, archives, pins, usage, now } = input
  const limit = input.limit ?? pinnedTextLimit()
  const lines: string[] = [
    '# Memory',
    `What Mercury remembers about this project lives in topic pages under ${dir}. The index below names each topic; Recall searches the pages (query) or reads one whole (read:"doc:<slug>"). ${MEMORY_WRITE_VERBS_SENTENCE} Memory is a record of what was learned, not a second copy of the project: never save what the code, the git history or the instruction files already hold.`,
    '',
    '## Index',
  ]
  const index = indexLines(topics)
  let factCount = 0
  if (index.length === 0) {
    lines.push(EMPTY_INDEX_LINE)
  } else {
    for (const row of index) {
      factCount += row.facts
      lines.push(row.line)
    }
  }
  const archivedFacts = archives.reduce((n, d) => n + liveCount(d), 0)
  if (archivedFacts > 0) {
    lines.push(`(${archivedFacts} fact${archivedFacts === 1 ? '' : 's'} not used in a long time sit in archive pages off this index; Recall still finds them)`)
  }
  lines.push('', '## Pinned')
  const live = liveEntryIndex(topics)
  const view = pinnedView(pins, live)
  const pinnedLines = view.loaded.map(row => pinnedLine(row.entry, row.pin))
  const used = pinnedLines.reduce((n, l) => n + l.length + 1, 0)
  if (view.loaded.length === 0) {
    lines.push('(no pinned rules — a rule the user asks to remember is pinned as said; the user pins and unpins in /memory; follow a pinned rule word for word)')
  } else {
    lines.push('Standing rules and preferences the user pinned — follow them word for word; one marked "asked for by the user" is never reworded, merged or dropped:')
    lines.push(...pinnedLines)
  }
  if (used > limit) {
    lines.push(`(the pinned rules fill ${used} of the ${limit}-character limit — all loaded; the user trims in /memory or raises the limit in /config)`)
  }
  lines.push('')
  const status: PinnedStatus = {
    pinned: view.loaded.length,
    used,
    limit,
    over: used > limit,
    loaded: view.loaded.map(r => r.entry.seq),
    asked: view.loaded.filter(r => r.pin.asked).map(r => r.entry.seq),
    renderedAt: now.toISOString(),
  }
  void factCount
  void usage
  return { text: lines.join('\n'), status }
}

export function frontPagePath(dir: string = mnemeLibraryDir()): string {
  return join(dir, FRONT_PAGE_FILE)
}

export function pinnedStatusPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, PINNED_STATUS_FILE)
}

export function publishFrontPage(dir: string = mnemeLibraryDir(), now: Date = new Date()): PinnedStatus | null {
  try {
    const rendered = renderFrontPage({
      dir,
      topics: listTopicDocs(dir),
      archives: listArchiveDocs(dir),
      pins: readPins(dir),
      usage: readUsage(dir),
      now,
    })
    publishLibraryFile(frontPagePath(dir), rendered.text)
    publishLibraryFile(pinnedStatusPath(dir), JSON.stringify(rendered.status, null, 1))
    return rendered.status
  } catch (e) {
    logForDebugging(`memory front page publish failed: ${String(e)}`)
    return null
  }
}

export function readFrontPage(dir: string = mnemeLibraryDir()): string | null {
  try {
    return readFileSync(frontPagePath(dir), 'utf8')
  } catch {
    return null
  }
}

export function readPinnedStatus(dir: string = mnemeLibraryDir()): PinnedStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(pinnedStatusPath(dir), 'utf8')) as PinnedStatus
    return typeof parsed?.pinned === 'number' && typeof parsed?.limit === 'number' && typeof parsed?.used === 'number' ? parsed : null
  } catch {
    return null
  }
}

export function frontPageKey(dir: string = mnemeLibraryDir()): string {
  try {
    const st = statSync(frontPagePath(dir))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'none'
  }
}

export function memoryPromptKey(): string | null {
  if (!mnemeEnabled()) return 'off'
  return frontPageKey()
}

export function forReader(page: string, verbs: 'all' | 'read'): string {
  if (verbs === 'all') return page
  return page.replace(` ${MEMORY_WRITE_VERBS_SENTENCE}`, '').replace(EMPTY_INDEX_LINE, EMPTY_INDEX_LINE_READ_ONLY)
}

export function loadMemoryPrompt(opts: { verbs?: 'all' | 'read' } = {}): string | null {
  if (!mnemeEnabled()) return null
  const dir = mnemeLibraryDir()
  const verbs = opts.verbs ?? 'all'
  const snapshot = readFrontPage(dir)
  if (snapshot !== null) return forReader(snapshot, verbs)
  if (existsSync(dir)) {
    return forReader(renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: readUsage(dir), now: new Date(0) }).text, verbs)
  }
  return forReader(renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: new Date(0) }).text, verbs)
}
