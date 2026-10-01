import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { indexTopics, liveCount } from './mnemeArchive.js'
import { listArchiveDocs, listTopicDocs } from './mnemeConsolidate.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import type { MnemeEntry, MnemeTopicDoc } from './mnemeTopicDocs.js'
import { PINNED_LIMIT, readPins, readUsage, usageOf, type PinRecord, type UsageRecord } from './mnemeUsage.js'

export const FRONT_PAGE_FILE = 'front-page.md'
export const PINNED_STATUS_FILE = 'pinned-status.json'
const INDEX_LINE_CAP = 160

export interface PinnedStatus {
  pinned: number
  limit: number
  loaded: number[]
  sittingOut: Array<{ seq: number; text: string }>
  renderedAt: string
}

export interface PinnedView {
  loaded: Array<{ pin: PinRecord; entry: MnemeEntry; slug: string }>
  sittingOut: Array<{ pin: PinRecord; entry: MnemeEntry; slug: string }>
  missing: number[]
}

export function liveEntryIndex(docs: Iterable<MnemeTopicDoc>): Map<number, { entry: MnemeEntry; slug: string }> {
  const out = new Map<number, { entry: MnemeEntry; slug: string }>()
  for (const d of docs) for (const s of d.sections) for (const e of s.entries) out.set(e.seq, { entry: e, slug: d.slug })
  return out
}

export function rankPins(
  pins: readonly PinRecord[],
  live: Map<number, { entry: MnemeEntry; slug: string }>,
  usage: Record<string, UsageRecord>,
  limit: number = PINNED_LIMIT,
): PinnedView {
  const present = pins.filter(p => live.has(p.seq))
  const missing = pins.filter(p => !live.has(p.seq)).map(p => p.seq)
  const byRecency = [...present].sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
  const byUse = [...present].sort((a, b) => usageOf(b.seq, usage).count - usageOf(a.seq, usage).count || b.at.localeCompare(a.at) || b.seq - a.seq)
  const recencyRank = new Map(byRecency.map((p, i) => [p.seq, i]))
  const useRank = new Map(byUse.map((p, i) => [p.seq, i]))
  const ranked = [...present].sort((a, b) => {
    const sa = recencyRank.get(a.seq)! + useRank.get(a.seq)!
    const sb = recencyRank.get(b.seq)! + useRank.get(b.seq)!
    return sa - sb || b.at.localeCompare(a.at) || b.seq - a.seq
  })
  const shape = (p: PinRecord): { pin: PinRecord; entry: MnemeEntry; slug: string } => ({ pin: p, ...live.get(p.seq)! })
  const loaded = ranked.slice(0, limit).sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq).map(shape)
  const sittingOut = ranked.slice(limit).map(shape)
  return { loaded, sittingOut, missing }
}

function clipLine(text: string, cap: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one
}

export function renderFrontPage(input: {
  dir: string
  topics: readonly MnemeTopicDoc[]
  archives: readonly MnemeTopicDoc[]
  pins: readonly PinRecord[]
  usage: Record<string, UsageRecord>
  now: Date
}): { text: string; status: PinnedStatus } {
  const { dir, topics, archives, pins, usage, now } = input
  const lines: string[] = [
    '# Memory',
    `What Mercury remembers about this project lives in topic pages under ${dir}. The index below names each topic; Recall searches the pages (query) or reads one whole (read:"doc:<slug>"); Retain saves a new fact; Correct supersedes a wrong one and keeps the old fact as history. Memory is a record of what was learned, not a second copy of the project: never save what the code, the git history or the instruction files already hold.`,
    '',
    '## Index',
  ]
  const groups = indexTopics(topics)
  let factCount = 0
  if (groups.size === 0) {
    lines.push('(nothing saved yet — Retain saves the first fact)')
  } else {
    for (const [key, docs] of groups) {
      const facts = docs.reduce((n, d) => n + liveCount(d), 0)
      factCount += facts
      const summary = docs[0]!.summary.replace(/ \(split\)$/, '').trim()
      const pages = docs.length > 1 ? `, ${docs.length} pages: ${docs.map(d => d.slug).join(', ')}` : ''
      const bare = summary === '' || summary.toLowerCase() === key || summary.toLowerCase().replace(/[^a-z0-9]+/g, '-') === key
      lines.push(clipLine(`- ${key}${bare ? '' : ` — ${summary}`} (${facts} fact${facts === 1 ? '' : 's'}${pages})`, INDEX_LINE_CAP))
    }
  }
  const archivedFacts = archives.reduce((n, d) => n + liveCount(d), 0)
  if (archivedFacts > 0) {
    lines.push(`(${archivedFacts} fact${archivedFacts === 1 ? '' : 's'} not used in a long time sit in archive pages off this index; Recall still finds them)`)
  }
  lines.push('', '## Pinned')
  const live = liveEntryIndex(topics)
  const view = rankPins(pins, live, usage)
  if (view.loaded.length === 0) {
    lines.push('(no pinned rules — the user pins standing rules and preferences in /memory; follow a pinned rule word for word)')
  } else {
    lines.push('Standing rules and preferences the user pinned — follow them word for word:')
    for (const row of view.loaded) lines.push(`- ${row.entry.text} <seq=${row.entry.seq}>`)
  }
  if (view.sittingOut.length > 0) {
    lines.push(
      `(${pins.length - view.missing.length} pinned rules, limit ${PINNED_LIMIT}; the newest and most used are loaded — sitting out: ${view.sittingOut.map(r => `seq ${r.entry.seq}`).join(', ')})`,
    )
  }
  lines.push('')
  const status: PinnedStatus = {
    pinned: pins.length - view.missing.length,
    limit: PINNED_LIMIT,
    loaded: view.loaded.map(r => r.entry.seq),
    sittingOut: view.sittingOut.map(r => ({ seq: r.entry.seq, text: clipLine(r.entry.text, 60) })),
    renderedAt: now.toISOString(),
  }
  void factCount
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
    durableAtomicPublishSync(frontPagePath(dir), rendered.text)
    durableAtomicPublishSync(pinnedStatusPath(dir), JSON.stringify(rendered.status, null, 1))
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
    return typeof parsed?.pinned === 'number' && typeof parsed?.limit === 'number' ? parsed : null
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

export function loadMemoryPrompt(): string | null {
  if (!mnemeEnabled()) return null
  const dir = mnemeLibraryDir()
  const snapshot = readFrontPage(dir)
  if (snapshot !== null) return snapshot
  if (existsSync(dir)) {
    return renderFrontPage({ dir, topics: listTopicDocs(dir), archives: listArchiveDocs(dir), pins: readPins(dir), usage: readUsage(dir), now: new Date(0) }).text
  }
  return renderFrontPage({ dir, topics: [], archives: [], pins: [], usage: {}, now: new Date(0) }).text
}
