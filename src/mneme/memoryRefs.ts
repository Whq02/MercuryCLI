
import { existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { memoryGrade, recordGrade } from './memoryEvidence.js'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { lookupTokens } from './mnemeLookup.js'
import { escapeRegExp } from '../utils/stringUtils.js'
import { ledgerPointers, type MemoryPointer } from './mnemePointers.js'
import { catalogDocs, grepLibrary, grepPending, PENDING_SLUG } from './mnemeRetrieval.js'
import type { LedgerEntry } from './types.js'
import type { MnemeEntry } from './mnemeTopicDocs.js'
import { lastUsedMs, readPins, readUsage, type PinRecord, type UsageRecord } from './mnemeUsage.js'

export const FACT_HALF_LIFE_DAYS = 30
const FACT_DECAY_LAMBDA = Math.LN2 / FACT_HALF_LIFE_DAYS
export const FACT_STALE_FLOOR = 0.25

export function factMemoryState(
  entry: Pick<MnemeEntry, 'seq' | 'time' | 'text'>,
  opts: { pins?: readonly PinRecord[]; usage?: Record<string, UsageRecord>; now?: Date; libraryDir?: string; projectRoot?: string | null } = {},
): { status: MemoryRef['status']; confidence: number; confirmedAt: string; missingPaths: string[] } {
  const pins = opts.pins ?? readPins(opts.libraryDir)
  const last = lastUsedMs(entry.seq, entry.time, opts.usage ?? readUsage(opts.libraryDir))
  const ageDays = Math.max(0, (opts.now?.getTime() ?? Date.now()) - last) / 86400000
  const confidence = pins.some(p => p.seq === entry.seq) ? 1 : Math.exp(-FACT_DECAY_LAMBDA * ageDays)
  const freshness = pathFreshness(entry.text, opts.projectRoot ?? null)
  return {
    status: confidence < FACT_STALE_FLOOR ? 'stale' : freshness.status,
    confidence,
    confirmedAt: new Date(last).toISOString(),
    missingPaths: freshness.missingPaths,
  }
}

type MemoryRefKind = 'mneme-fact' | 'mneme-topic' | 'mneme-pending' | 'mneme-session'

export interface MemoryRef {
  refId: string
  kind: MemoryRefKind
  store: 'mneme'
  scope: 'project'
  status: 'current' | 'unconsolidated' | 'needs-review' | 'stale'
  confirmedAt?: string
  confidence?: number
  missingPaths?: readonly string[]
  summary: string
  source?: string
  capturedAt?: string
  why: string
  deref: string
  tier: number
  grade?: string
  library?: string
  identity?: string
  witness?: string
}

const SUMMARY_CAP = 140
const cap = (s: string): string => (s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP - 1) + '…' : s)
const wordStart = (t: string): string => `(^|[^a-z0-9])${escapeRegExp(t)}`

const CITATION_TOKEN = /[^\s"'`()[\]{}<>,;!?]+/g
const CITATION_LEAD = /^[('"`[{<]+/
const CITATION_TRAIL = /[.,;:!?)'"`\]}>…]+$/
const CITATION_LINE_REF = /(?::L?\d+(?:[-–:]L?\d+)*|#L?\d+(?:[-–]L?\d+)?)$/
const CITATION_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

export interface CitedPathReport {
  checked: string[]
  missing: string[]
  other: string[]
}

export function citedPathTokens(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(CITATION_TOKEN) ?? []) {
    const token = raw.replace(CITATION_LEAD, '').replace(CITATION_TRAIL, '').replace(CITATION_LINE_REF, '')
    if (!token.includes('/') || CITATION_SCHEME.test(token) || /[*?{}|]/.test(token) || token.includes('//')) continue
    if (!out.includes(token)) out.push(token)
  }
  return out
}

export function validateCitedPaths(text: string, projectRoot: string | null): CitedPathReport {
  const report: CitedPathReport = { checked: [], missing: [], other: [] }
  if (!projectRoot) return report
  const root = resolve(projectRoot)
  for (const token of citedPathTokens(text)) {
    let relative: string | null = null
    if (isAbsolute(token)) {
      relative = token === root ? '.' : token.startsWith(`${root}${sep}`) ? token.slice(root.length + 1) : null
    } else if (token.startsWith('~')) {
      relative = null
    } else if (token.startsWith('./')) {
      relative = token.slice(2)
    } else {
      const head = token.split(/[\\/]/)[0] ?? ''
      let headIsDirectory = false
      try {
        headIsDirectory = head !== '' && head !== '..' && head !== '.git' && statSync(join(root, head)).isDirectory()
      } catch {
        headIsDirectory = false
      }
      relative = headIsDirectory ? token : null
    }
    if (relative === null) {
      report.other.push(token)
      continue
    }
    const absolute = resolve(root, relative)
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      report.other.push(token)
      continue
    }
    report.checked.push(token)
    if (!existsSync(absolute)) report.missing.push(token)
  }
  return report
}

function pathFreshness(summary: string, projectRoot: string | null): { status: 'current' | 'needs-review'; missingPaths: string[] } {
  const missingPaths = validateCitedPaths(summary, projectRoot).missing
  return { status: missingPaths.length > 0 ? 'needs-review' : 'current', missingPaths }
}

interface CollectOpts {
  maxRefs?: number
  libraryDir?: string
  projectRoot?: string | null
  sessions?: readonly LedgerEntry[]
  now?: Date
}

function sessionRef(pointer: MemoryPointer): MemoryRef {
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
    const id = r.kind === 'mneme-fact' ? r.refId.replace(/^mneme:/, 'seq:') : r.kind === 'mneme-pending' ? `pending:${r.capturedAt ?? ''}` : r.refId
    r.library = opts.libraryDir ?? mnemeLibraryDir()
    r.identity = id
    r.grade = r.kind === 'mneme-topic' ? memoryGrade({ kind: 'structure' }) : r.kind === 'mneme-session' ? memoryGrade({ kind: 'session' }) : recordGrade(id, r.source ?? '', opts.libraryDir)
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
        witness: createHash('sha256').update(`${d.slug}\0${d.summary}\0${d.updated}`).digest('hex'),
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
      const state = h.entry ? factMemoryState(h.entry, { pins, usage, now, projectRoot }) : { ...pathFreshness(words, projectRoot), confirmedAt: undefined }
      push({
        refId: seq !== null ? `mneme:${seq}` : `mneme-line:${h.slug}:${h.line}`,
        kind: 'mneme-fact',
        store: 'mneme',
        scope: 'project',
        status: state.status,
        confirmedAt: state.confirmedAt,
        ...(state.missingPaths.length > 0 ? { missingPaths: state.missingPaths } : {}),
        summary: cap(words),
        witness: createHash('sha256').update(h.text).digest('hex'),
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
        witness: createHash('sha256').update(h.text).digest('hex'),
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
  return `${r.refId}${status} — ${r.grade ?? memoryGrade({ source: r.source, pending: r.kind === 'mneme-pending', kind: r.kind === 'mneme-topic' ? 'structure' : r.kind === 'mneme-session' ? 'session' : 'fact' })} ${r.summary} (${r.why})`
}

export function memoryStatusWords(r: Pick<MemoryRef, 'status' | 'confirmedAt' | 'missingPaths'>): string {
  if (r.status === 'current') return 'current'
  if (r.status === 'unconsolidated') return 'recent, unconsolidated'
  if (r.status === 'needs-review') {
    const gone = r.missingPaths ?? []
    return gone.length === 0 ? 'needs review — cited path moved' : `needs review — cited path moved: ${gone.join(', ')}`
  }
  return `stale — not confirmed since ${r.confirmedAt?.slice(0, 10) ?? 'unknown'}`
}

export { PENDING_SLUG }
