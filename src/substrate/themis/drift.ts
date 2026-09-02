


import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { themisDir } from './auditChain.js'
import { durableAtomicPublish } from '../durablePublish.js'

export type DriftSeverity = 'low' | 'medium' | 'high'

export interface DriftReport {
  path: string
  jaccard: number
  severity: DriftSeverity
  baselineTokens: number
  currentTokens: number
}

export function normalizeBody(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n')
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '')
  s = s.replace(/```[\s\S]*?```/g, '')
  s = s
    .split('\n')
    .map(l => l.replace(/\t/g, ' ').replace(/[ ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return s
}

export function tokenSet(body: string): Set<string> {
  const out = new Set<string>()
  for (const m of body.toLowerCase().matchAll(/[a-z0-9_./-]{2,}/g)) out.add(m[0])
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 1 : inter / union
}

export function classifyDrift(j: number): DriftSeverity {
  if (j >= 0.8) return 'low'
  if (j >= 0.6) return 'medium'
  return 'high'
}

interface DriftStore {
  version: 1
  updatedAt: string
  baselines: Record<string, string[]>
}

export function driftStorePath(cwd: string = process.cwd()): string {
  return join(themisDir(cwd), 'drift.json')
}

export async function enrollDriftBaselines(
  paths: string[],
  cwd: string = process.cwd(),
): Promise<{ enrolled: string[] }> {
  const store: DriftStore = { version: 1, updatedAt: new Date().toISOString(), baselines: {} }
  const enrolled: string[] = []
  for (const rel of paths) {
    try {
      const raw = await readFile(join(cwd, rel), 'utf8')
      store.baselines[rel] = [...tokenSet(normalizeBody(raw))].sort()
      enrolled.push(rel)
    } catch {
    }
  }
  await durableAtomicPublish(driftStorePath(cwd), JSON.stringify(store, null, 1))
  return { enrolled }
}

export async function checkDriftBaselines(cwd: string = process.cwd()): Promise<DriftReport[]> {
  let raw: string
  try {
    raw = await readFile(driftStorePath(cwd), 'utf8')
  } catch {
    return []
  }
  let store: DriftStore
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    store = parsed as DriftStore
  } catch {
    return [{ path: '<drift-store corrupt>', jaccard: 0, severity: 'high', baselineTokens: 0, currentTokens: 0 }]
  }
  const reports: DriftReport[] = []
  for (const [rel, tokens] of Object.entries(store.baselines ?? {})) {
    if (!Array.isArray(tokens)) {
      reports.push({ path: rel, jaccard: 0, severity: 'high', baselineTokens: 0, currentTokens: 0 })
      continue
    }
    const base = new Set(tokens.filter((t): t is string => typeof t === 'string'))
    let current = new Set<string>()
    try {
      current = tokenSet(normalizeBody(await readFile(join(cwd, rel), 'utf8')))
    } catch {
    }
    const j = jaccard(base, current)
    reports.push({
      path: rel,
      jaccard: Number(j.toFixed(4)),
      severity: classifyDrift(j),
      baselineTokens: base.size,
      currentTokens: current.size,
    })
  }
  return reports
}
