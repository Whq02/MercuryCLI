


import { jaccard, tokenSet } from '../substrate/themis/drift.js'

export const MAX_DOC_TOKENS = 5000
export const MIN_DOC_TOKENS = 1000
export const HISTORY_HEADING = 'history'

export interface MnemeEntry {
  text: string
  seq: number
  time: string
  source: string
  supersedes?: string
  supersededBy?: number
}

export interface MnemeSection {
  heading: string
  entries: MnemeEntry[]
}

export interface MnemeTopicDoc {
  id: string
  slug: string
  summary: string
  tokenCount: number
  created: string
  updated: string
  updateLog: string[]
  sections: MnemeSection[]
  history: MnemeEntry[]
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'general'
  )
}

export function docFileName(slug: string): string {
  return `topic-${slug}.md`
}

const SIG_RE = /\s*<seq=(\d+), time=([^,>]+), source=([^,>]*?)(?:, supersedes=([0-9,\-]+))?>\s*(?:\[superseded-by (\d+)\])?\s*$/

export function serializeSignature(e: MnemeEntry): string {
  const sup = e.supersedes ? `, supersedes=${e.supersedes}` : ''
  const by = e.supersededBy !== undefined ? ` [superseded-by ${e.supersededBy}]` : ''
  return `<seq=${e.seq}, time=${e.time}, source=${e.source}${sup}>${by}`
}

export function parseEntryLine(line: string): MnemeEntry | null {
  const m = line.match(/^-\s+(.*)$/)
  if (!m) return null
  const sig = m[1]!.match(SIG_RE)
  if (!sig) return null
  const text = m[1]!.slice(0, sig.index).trim()
  return {
    text,
    seq: Number(sig[1]),
    time: sig[2]!.trim(),
    source: (sig[3] ?? '').trim(),
    supersedes: sig[4] || undefined,
    supersededBy: sig[5] ? Number(sig[5]) : undefined,
  }
}

export function expandSeqRange(spec: string): number[] {
  const out: number[] = []
  for (const chunk of spec.split(',')) {
    const r = chunk.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (!r) continue
    const lo = Number(r[1])
    const hi = r[2] ? Number(r[2]) : lo
    for (let s = lo; s <= hi && s - lo < 10_000; s++) out.push(s)
  }
  return out
}

export function parseTopicDoc(raw: string): MnemeTopicDoc | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!fm) return null
  const meta: Record<string, string> = {}
  const updateLog: string[] = []
  let inLog = false
  for (const line of fm[1]!.split('\n')) {
    if (/^update_log:\s*$/.test(line)) {
      inLog = true
      continue
    }
    if (inLog && /^- /.test(line)) {
      updateLog.push(line.slice(2).trim())
      continue
    }
    inLog = false
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) meta[kv[1]!] = kv[2]!.trim()
  }
  const id = meta.id ?? ''
  if (!id.startsWith('topic-')) return null
  const sections: MnemeSection[] = []
  const history: MnemeEntry[] = []
  let current: MnemeSection | null = null
  let inHistory = false
  for (const line of raw.slice(fm[0]!.length).split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) {
      const heading = h[1]!.trim()
      inHistory = heading.toLowerCase() === HISTORY_HEADING
      if (!inHistory) {
        current = { heading, entries: [] }
        sections.push(current)
      }
      continue
    }
    const entry = parseEntryLine(line)
    if (!entry) continue
    if (inHistory) history.push(entry)
    else if (current) current.entries.push(entry)
    else {
      current = { heading: 'notes', entries: [entry] }
      sections.push(current)
    }
  }
  return {
    id,
    slug: id.slice('topic-'.length),
    summary: meta.summary ?? '',
    tokenCount: Number(meta.token_count ?? 0) || 0,
    created: meta.created ?? '',
    updated: meta.updated ?? '',
    updateLog,
    sections,
    history,
  }
}

export function serializeTopicDoc(doc: MnemeTopicDoc): string {
  const lines: string[] = [
    '---',
    `id: ${doc.id}`,
    `summary: ${doc.summary.replace(/\n/g, ' ')}`,
    `token_count: ${computeDocTokens(doc)}`,
    `created: ${doc.created}`,
    `updated: ${doc.updated}`,
    'update_log:',
    ...doc.updateLog.map(l => `- ${l.replace(/\n/g, ' ')}`),
    '---',
    '',
  ]
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`, '')
    for (const e of s.entries) lines.push(`- ${e.text} ${serializeSignature(e)}`)
    lines.push('')
  }
  if (doc.history.length > 0) {
    lines.push(`## ${HISTORY_HEADING}`, '')
    for (const e of doc.history) lines.push(`- ${e.text} ${serializeSignature(e)}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function computeDocTokens(doc: MnemeTopicDoc): number {
  let chars = doc.summary.length
  for (const s of doc.sections) {
    chars += s.heading.length
    for (const e of s.entries) chars += e.text.length + 40
  }
  for (const e of doc.history) chars += e.text.length + 40
  return estimateTokens('x'.repeat(chars))
}

export function liveSeqs(doc: MnemeTopicDoc): Set<number> {
  const out = new Set<number>()
  for (const s of doc.sections) for (const e of s.entries) out.add(e.seq)
  return out
}

export function applyRevision(
  doc: MnemeTopicDoc,
  entry: MnemeEntry,
  targetHeading: string,
): { superseded: number[] } {
  const targets = new Set(entry.supersedes ? expandSeqRange(entry.supersedes) : [])
  const superseded: number[] = []
  if (targets.size > 0) {
    for (const s of doc.sections) {
      const keep: MnemeEntry[] = []
      for (const e of s.entries) {
        if (targets.has(e.seq)) {
          doc.history.push({ ...e, supersededBy: entry.seq })
          superseded.push(e.seq)
        } else keep.push(e)
      }
      s.entries = keep
    }
  }
  let section = doc.sections.find(s => s.heading === targetHeading)
  if (!section) {
    section = { heading: targetHeading, entries: [] }
    doc.sections.push(section)
  }
  section.entries.push(entry)
  return { superseded }
}

export function emptyDoc(slug: string, summary: string, nowIso: string): MnemeTopicDoc {
  return {
    id: `topic-${slug}`,
    slug,
    summary,
    tokenCount: 0,
    created: nowIso,
    updated: nowIso,
    updateLog: [],
    sections: [],
    history: [],
  }
}

export function splitDoc(
  doc: MnemeTopicDoc,
  nowIso: string,
  taken?: ReadonlySet<string>,
): [MnemeTopicDoc, MnemeTopicDoc] | null {
  if (computeDocTokens(doc) <= MAX_DOC_TOKENS || doc.sections.length < 2) return null
  const total = computeDocTokens(doc)
  const a = emptyDoc(doc.slug, doc.summary, doc.created)
  a.updated = nowIso
  a.updateLog = [...doc.updateLog]
  let n = 2
  let bSlug = `${doc.slug}-${n}`
  while (taken?.has(bSlug) && n < 100) {
    n++
    bSlug = `${doc.slug}-${n}`
  }
  const b = emptyDoc(bSlug, `${doc.summary} (split)`, nowIso)
  let acc = 0
  for (const s of doc.sections) {
    const sTok = estimateTokens(s.entries.map(e => e.text).join(' '))
    if (acc < total / 2) {
      a.sections.push(s)
      acc += sTok
    } else b.sections.push(s)
  }
  if (b.sections.length === 0) b.sections.push(a.sections.pop()!)
  a.history = doc.history
  a.updateLog.push(`${nowIso} split: ${b.sections.length} section(s) → ${b.id}`)
  b.updateLog.push(`${nowIso} split from ${doc.id}`)
  return [a, b]
}

export function pickMergePartner(
  small: MnemeTopicDoc,
  candidates: readonly MnemeTopicDoc[],
  minJ = 0.3,
): MnemeTopicDoc | null {
  let best: MnemeTopicDoc | null = null
  let bestJ = minJ
  const smallTokens = tokenSet(small.summary + ' ' + small.slug.replace(/-/g, ' '))
  for (const c of candidates) {
    if (c.id === small.id) continue
    const j = jaccard(smallTokens, tokenSet(c.summary + ' ' + c.slug.replace(/-/g, ' ')))
    if (j >= bestJ) {
      bestJ = j
      best = c
    }
  }
  return best
}

export function mergeDocs(into: MnemeTopicDoc, small: MnemeTopicDoc, nowIso: string): void {
  for (const s of small.sections) {
    const existing = into.sections.find(x => x.heading === s.heading)
    if (existing) existing.entries.push(...s.entries)
    else into.sections.push(s)
  }
  into.history.push(...small.history)
  into.updated = nowIso
  into.updateLog.push(`${nowIso} merged ${small.id} (${small.sections.length} section(s))`)
}
