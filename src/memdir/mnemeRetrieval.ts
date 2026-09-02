


import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pendingRows, recentObservations } from './mnemeBuffer.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { listTopicDocs } from './mnemeConsolidate.js'
import { computeDocTokens, docFileName } from './mnemeTopicDocs.js'

export interface MnemeCatalogRow {
  id: string
  slug: string
  summary: string
  tokenCount: number
  updated: string
}

export function catalogDocs(dir: string = mnemeLibraryDir()): MnemeCatalogRow[] {
  return listTopicDocs(dir).map(d => ({
    id: d.id,
    slug: d.slug,
    summary: d.summary,
    tokenCount: computeDocTokens(d),
    updated: d.updated,
  }))
}

export interface MnemeGrepHit {
  slug: string
  line: number
  text: string
}

function grepText(slug: string, raw: string, pattern: string, maxHits: number, out: MnemeGrepHit[]): void {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length && out.length < maxHits; i++) {
    if (re.test(lines[i]!)) out.push({ slug, line: i + 1, text: lines[i]!.slice(0, 240) })
  }
}

export function grepLibrary(pattern: string, opts: { maxHits?: number; dir?: string } = {}): MnemeGrepHit[] {
  const dir = opts.dir ?? mnemeLibraryDir()
  const maxHits = Math.min(Math.max(opts.maxHits ?? 20, 1), 100)
  const out: MnemeGrepHit[] = []
  for (const doc of listTopicDocs(dir)) {
    const p = join(dir, docFileName(doc.slug))
    if (!existsSync(p)) continue
    grepText(doc.slug, readFileSync(p, 'utf8'), pattern, maxHits, out)
    if (out.length >= maxHits) break
  }
  return out
}

export const PENDING_SLUG = '(recent)'

export function grepPending(pattern: string, opts: { maxHits?: number; dir?: string } = {}): MnemeGrepHit[] {
  const dir = opts.dir ?? mnemeLibraryDir()
  const maxHits = Math.min(Math.max(opts.maxHits ?? 20, 1), 100)
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const out: MnemeGrepHit[] = []
  const rows = pendingRows(dir)
  for (let i = 0; i < rows.length && out.length < maxHits; i++) {
    const r = rows[i]!
    if (re.test(r.text)) {
      out.push({
        slug: PENDING_SLUG,
        line: i + 1,
        text: `${r.text.slice(0, 200)} [unconsolidated, ${r.ts}, ${r.source}]`,
      })
    }
  }
  return out
}

export function grepAll(pattern: string, opts: { maxHits?: number; dir?: string } = {}): MnemeGrepHit[] {
  const docHits = grepLibrary(pattern, opts)
  const pending = grepPending(pattern, opts).filter(h => {
    const bare = h.text.replace(/ \[unconsolidated.*$/, '')
    return !docHits.some(d => d.text.includes(bare))
  })
  const maxHits = Math.min(Math.max(opts.maxHits ?? 20, 1), 100)
  return [...docHits, ...pending].slice(0, maxHits)
}

export interface MnemePendingSummary {
  count: number
  topics: string[]
  newest: string
}

export function pendingSummary(dir: string = mnemeLibraryDir()): MnemePendingSummary | null {
  const rows = pendingRows(dir)
  if (rows.length === 0) return null
  const topics = [...new Set(rows.map(r => r.topicHint ?? 'general'))].slice(0, 6)
  return { count: rows.length, topics, newest: rows[rows.length - 1]!.ts }
}

export function grepDoc(slug: string, pattern: string, opts: { maxHits?: number; dir?: string } = {}): MnemeGrepHit[] {
  const dir = opts.dir ?? mnemeLibraryDir()
  const p = join(dir, docFileName(slug))
  if (!existsSync(p)) return []
  const out: MnemeGrepHit[] = []
  grepText(slug, readFileSync(p, 'utf8'), pattern, Math.min(Math.max(opts.maxHits ?? 20, 1), 100), out)
  return out
}

export interface MnemeReadResult {
  slug: string
  from: number
  to: number
  content: string
  recent: Array<{ ts: string; source: string; text: string }>
}

export function readDocLines(
  slug: string,
  opts: { from?: number; to?: number; dir?: string; recent?: number } = {},
): MnemeReadResult | null {
  const dir = opts.dir ?? mnemeLibraryDir()
  const p = join(dir, docFileName(slug))
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').split('\n')
  const nf = Number.isFinite(opts.from ?? 1) ? Math.floor(opts.from ?? 1) : 1
  const nt = Number.isFinite(opts.to ?? lines.length) ? Math.floor(opts.to ?? lines.length) : lines.length
  let from = Math.min(Math.max(1, nf), lines.length)
  let to = Math.min(lines.length, Math.max(from, nt))
  for (let i = from - 1; i >= 1; i--) {
    if (/^##\s/.test(lines[i - 1]!)) {
      from = i
      break
    }
    if (i === 1) from = 1
  }
  for (let i = to + 1; i <= lines.length; i++) {
    if (/^##\s/.test(lines[i - 1]!)) {
      to = i - 1
      break
    }
    if (i === lines.length) to = lines.length
  }
  return {
    slug,
    from,
    to,
    content: lines.slice(from - 1, to).join('\n'),
    recent: recentObservations(opts.recent ?? 5, dir).map(r => ({ ts: r.ts, source: r.source, text: r.text })),
  }
}
