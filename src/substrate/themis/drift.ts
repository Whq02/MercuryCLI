/* ============================================================================
   THEMIS drift detection — token-set Jaccard vs a stored baseline.

   Adapted from arXiv:2606.26924 §"drift detection". Prompt-bearing artifacts
   (MERCURY.md, the wrapper append, skills) are normalized (CRLF→LF, trailing
   whitespace stripped, tabs→spaces, blank runs collapsed, code fences and
   frontmatter EXCLUDED), reduced to a word-token SET, and compared to the
   enrolled baseline by Jaccard similarity:

     LOW    J ≥ 0.80          MEDIUM 0.60 ≤ J < 0.80          HIGH J < 0.60

   The thresholds are the paper's OPERATING DEFAULTS, explicitly uncalibrated —
   they classify structural rewrites, which is the injection model Jaccard fits
   (token presence/absence regardless of position; Levenshtein and TF-IDF were
   both rejected by the paper for this purpose). KNOWN GAP, kept honestly: a
   1-token injection into a 100-token baseline scores J≈0.99 and is NOT flagged
   here — single-token attacks are caught by the exact SHA-256 match in
   integrity.ts instead. The two checks are a pair, not alternatives.

   Baselines live beside the lockfile (.mercury/themis/drift.json) as sorted
   unique token arrays — deterministic serialization, few KB even for MERCURY.md.
   ============================================================================ */

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

/** The paper's normalization recipe. Code fences + frontmatter are excluded
 *  (they churn legitimately); the remainder is the prose an injection edits. */
export function normalizeBody(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n')
  // Strip one leading YAML frontmatter block.
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '')
  // Strip fenced code blocks (``` … ```), non-greedy per fence.
  s = s.replace(/```[\s\S]*?```/g, '')
  s = s
    .split('\n')
    .map(l => l.replace(/\t/g, ' ').replace(/[ ]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return s
}

/** Word-token SET (lowercased) of a normalized body. */
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

// ── baseline store ──────────────────────────────────────────────────────────
interface DriftStore {
  version: 1
  updatedAt: string
  baselines: Record<string, string[]> // repo-relative path → sorted token array
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
      // Missing file: skip — verify reports it as absent-from-baseline.
    }
  }
  await durableAtomicPublish(driftStorePath(cwd), JSON.stringify(store, null, 1))
  return { enrolled }
}

/** Compare every enrolled baseline against the file's current content. Missing
 *  store ⇒ empty report (nothing enrolled — not an error). */
export async function checkDriftBaselines(cwd: string = process.cwd()): Promise<DriftReport[]> {
  let raw: string
  try {
    raw = await readFile(driftStorePath(cwd), 'utf8')
  } catch {
    return [] // no store — nothing enrolled (boot cross-checks the lockfile pairing)
  }
  let store: DriftStore
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    store = parsed as DriftStore
  } catch {
    // The store EXISTS but does not parse: that is corruption of trust state,
    // not "nothing enrolled". Fail NOISY with a synthetic HIGH row so every
    // consumer (boot, doctor, CLI) surfaces it instead of silently dropping
    // the whole drift layer.
    return [{ path: '<drift-store corrupt>', jaccard: 0, severity: 'high', baselineTokens: 0, currentTokens: 0 }]
  }
  const reports: DriftReport[] = []
  for (const [rel, tokens] of Object.entries(store.baselines ?? {})) {
    if (!Array.isArray(tokens)) {
      // A malformed baseline row is the same corruption class — HIGH, named.
      reports.push({ path: rel, jaccard: 0, severity: 'high', baselineTokens: 0, currentTokens: 0 })
      continue
    }
    const base = new Set(tokens.filter((t): t is string => typeof t === 'string'))
    let current = new Set<string>()
    try {
      current = tokenSet(normalizeBody(await readFile(join(cwd, rel), 'utf8')))
    } catch {
      // File deleted since enrollment — maximal drift.
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
