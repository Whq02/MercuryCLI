
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { escapeRegExp, lookupTokens } from './mnemeLookup.js'
import { ledgerPointers, type MemoryPointer } from './mnemePointers.js'
import { catalogDocs, grepLibrary, grepPending, PENDING_SLUG } from './mnemeRetrieval.js'
import type { LedgerEntry } from './types.js'
import type { MnemeEntry } from './mnemeTopicDocs.js'
import { lastUsedMs, readPins, readUsage, type PinRecord, type UsageRecord } from './mnemeUsage.js'

export const FACT_HALF_LIFE_DAYS = 30
export const FACT_DECAY_LAMBDA = Math.LN2 / FACT_HALF_LIFE_DAYS
export const FACT_STALE_FLOOR = 0.25

export function factMemoryState(
  entry: Pick<MnemeEntry, 'seq' | 'time' | 'text'>,
  opts: { pins?: readonly PinRecord[]; usage?: Record<string, UsageRecord>; now?: Date; libraryDir?: string; projectRoot?: string | null } = {},
): { status: MemoryRef['status']; confidence: number; confirmedAt: string } {
  const pins = opts.pins ?? readPins(opts.libraryDir)
  const last = lastUsedMs(entry.seq, entry.time, opts.usage ?? readUsage(opts.libraryDir))
  const ageDays = Math.max(0, (opts.now?.getTime() ?? Date.now()) - last) / 86400000
  const confidence = pins.some(p => p.seq === entry.seq) ? 1 : Math.exp(-FACT_DECAY_LAMBDA * ageDays)
  return {
    status: confidence < FACT_STALE_FLOOR ? 'stale' : pathFreshness(entry.text, opts.projectRoot ?? null),
    confidence,
    confirmedAt: new Date(last).toISOString(),
  }
}

export type MemoryRefKind = 'mneme-fact' | 'mneme-topic' | 'mneme-pending' | 'mneme-session'

export interface MemoryRef {
  refId: string
  kind: MemoryRefKind
  store: 'mneme'
  scope: 'project'
  status: 'current' | 'unconsolidated' | 'needs-review' | 'stale'
  confirmedAt?: string
  confidence?: number
  summary: string
  source?: string
  capturedAt?: string
  why: string
  deref: string
  tier: number
}

const SUMMARY_CAP = 140
const cap = (s: string): string => (s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP - 1) + '…' : s)
const wordStart = (t: string): string => `(^|[^a-z0-9])${escapeRegExp(t)}`

function pathFreshness(summary: string, projectRoot: string | null): 'current' | 'needs-review' {
  if (!projectRoot) return 'current'
  const m = summary.match(/\b(?:src|docs|scripts|assets|lib|test|tests)\/[A-Za-z0-9_\-./]+\.[a-z]{1,5}\b/)
  if (!m) return 'current'
  return existsSync(join(projectRoot, m[0])) ? 'current' : 'needs-review'
}

export interface CollectOpts {
  maxRefs?: number
  libraryDir?: string
  projectRoot?: string | null
  sessions?: readonly LedgerEntry[]
  now?: Date
}

export function sessionRef(pointer: MemoryPointer): MemoryRef {
  const ordinal = pointer.footnotes.session ?? Number(pointer.id.slice('ledger:'.length))
  return {
    refId: `mneme-session:${ordinal}`,
    kind: 'mneme-session',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: cap(pointer.title),
    why: pointer.kind === 'handoff' ? 'a handoff of this project matches' : 'a session of this project matches',
    deref: `Recall read:"ledger:${ordinal}"`,
    tier: pointer.kind === 'handoff' ? 1 : 2,
  }
}

export function collectMemoryRefs(query: string, opts: CollectOpts = {}): MemoryRef[] {
  const tokens = lookupTokens(query)
  if (tokens.length === 0 || !mnemeEnabled()) return []
  const maxRefs = Math.min(Math.max(opts.maxRefs ?? 8, 1), 16)
  const projectRoot = opts.projectRoot ?? null
  const out: MemoryRef[] = []
  const seen = new Set<string>()
  const push = (r: MemoryRef): void => {
    if (seen.has(r.refId)) return
    seen.add(r.refId)
    out.push(r)
  }

  const dir = opts.libraryDir ?? mnemeLibraryDir()
  const pins = readPins(dir)
  const usage = readUsage(dir)
  const now = opts.now ?? new Date()
  const matchers = tokens.map(t => ({ token: t, pattern: wordStart(t), re: new RegExp(wordStart(t)) }))
  for (const pointer of ledgerPointers(query, opts.sessions ?? [])) push(sessionRef(pointer))
  for (const d of catalogDocs(dir)) {
    const slug = d.slug.toLowerCase()
    const summary = d.summary.toLowerCase()
    const hit = matchers.find(m => m.re.test(slug) || m.re.test(summary))
    if (hit) {
      push({
        refId: `mneme-topic:${d.slug}`,
        kind: 'mneme-topic',
        store: 'mneme',
        scope: 'project',
        status: 'current',
        summary: cap(`${d.slug}: ${d.summary}`),
        capturedAt: d.updated,
        why: `topic matches '${hit.token}'`,
        deref: `Recall read:"doc:${d.slug}"`,
        tier: 1,
      })
    }
  }
  for (const { token: t, pattern } of matchers) {
    for (const h of grepLibrary(pattern, { dir, maxHits: Infinity })) {
      const sig = h.text.match(/<seq=(\d+), time=([^,>]+), source=([^,>]*?)[,>]/)
      const seq = h.entry?.seq ?? (sig ? Number(sig[1]) : null)
      const words = h.entry?.text ?? h.text.replace(/<seq=.*$/, '').replace(/^\s*-\s+/, '').trim()
      push({
        refId: seq !== null ? `mneme:${seq}` : `mneme-line:${h.slug}:${h.line}`,
        kind: 'mneme-fact',
        store: 'mneme',
        scope: 'project',
        ...(h.entry ? factMemoryState(h.entry, { pins, usage, now, projectRoot }) : { status: pathFreshness(words, projectRoot) }),
        summary: cap(words),
        capturedAt: h.entry?.time ?? sig?.[2]?.trim(),
        source: h.entry?.source ?? sig?.[3]?.trim(),
        why: `content matches '${t}'${h.entry?.supersededBy !== undefined ? ' · in history' : ''}`,
        deref: `Recall read:"doc:${h.slug}"`,
        tier: 2,
      })
    }
    for (const h of grepPending(pattern, { dir, maxHits: 2 })) {
      const stamp = / \[unconsolidated, ([^,\]]+), ([^\]]*)\]$/.exec(h.text)
      push({
        refId: `mneme-pending:${h.line}`,
        kind: 'mneme-pending',
        store: 'mneme',
        scope: 'project',
        status: 'unconsolidated',
        summary: cap(h.text.replace(/ \[unconsolidated.*$/, '')),
        ...(stamp !== null ? { capturedAt: stamp[1], source: stamp[2] } : {}),
        why: `recent unconsolidated matches '${t}'`,
        deref: `Recall query:"${t}"`,
        tier: 2,
      })
    }
  }

  out.sort((a, b) => {
    const stale = Number(a.status === 'stale') - Number(b.status === 'stale')
    if (stale !== 0) return stale
    if (a.tier !== b.tier) return a.tier - b.tier
    const ar = a.status === 'needs-review' ? 1 : 0
    const br = b.status === 'needs-review' ? 1 : 0
    if (ar !== br) return ar - br
    return (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '')
  })
  return out.slice(0, maxRefs)
}

export function renderMemoryRefLine(r: MemoryRef): string {
  const words = memoryStatusWords(r)
  const status = r.status === 'current' ? '' : ` [${words}]`
  return `${r.refId}${status} — ${r.summary} (${r.why})`
}

export function memoryStatusWords(r: Pick<MemoryRef, 'status' | 'confirmedAt'>): string {
  if (r.status === 'current') return 'current'
  if (r.status === 'unconsolidated') return 'recent, unconsolidated'
  if (r.status === 'needs-review') return 'needs review — cited path moved'
  return `stale — not confirmed since ${r.confirmedAt?.slice(0, 10) ?? 'unknown'}`
}

export { PENDING_SLUG }
