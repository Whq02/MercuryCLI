


import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAutoMemPath } from './paths.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { catalogDocs, grepLibrary, grepPending, PENDING_SLUG } from './mnemeRetrieval.js'

export type MemoryRefKind =
  | 'mneme-fact'
  | 'mneme-topic'
  | 'mneme-pending'
  | 'experience-card'
  | 'memory-file'

export interface MemoryRef {
  refId: string
  kind: MemoryRefKind
  store: 'mneme' | 'cards' | 'memdir'
  scope: 'project'
  status: 'current' | 'candidate' | 'unconsolidated' | 'needs-review'
  summary: string
  source?: string
  capturedAt?: string
  why: string
  deref: string
  tier: number
}

const SUMMARY_CAP = 140
const cap = (s: string): string => (s.length > SUMMARY_CAP ? s.slice(0, SUMMARY_CAP - 1) + '…' : s)

export function queryTokens(raw: string): string[] {
  return [...new Set(
    raw
      .toLowerCase()
      .split(/[^a-z0-9_.\-/]+/)
      .filter(t => t.length >= 3),
  )].slice(0, 12)
}

function pathFreshness(summary: string, projectRoot: string | null): 'current' | 'needs-review' {
  if (!projectRoot) return 'current'
  const m = summary.match(/\b(?:src|docs|scripts|assets|lib|test|tests)\/[A-Za-z0-9_\-./]+\.[a-z]{1,5}\b/)
  if (!m) return 'current'
  return existsSync(join(projectRoot, m[0])) ? 'current' : 'needs-review'
}

interface FrontmatterHead {
  name?: string
  description?: string
  type?: string
  approved?: boolean
}

function readHead(path: string): FrontmatterHead {
  try {
    const lines = readFileSync(path, 'utf8').split('\n', 40)
    if (lines[0] !== '---') return {}
    const out: FrontmatterHead = {}
    for (const line of lines.slice(1)) {
      if (line === '---') break
      const m = line.match(/^\s*(name|description|type|approved):\s*(.+)$/)
      if (!m) continue
      if (m[1] === 'approved') out.approved = /true/i.test(m[2]!)
      else out[m[1] as 'name' | 'description' | 'type'] = m[2]!.trim()
    }
    return out
  } catch {
    return {}
  }
}

export interface CollectOpts {
  maxRefs?: number
  libraryDir?: string
  memoryDir?: string
  projectRoot?: string | null
}

export function collectMemoryRefs(query: string, opts: CollectOpts = {}): MemoryRef[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  const maxRefs = Math.min(Math.max(opts.maxRefs ?? 8, 1), 16)
  const projectRoot = opts.projectRoot ?? null
  const out: MemoryRef[] = []
  const seen = new Set<string>()
  const push = (r: MemoryRef): void => {
    if (seen.has(r.refId)) return
    seen.add(r.refId)
    out.push(r)
  }

  if (mnemeEnabled()) {
    const dir = opts.libraryDir ?? mnemeLibraryDir()
    const docs = catalogDocs(dir)
    for (const d of docs) {
      const hit = tokens.find(t => d.slug.includes(t) || d.summary.toLowerCase().includes(t))
      if (hit) {
        push({
          refId: `mneme-topic:${d.slug}`,
          kind: 'mneme-topic',
          store: 'mneme',
          scope: 'project',
          status: 'current',
          summary: cap(`${d.slug}: ${d.summary}`),
          capturedAt: d.updated,
          why: `topic matches '${hit}'`,
          deref: `mneme_read slug=${d.slug}`,
          tier: 1,
        })
      }
    }
    for (const t of tokens) {
      for (const h of grepLibrary(t, { dir, maxHits: 3 })) {
        const sig = h.text.match(/<seq=(\d+), time=([^,>]+), source=([^,>]*?)[,>]/)
        push({
          refId: sig ? `mneme:${sig[1]}` : `mneme-line:${h.slug}:${h.line}`,
          kind: 'mneme-fact',
          store: 'mneme',
          scope: 'project',
          status: pathFreshness(h.text, projectRoot),
          summary: cap(h.text.replace(/<seq=.*$/, '').trim()),
          capturedAt: sig?.[2]?.trim(),
          source: sig?.[3]?.trim(),
          why: `content matches '${t}'`,
          deref: `mneme_read slug=${h.slug}`,
          tier: 2,
        })
      }
      for (const h of grepPending(t, { dir, maxHits: 2 })) {
        push({
          refId: `mneme-pending:${h.line}`,
          kind: 'mneme-pending',
          store: 'mneme',
          scope: 'project',
          status: 'unconsolidated',
          summary: cap(h.text.replace(/ \[unconsolidated.*$/, '')),
          why: `recent unconsolidated matches '${t}'`,
          deref: `mneme_grep pattern=${t}`,
          tier: 2,
        })
      }
    }
  }

  const memDir = opts.memoryDir ?? getAutoMemPath()
  if (existsSync(memDir)) {
    let names: string[] = []
    try {
      names = readdirSync(memDir).filter(
        n => n.endsWith('.md') && n !== 'MEMORY.md' && n !== 'TASTE.md' && !n.includes('.superseded.'),
      )
    } catch {
      names = []
    }
    for (const name of names.slice(0, 200)) {
      const head = readHead(join(memDir, name))
      const hay = `${name} ${head.name ?? ''} ${head.description ?? ''}`.toLowerCase()
      const hit = tokens.find(t => hay.includes(t))
      if (!hit) continue
      const isCard = head.type === 'experience-card' || name.startsWith('card-')
      push({
        refId: `${isCard ? 'card' : 'memfile'}:${name}`,
        kind: isCard ? 'experience-card' : 'memory-file',
        store: isCard ? 'cards' : 'memdir',
        scope: 'project',
        status: isCard && head.approved === false ? 'candidate' : pathFreshness(head.description ?? '', projectRoot),
        summary: cap(head.description ?? head.name ?? name),
        why: `${isCard ? 'lesson' : 'memory'} header matches '${hit}'`,
        deref: join(memDir, name),
        tier: hay.startsWith(hit) ? 1 : isCard ? 3 : 4,
      })
    }
  }

  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const ar = a.status === 'needs-review' ? 1 : 0
    const br = b.status === 'needs-review' ? 1 : 0
    if (ar !== br) return ar - br
    return (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '')
  })
  return out.slice(0, maxRefs)
}

export function renderMemoryRefLine(r: MemoryRef): string {
  const status =
    r.status === 'current' ? '' : r.status === 'candidate' ? ' [CANDIDATE — unverified]' : r.status === 'unconsolidated' ? ' [recent, unconsolidated]' : ' [needs review — cited path moved]'
  return `${r.refId}${status} — ${r.summary} (${r.why})`
}

export { PENDING_SLUG }
