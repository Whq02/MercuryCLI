// ============================================================================
//  projectIntel/capsule — the task-scoped ContextCapsule assembler.
//
//  ONE deterministic assembly function over the project snapshot + caller-
//  supplied session state. Output is a bounded working set of STABLE REFS
//  with per-item role · reason · freshness — never file bodies (the
//  refs-not-bodies law: SWE Context Bench's 217-token summaries beat 25.6k
//  trajectories; Anthropic's JIT canon).
//
//  Ranking (exact and graph evidence BEFORE fuzzy, recency only
//  as a tie-breaker):
//    T1 exact path/test/command names found in the task text
//    T2 active work — accepted zones · active task subjects · goal matches
//    T3 import adjacency of T1 files (bounded local parse, deterministic)
//    T4 current changed paths · recently observed files
//    T5 repository instructions / architecture docs
//    T6 knowledge-base name matches (Projects docs · memory topics)
//  Within a tier: lexical path order. Recency reorders NOTHING across tiers.
//
// Budget law: hard item + byte caps; overflow is COUNTED and the
//  omission reasons are NAMED. The capsule digest (generation + refs) is the
//  S3 dedup key — an unchanged capsule is never re-attached.
//
//  Fast by construction: statSync probes + ≤8 bounded import reads; no
//  model calls, no grep, no LSP waits. Warm p95 gate ≤50ms (closure bench).
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { getProjectSnapshot } from './snapshot.js'
import { projectIntelEnabled, type SnapshotGeneration, type SnapshotRead } from './contracts.js'
import { collectMemoryRefs } from '../../memdir/memoryRefs.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'

export type CapsuleRole =
  | 'primary edit'
  | 'test'
  | 'import neighbour'
  | 'active work'
  | 'recent change'
  | 'instruction'
  | 'knowledge'

export interface CapsuleItem {
  /** Stable dereferenceable ref (mercury://file/<workspace-relative path>). */
  ref: string
  path: string
  role: CapsuleRole
  /** One-line deterministic reason this item is here. */
  reason: string
  /** Ranking tier that selected it (1 = strongest evidence). */
  tier: 1 | 2 | 3 | 4 | 5 | 6
  /** Source-generation stamp (tree digest prefix, or 'live'). */
  freshness: string
  /** Bodies are NEVER inlined — dereference the ref to read. */
  bodyPresent: false
}

/** A task-scoped memory REFERENCE riding the capsule — id +
 *  status + one-line summary + why, NEVER a body (the contracts.ts law). */
export interface CapsuleMemoryRef {
  refId: string
  status: 'current' | 'candidate' | 'unconsolidated' | 'needs-review'
  summary: string
  why: string
}

export interface ContextCapsule {
  schema: 1
  workspace: string
  generation: SnapshotGeneration
  /** The driving task text (bounded echo). */
  task: string
  goal: string | null
  items: CapsuleItem[]
  /** Task-scoped memory refs (bounded, explainable; absent when no store
   *  matches or memory is off). Members of the dedup digest. */
  memoryRefs?: CapsuleMemoryRef[]
  caps: {
    maxItems: number
    maxBytes: number
    /** Candidates dropped by the caps, with NAMED reasons. */
    omitted: { count: number; reasons: string[] }
  }
  /** Stable digest over generation + ordered refs+roles — the dedup key. */
  digest: string
  assembleMs: number
}

export interface CapsuleInput {
  workspace: string
  task: string
  goal?: string | null
  /** Subjects of active tasks (task store), matched like the task text. */
  activeTaskSubjects?: string[]
  /** Accepted zone paths — always in the working set (tier 2). */
  zonePaths?: string[]
  /** Recently observed files (most recent first). */
  recentFiles?: string[]
  /** Operator corrections: pinned paths always ride tier 2;
   *  dropped paths are excluded and counted in the named omissions. */
  pins?: string[]
  drops?: string[]
  budget?: { maxItems?: number; maxBytes?: number }
  /** Hot-path staleness tolerance passed to the snapshot read (the per-turn
   *  producer sets this; strict consumers omit it). A stale-ttl read also
   *  EXCLUDES the git-changed tier — mid-session drains must not churn the
   *  set with the model's own in-flight edits; recent observed files still
   *  ride T4, and fresh/validated reads (new task, resume) include changes. */
  snapshotMaxStaleMs?: number
  /** Pre-acquired snapshot read (the async producer path acquires via
   *  getProjectSnapshotAsync and hands it in — assembly itself never pays
   *  digest/git work then). When absent, assemble reads synchronously. */
  snapshotRead?: SnapshotRead | null
}

const DEFAULT_MAX_ITEMS = 12
const DEFAULT_MAX_BYTES = 4096
const IMPORT_SCAN_FILES = 8
const IMPORT_SCAN_LINES = 60
/** Bounded memory-ref rider — small on purpose: refs, not a dump. */
const MEMORY_REF_CAP = 4

const TEST_PATH_RE = /(^|\/)((tests?|__tests__|spec)\/|test_[^/]+\.py$)|\.(test|spec)\.[a-z]+$/
const PATHISH_RE = /[A-Za-z0-9_@./-]*[/.][A-Za-z0-9_@./-]+/g

function fileRef(path: string): string {
  return `mercury://file/${path}`
}

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path)
}

function existsFile(workspace: string, rel: string): boolean {
  try {
    return statSync(join(workspace, rel)).isFile()
  } catch {
    return false
  }
}

/** Path-looking tokens from free text, workspace-verified. Deterministic.
 *  ABSOLUTE paths under the workspace relativize (delegated tasks in this
 *  harness are doctrinally absolute — audit C4: rejecting them emptied a
 *  subagent's exact-name tier); absolute paths outside it are skipped. */
export function pathTokens(task: string, workspace: string): string[] {
  const seen = new Set<string>()
  for (const raw of task.match(PATHISH_RE) ?? []) {
    let cleaned = normalize(raw.replace(/^["'`(]+|["'`),.:;?!]+$/g, '')).replace(/^\.\//, '')
    if (!cleaned || cleaned.startsWith('..')) continue
    if (cleaned.startsWith('/')) {
      const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`
      if (!cleaned.startsWith(prefix)) continue
      cleaned = cleaned.slice(prefix.length)
      if (!cleaned || cleaned.startsWith('..')) continue
    }
    if (!cleaned.includes('/') && !/\.[a-z]{1,4}$/i.test(cleaned)) continue
    if (seen.has(cleaned)) continue
    if (existsFile(workspace, cleaned)) seen.add(cleaned)
  }
  return [...seen].sort()
}

/** Bounded, deterministic import adjacency for ts/js/py files. Relative
 *  specifiers only (alias/package imports are a NAMED bound, not silently
 *  resolved); candidates escaping the workspace are refused. */
export function importNeighbours(workspace: string, rel: string): string[] {
  let head = ''
  try {
    head = readFileSync(join(workspace, rel), 'utf8').split('\n').slice(0, IMPORT_SCAN_LINES).join('\n')
  } catch {
    return []
  }
  const out = new Set<string>()
  const dir = dirname(rel)
  const addIfExists = (candidate: string): boolean => {
    if (candidate.startsWith('..')) return false // never outside the workspace
    if (existsFile(workspace, candidate)) {
      out.add(candidate)
      return true
    }
    return false
  }
  // ts/js relative imports: import … from './x.ts' | require('./x') — with
  // directory-index resolution (./helpers → helpers/index.ts*).
  for (const m of head.matchAll(/from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const spec = (m[1] ?? m[2])!
    const base = normalize(join(dir, spec))
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      base.replace(/\.js$/, '.ts'),
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
    ]
    for (const candidate of candidates) {
      if (addIfExists(candidate)) break
    }
  }
  // py relative imports: `from .mod import x` · `from ..pkg import x` ·
  // `from . import mod` — dot-count walks up from the file's package dir.
  for (const m of head.matchAll(/^from\s+(\.+)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const dots = m[1]!.length
    let baseDir = dir
    for (let i = 1; i < dots; i++) baseDir = dirname(baseDir)
    const modulePath = m[2] // may be undefined for `from . import mod`
    if (modulePath) {
      const parts = modulePath.split('.')
      const target = join(baseDir, ...parts)
      if (!addIfExists(`${target}.py`)) addIfExists(join(target, '__init__.py'))
    } else {
      const imported = m[3]!
      if (!addIfExists(join(baseDir, `${imported}.py`))) {
        addIfExists(join(baseDir, imported, '__init__.py'))
      }
    }
  }
  return [...out].sort()
}

function tokensOf(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])]
}

/**
 * Assemble the task-scoped context capsule. Deterministic for fixed inputs
 * + tree state; returns null when the gate is off. Never throws.
 */
export function assembleContextCapsule(input: CapsuleInput): ContextCapsule | null {
  if (!projectIntelEnabled()) return null
  const t0 = performance.now()
  const read =
    input.snapshotRead !== undefined
      ? input.snapshotRead
      : getProjectSnapshot(
          input.workspace,
          input.snapshotMaxStaleMs !== undefined ? { maxStaleMs: input.snapshotMaxStaleMs } : {},
        )
  if (!read) return null
  const { snapshot } = read
  const genStamp = snapshot.generation.treeDigest?.slice(0, 12) ?? 'live'
  const maxItems = Math.max(1, input.budget?.maxItems ?? DEFAULT_MAX_ITEMS)
  const maxBytes = Math.max(512, input.budget?.maxBytes ?? DEFAULT_MAX_BYTES)

  const dropped = new Set((input.drops ?? []).map(d => d.replace(/^\.\//, '')))
  let droppedHits = 0
  const candidates: CapsuleItem[] = []
  const taken = new Set<string>()
  const add = (path: string, role: CapsuleRole, tier: CapsuleItem['tier'], reason: string): void => {
    if (dropped.has(path)) {
      droppedHits++
      return
    }
    if (taken.has(path)) return
    taken.add(path)
    candidates.push({
      ref: fileRef(path),
      path,
      role,
      reason,
      tier,
      freshness: genStamp,
      bodyPresent: false,
    })
  }

  // T1 — exact path names in the task text.
  const exact = pathTokens(input.task, input.workspace)
  for (const p of exact) {
    add(p, isTestPath(p) ? 'test' : 'primary edit', 1, `named exactly in the task`)
  }

  // T2 — active work: operator pins, zones, active task subjects, goal
  // path mentions. Pins lead the tier (the operator's word beats derivation).
  for (const p of [...(input.pins ?? [])].sort()) {
    if (existsFile(input.workspace, p)) add(p, 'active work', 2, `operator-pinned`)
  }
  for (const z of [...(input.zonePaths ?? [])].sort()) {
    if (existsFile(input.workspace, z)) add(z, 'active work', 2, `inside an accepted work zone`)
  }
  const activeTexts = [...(input.activeTaskSubjects ?? []), ...(input.goal ? [input.goal] : [])]
  for (const text of activeTexts) {
    for (const p of pathTokens(text, input.workspace)) {
      add(p, 'active work', 2, `named by the active goal/task`)
    }
  }

  // T3 — import adjacency of the exact files (bounded, deterministic).
  for (const p of exact.slice(0, IMPORT_SCAN_FILES)) {
    for (const n of importNeighbours(input.workspace, p)) {
      add(n, isTestPath(n) ? 'test' : 'import neighbour', 3, `imported by ${p}`)
    }
  }

  // T4 — current changed paths (fresh/validated snapshot reads only — a
  // stale-ttl drain must not churn the set with the session's own in-flight
  // edits), then recently observed files. Ordering inside the tier is
  // lexical by the global sort; recency never crosses tiers.
  if (snapshot.git.state === 'ok' && read.from !== 'cache-ttl') {
    for (const c of [...snapshot.git.changed].sort((a, b) => a.path.localeCompare(b.path))) {
      add(c.path, 'recent change', 4, `currently changed in the working tree`)
    }
  }
  for (const r of input.recentFiles ?? []) {
    if (existsFile(input.workspace, r)) add(r, 'recent change', 4, `recently observed this session`)
  }

  // T5 — repository instructions / architecture docs (presence-gated).
  if (snapshot.instructions.claudeMd) add('CLAUDE.md', 'instruction', 5, `repository instructions`)
  if (snapshot.instructions.agentsMd) add('AGENTS.md', 'instruction', 5, `repository agent instructions`)
  if (snapshot.knowledge.wikiIndex)
    add('docs/wiki/INDEX.md', 'instruction', 5, `the repo's architecture router`)
  if (existsFile(input.workspace, 'docs/ARCHITECTURE.md'))
    add('docs/ARCHITECTURE.md', 'instruction', 5, `architecture overview`)

  // T6 — knowledge-base NAME matches against task tokens (names only — no
  // body scans on the fast path; bodies stay with their owners).
  const taskTokens = tokensOf(input.task)
  if (snapshot.surface) {
    for (const doc of snapshot.surface.docs) {
      const stem = doc.toLowerCase().replace(/\.[a-z]+$/, '')
      if (taskTokens.some(t => stem.includes(t)) && existsFile(input.workspace, doc)) {
        add(doc, 'knowledge', 6, `doc name matches the task`)
      }
    }
  }

  // T-memory — task-scoped memory REFS from the composition
  // layer: bounded, deterministic, explainable; refs never bodies (the
  // contracts.ts law). Failure yields an absent section, never a broken
  // capsule.
  let memoryRefs: CapsuleMemoryRef[] | undefined
  try {
    if (isAutoMemoryEnabled()) {
      const collected = collectMemoryRefs([input.task, input.goal ?? ''].join(' '), {
        maxRefs: MEMORY_REF_CAP,
        projectRoot: input.workspace,
      })
      if (collected.length > 0) {
        memoryRefs = collected.map(r => ({ refId: r.refId, status: r.status, summary: r.summary, why: r.why }))
      }
    }
  } catch {
    memoryRefs = undefined
  }

  // Order: tier, then path — recency never crosses tiers.
  candidates.sort((a, b) => a.tier - b.tier || a.path.localeCompare(b.path))

  // Budget: items cap, then byte cap over the serialized items.
  const omittedReasons: string[] = []
  if (droppedHits > 0) {
    omittedReasons.push(`${droppedHits} candidate(s) operator-dropped (/orient drop)`)
  }
  let items = candidates
  if (items.length > maxItems) {
    omittedReasons.push(`${items.length - maxItems} candidate(s) over the ${maxItems}-item cap`)
    items = items.slice(0, maxItems)
  }
  let serialized = JSON.stringify(items)
  while (Buffer.byteLength(serialized, 'utf8') > maxBytes && items.length > 1) {
    items = items.slice(0, -1)
    serialized = JSON.stringify(items)
  }
  if (items.length < candidates.length && omittedReasons.length === 0) {
    omittedReasons.push(`${candidates.length - items.length} candidate(s) over the ${maxBytes}-byte cap`)
  } else if (Buffer.byteLength(JSON.stringify(candidates.slice(0, maxItems)), 'utf8') > maxBytes) {
    omittedReasons.push(`byte cap ${maxBytes} trimmed further`)
  }
  // Operator drops are OMISSIONS too (audit C6): they must ride the COUNT,
  // not just the reasons, or a drop-only capsule renders without naming them.
  const omittedCount = candidates.length - items.length + droppedHits

  // SET identity, deliberately WITHOUT the tree digest: the dedup key must
  // change only when the WORKING SET changes. Baking the generation in made
  // every unrelated edit re-attach an identical item list whose only new
  // byte was the digest hex — pure churn (the end-wave audit's finding).
  // Freshness still rides every item + the generation field; identity does
  // not.
  // Memory refs JOIN the identity (the live-map warning: a digest that
  // excludes them would suppress memory-only changes as duplicates). The
  // bounded summary rides the facet so a CONTENT change inside a ref'd doc
  // (a correction superseding a fact) moves the identity too — id·status
  // alone cannot see it.
  const digest = createHash('sha1')
    .update(items.map(i => `${i.ref}·${i.role}·${i.tier}`).join('|'))
    .update('||' + (memoryRefs ?? []).map(r => `${r.refId}·${r.status}·${r.summary}`).join('|'))
    .digest('hex')
    .slice(0, 16)

  return {
    schema: 1,
    workspace: input.workspace,
    generation: snapshot.generation,
    task: input.task.slice(0, 400),
    goal: input.goal ?? null,
    items,
    ...(memoryRefs ? { memoryRefs } : {}),
    caps: {
      maxItems,
      maxBytes,
      omitted: { count: omittedCount, reasons: omittedReasons },
    },
    digest,
    assembleMs: Math.round(performance.now() - t0),
  }
}

/** Render the capsule as the bounded model-facing block (used by the S3
 *  attachment + subagent scoping). Pure; every line explainable. */
export function renderCapsule(capsule: ContextCapsule): string {
  const lines: string[] = [
    `# Working set (task-scoped, generation ${capsule.generation.treeDigest?.slice(0, 12) ?? 'no-digest'})`,
  ]
  for (const item of capsule.items) {
    lines.push(`- ${item.path} — ${item.role}; ${item.reason}`)
  }
  if (capsule.caps.omitted.count > 0 || capsule.caps.omitted.reasons.length > 0) {
    lines.push(`(${capsule.caps.omitted.count} omitted: ${capsule.caps.omitted.reasons.join('; ')})`)
  }
  if (capsule.memoryRefs && capsule.memoryRefs.length > 0) {
    lines.push('Memory (task-scoped refs — dereference before relying; bodies stay in their stores):')
    for (const r of capsule.memoryRefs) {
      const status =
        r.status === 'current'
          ? ''
          : r.status === 'candidate'
            ? ' [CANDIDATE — unverified]'
            : r.status === 'unconsolidated'
              ? ' [recent, unconsolidated]'
              : ' [needs review — cited path moved]'
      lines.push(`- ${r.refId}${status} — ${r.summary} (${r.why})`)
    }
  }
  return lines.join('\n')
}
