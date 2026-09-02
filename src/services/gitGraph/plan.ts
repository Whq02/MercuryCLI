// ============================================================================
//  gitGraph/plan — preview-first atomic commit plans + transactional index
//  operations. LAWS (contracts.ts): local-only · never
//  push · never rewrite history · never discard uncommitted content ·
//  stale-safe application · a commit can never include an unplanned file
//  (verified FROM the created commit, not assumed).
//
//  One explicit transaction-plane record per APPLIED COMMIT (kind
//  'git.commit'), its 'applied' claim backed by canonical observed
//  evidence of the created sha — the same Law-4 seam every other mutation
//  rides. The tool-call level additionally mints its exactly-once receipt
//  through the effect observer.
// ============================================================================

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import { beginTransaction, transitionTransaction } from '../primitives/transactionPlane.js'
import type { GitPlan, GitPlanGroup, GitPlanState } from './contracts.js'
import { git, gitStatus, hunkId, isGitRepo } from './observe.js'

const PLAN_RING = 16

interface OwnerPlans {
  plans: Map<string, GitPlan>
  order: string[]
  evicted: Set<string>
}

const store = new OwnerScopedStore<OwnerPlans>({
  name: 'git-plan',
  create: () => ({ plans: new Map(), order: [], evicted: new Set() }),
  cap: 32,
})
registerOwnerScopedStore(store)

export function getPlan(owner: OwnerKey, id: string): GitPlan | undefined {
  return store.peek(owner)?.plans.get(id)
}

export function listPlans(owner: OwnerKey): GitPlan[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.order.map(id => owned.plans.get(id)!).filter(Boolean)
}

export function planExpired(owner: OwnerKey, id: string): boolean {
  return store.peek(owner)?.evicted.has(id) ?? false
}

function remember(owner: OwnerKey, plan: GitPlan): void {
  const owned = store.get(owner)
  if (!owned.plans.has(plan.id)) owned.order.push(plan.id)
  owned.plans.set(plan.id, plan)
  while (owned.order.length > PLAN_RING) {
    const dropped = owned.order.shift()!
    owned.plans.delete(dropped)
    owned.evicted.add(dropped)
  }
}

function setPlanState(owner: OwnerKey, id: string, state: GitPlanState, patch: Partial<GitPlan> = {}): GitPlan | undefined {
  const owned = store.peek(owner)
  const cur = owned?.plans.get(id)
  if (!owned || !cur) return undefined
  const next = { ...cur, ...patch, state }
  owned.plans.set(id, next)
  return next
}

// ── raw hunk parsing (id-compatible with observe.parseUnifiedDiff) ──────────

interface RawHunk {
  id: string
  file: string
  header: string
  raw: string[]
}

interface RawFilePatch {
  file: string
  headerLines: string[]
  hunks: RawHunk[]
}

function parseRawPatches(raw: string): RawFilePatch[] {
  const out: RawFilePatch[] = []
  let cur: RawFilePatch | null = null
  let hunk: { header: string; lines: string[] } | null = null
  const flushHunk = (): void => {
    if (cur && hunk) {
      cur.hunks.push({
        id: hunkId(cur.file, hunk.header, hunk.lines.join('\n')),
        file: cur.file,
        header: hunk.header,
        raw: hunk.lines,
      })
    }
    hunk = null
  }
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushHunk()
      const m = line.match(/ b\/(.+)$/)
      cur = { file: m ? m[1]! : '', headerLines: [line], hunks: [] }
      out.push(cur)
    } else if (line.startsWith('@@')) {
      flushHunk()
      hunk = { header: line, lines: [] }
    } else if (hunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '\\ No newline at end of file') {
        hunk.lines.push(line)
      }
    } else if (cur) {
      cur.headerLines.push(line)
    }
  }
  flushHunk()
  return out
}

// ── whole-sequence simulation ────────────────────────
// Replays every hunk-bearing group's staged patch in chain order against a
// TEMP index file seeded from HEAD — the real index and worktree are never
// touched. git apply's context matching mirrors the executor exactly, so a
// mid-chain conflict (overlap the disjointness check could not see, drifted
// context) surfaces at prepare time. Returns null on success, else the
// refusal detail.
function simulateHunkSequence(
  root: string,
  groups: GitPlanGroup[],
  patches: Map<string, RawFilePatch>,
): string | null {
  const tmpIndex = path.join(tmpdir(), `mercury-gitplan-sim-${process.pid}-${Date.now()}`)
  const env = { ...subprocessEnv(), GIT_INDEX_FILE: tmpIndex }
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { windowsHide: true, cwd: root, env, timeout: 30_000 })
    for (const [gi, g] of groups.entries()) {
      for (const [file, ids] of Object.entries(g.hunks ?? {})) {
        const patch = patches.get(file)
        if (!patch) continue // non-spanning hunk files validate at apply time as before
        const chosen = patch.hunks.filter(h => ids.includes(h.id))
        if (chosen.length === 0) continue
        const patchText = `${[...patch.headerLines, ...chosen.flatMap(h => [h.header, ...h.raw])].join('\n')}\n`
        try {
          execFileSync('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
            windowsHide: true,
            cwd: root,
            env,
            input: patchText,
            timeout: 30_000,
          })
        } catch (e) {
          return `group ${gi + 1} ('${g.message.slice(0, 40)}'), file '${file}': ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
        }
      }
    }
    return null
  } catch (e) {
    return `simulation setup failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
  } finally {
    try {
      rmSync(tmpIndex, { force: true })
    } catch {
      /* best effort */
    }
  }
}

// ── prepare ──────────────────────────────────────────────────────────────────

export interface PlanRefusal {
  state: 'refused'
  reason: string
}

export function preparePlan(
  owner: OwnerKey,
  root: string,
  groups: GitPlanGroup[],
  /**  provenance-before-staging: ABSOLUTE paths Mercury itself
   *  edited this session (fileHistory) — changed files outside this set are
   *  EXTERNAL work (operator, linter) and get named as such on the plan. */
  mercuryTouched?: ReadonlySet<string>,
): GitPlan | PlanRefusal {
  const status = gitStatus(root)
  if ('state' in status) return { state: 'refused', reason: status.note }
  if (groups.length === 0) return { state: 'refused', reason: 'a plan needs at least one group' }
  if (groups.some(g => !g.message?.trim())) {
    return { state: 'refused', reason: 'every group needs a commit message' }
  }
  const changed = new Set(status.files.map(f => f.path))
  const seen = new Set<string>()
  const appearances = new Map<string, number>()
  for (const g of groups) {
    if (g.files.length === 0) return { state: 'refused', reason: `group '${g.message.slice(0, 40)}' has no files` }
    for (const f of g.files) {
      if (!changed.has(f)) {
        return { state: 'refused', reason: `'${f}' has no changes — a plan names only really-changed files` }
      }
      appearances.set(f, (appearances.get(f) ?? 0) + 1)
      seen.add(f)
    }
    for (const [file, ids] of Object.entries(g.hunks ?? {})) {
      if (!g.files.includes(file)) {
        return { state: 'refused', reason: `hunks name '${file}' which is not in the group's files` }
      }
      if (ids.length === 0) return { state: 'refused', reason: `'${file}' has an empty hunk selection` }
    }
  }
  // a file MAY span groups — but ONLY via explicit,
  // pairwise-disjoint hunk allocations on EVERY appearance (a full-file
  // selection can never sit in two commits), with every referenced hunk id
  // reproducing against the CURRENT worktree diff, refused BEFORE commit one.
  const spanningFiles = [...appearances.entries()].filter(([, n]) => n > 1).map(([f]) => f)
  for (const f of spanningFiles) {
    for (const g of groups) {
      if (g.files.includes(f) && (g.hunks?.[f]?.length ?? 0) === 0) {
        return {
          state: 'refused',
          reason: `'${f}' appears in more than one group — that is allowed only when EVERY appearance selects explicit hunk ids (op:"diff" lists them); group '${g.message.slice(0, 40)}' selects the whole file`,
        }
      }
    }
    const allIds = groups.filter(g => g.files.includes(f)).map(g => g.hunks![f]!)
    const flat = allIds.flat()
    if (new Set(flat).size !== flat.length) {
      const dupes = flat.filter((id, i) => flat.indexOf(id) !== i)
      return {
        state: 'refused',
        reason: `'${f}': hunk id(s) ${[...new Set(dupes)].join(', ')} are selected by more than one group — one hunk belongs to exactly one commit`,
      }
    }
  }
  if (spanningFiles.length > 0) {
    const raw = git(root, ['diff', '--no-color', '--unified=3', '--', ...spanningFiles])
    const patches = new Map(parseRawPatches(raw).map(p => [p.file, p]))
    for (const f of spanningFiles) {
      const available = new Set((patches.get(f)?.hunks ?? []).map(h => h.id))
      const wanted = groups.filter(g => g.files.includes(f)).flatMap(g => g.hunks![f]!)
      const missing = wanted.filter(id => !available.has(id))
      if (missing.length > 0) {
        return {
          state: 'refused',
          reason: `'${f}': hunk id(s) ${missing.join(', ')} do not reproduce against the current diff — re-run op:"diff" and re-plan`,
        }
      }
    }
    // Whole-sequence simulation against a TEMP INDEX (never the real one):
    // every group's hunk patch must apply in chain order on top of the
    // previous groups' staged state — a mid-chain conflict is discovered
    // HERE, before any commit exists.
    const sim = simulateHunkSequence(root, groups, patches)
    if (sim !== null) {
      return { state: 'refused', reason: `the commit sequence does not apply cleanly: ${sim} — nothing was staged or committed` }
    }
  }
  const exclusions = status.files.map(f => f.path).filter(p => !seen.has(p))
  const provenance =
    mercuryTouched === undefined
      ? undefined
      : Object.fromEntries(
          status.files.map(f => [
            f.path,
            mercuryTouched.has(path.resolve(root, f.path)) ? ('mercury' as const) : ('external' as const),
          ]),
        )
  const ambiguous = status.files
    .filter(f => f.staged !== '' && f.unstaged !== '' && seen.has(f.path))
    .map(f => f.path)

  const id = `gp-${createHash('sha1')
    .update(JSON.stringify({ digest: status.digest, groups }))
    .digest('hex')
    .slice(0, 12)}`
  const plan: GitPlan = {
    id,
    createdAt: Date.now(),
    state: 'proposed',
    ...(provenance ? { provenance } : {}),
    root,
    digest: status.digest,
    head: status.head,
    groups,
    exclusions,
    ambiguous,
  }
  remember(owner, plan)
  return plan
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface PlanApplyOutcome {
  state: 'applied'
  plan: GitPlan
  commits: NonNullable<GitPlan['commits']>
}

export interface PlanApplyRefusal {
  state: 'refused'
  code: 'absent' | 'stale' | 'already-applied' | 'cancelled' | 'verify' | 'io'
  reason: string
  /** Commits created BEFORE the failure — they stand (history is never
   *  rewritten); the refusal names exactly how far application got. */
  commitsCreated?: { sha: string; message: string }[]
}

export function applyPlan(
  owner: OwnerKey,
  planId: string,
  opts: { signal?: AbortSignal } = {},
): PlanApplyOutcome | PlanApplyRefusal {
  const plan = getPlan(owner, planId)
  if (!plan) return { state: 'refused', code: 'absent', reason: `no plan '${planId}' in this conversation` }
  if (plan.state === 'applied') {
    return { state: 'refused', code: 'already-applied', reason: `${planId} already applied — commits exist` }
  }
  if (plan.state !== 'proposed') {
    return { state: 'refused', code: 'stale', reason: `${planId} is '${plan.state}'${plan.note ? ` — ${plan.note}` : ''}` }
  }
  if (opts.signal?.aborted) {
    setPlanState(owner, planId, 'cancelled', { note: 'cancelled before applying' })
    return { state: 'refused', code: 'cancelled', reason: 'cancelled before applying — nothing committed' }
  }

  // 1. stale-refusal: the tree must be EXACTLY what the plan was prepared on.
  const now = gitStatus(plan.root)
  if ('state' in now) return { state: 'refused', code: 'io', reason: now.note }
  if (now.digest !== plan.digest) {
    setPlanState(owner, planId, 'stale', { note: 'the tree changed since prepare' })
    return {
      state: 'refused',
      code: 'stale',
      reason: `stale plan — the tree changed since prepare (digest ${plan.digest} → ${now.digest}); re-prepare`,
    }
  }

  // Hunk-bearing files: capture the raw worktree patches ONCE (digest-pinned).
  const rawPatches = new Map<string, RawFilePatch>()
  const hunkFiles = plan.groups.flatMap(g => Object.keys(g.hunks ?? {}))
  if (hunkFiles.length > 0) {
    const raw = git(plan.root, ['diff', '--no-color', '--unified=3', '--', ...hunkFiles])
    for (const p of parseRawPatches(raw)) rawPatches.set(p.file, p)
  }

  const commits: NonNullable<GitPlan['commits']> = []
  for (const [index, group] of plan.groups.entries()) {
    if (opts.signal?.aborted) {
      setPlanState(owner, planId, 'failed', {
        note: `cancelled after ${commits.length}/${plan.groups.length} commit(s)`,
        commits,
      })
      return {
        state: 'refused',
        code: 'cancelled',
        reason: `cancelled after ${commits.length} commit(s) — created commits stand, remaining changes untouched`,
        commitsCreated: commits.map(c => ({ sha: c.sha, message: c.message })),
      }
    }
    try {
      // 2. index = HEAD (content untouched), then stage EXACTLY the group.
      git(plan.root, ['reset', '--quiet'])
      for (const file of group.files) {
        const wanted = group.hunks?.[file]
        if (!wanted) {
          git(plan.root, ['add', '--', file])
          continue
        }
        const patch = rawPatches.get(file)
        if (!patch) throw new Error(`no worktree patch for '${file}' (hunk selection)`)
        const chosen = patch.hunks.filter(h => wanted.includes(h.id))
        if (chosen.length !== wanted.length) {
          const missing = wanted.filter(id => !patch.hunks.some(h => h.id === id))
          throw new Error(`hunk id(s) no longer reproduce for '${file}': ${missing.join(', ')}`)
        }
        const patchText = `${[...patch.headerLines, ...chosen.flatMap(h => [h.header, ...h.raw])].join('\n')}\n`
        execFileSync('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
          windowsHide: true,
          cwd: plan.root,
          input: patchText,
          timeout: 30_000,
          env: { ...subprocessEnv() },
        })
      }
      // 3. the staged set must be EXACTLY the group (pre-commit guard).
      const staged = git(plan.root, ['diff', '--cached', '--name-only'])
        .split('\n')
        .filter(Boolean)
        .sort()
      const wantedFiles = [...group.files].sort()
      if (JSON.stringify(staged) !== JSON.stringify(wantedFiles)) {
        throw new Error(`staged set [${staged.join(', ')}] ≠ planned [${wantedFiles.join(', ')}]`)
      }
      if (staged.length === 0) throw new Error('empty staged set — an empty commit is refused')
      // 4. commit, then VERIFY from the created commit itself.
      git(plan.root, ['commit', '--quiet', '--no-verify', '-m', group.message])
      const sha = git(plan.root, ['rev-parse', 'HEAD']).trim()
      const committed = git(plan.root, ['show', '--name-only', '--format=', sha])
        .split('\n')
        .filter(Boolean)
        .sort()
      if (JSON.stringify(committed) !== JSON.stringify(wantedFiles)) {
        setPlanState(owner, planId, 'failed', {
          note: `commit ${sha.slice(0, 8)} contains [${committed.join(', ')}] ≠ planned — STOPPED`,
          commits,
        })
        return {
          state: 'refused',
          code: 'verify',
          reason: `commit ${sha.slice(0, 8)} contains unplanned content ([${committed.join(', ')}] ≠ [${wantedFiles.join(', ')}]) — application STOPPED; created commits stand (history is never rewritten)`,
          commitsCreated: [...commits.map(c => ({ sha: c.sha, message: c.message })), { sha, message: group.message }],
        }
      }
      // 5. one explicit transaction per applied commit, evidence-backed.
      const txn = beginTransaction({
        owner,
        kind: 'git.commit',
        inputRefs: [`mercury://git/plan/${planId}`],
        expectedVersions: [plan.digest],
      })
      const ev = recordCanonicalEvidence({
        owner,
        kind: 'change',
        origin: 'observed',
        claim: `git commit ${sha.slice(0, 8)} created (group ${index + 1}/${plan.groups.length}): ${group.message.split('\n')[0]?.slice(0, 80)} — name-only verified ${committed.length} file(s)`,
        refs: [`mercury://git/commit/${sha}`, `mercury://git/plan/${planId}`],
        details: { sha, files: committed },
      })
      transitionTransaction(owner, txn.id, 'applying')
      transitionTransaction(owner, txn.id, 'applied', {
        effectRef: `mercury://evidence/${ev.id}`,
        resultRefs: [`mercury://git/commit/${sha}`],
      })
      transitionTransaction(owner, txn.id, 'settled')
      commits.push({ sha, message: group.message, files: committed, transactionId: txn.id })
    } catch (err) {
      setPlanState(owner, planId, 'failed', {
        note: `group ${index + 1} failed: ${(err as Error).message.slice(0, 200)}`,
        commits,
      })
      return {
        state: 'refused',
        code: 'io',
        reason: `group ${index + 1}/${plan.groups.length} FAILED (${(err as Error).message.slice(0, 200)}) — ${commits.length} earlier commit(s) stand; working content untouched`,
        commitsCreated: commits.map(c => ({ sha: c.sha, message: c.message })),
      }
    }
  }

  const updated = setPlanState(owner, planId, 'applied', { appliedAt: Date.now(), commits })!
  return { state: 'applied', plan: updated, commits }
}

// ── index operations (stage · restore · resolve) ─────────────────────────────

export interface IndexOpOutcome {
  state: 'ok'
  detail: string
}

export function stageSelection(
  root: string,
  files: string[],
  hunks?: Record<string, string[]>,
): IndexOpOutcome | PlanRefusal {
  if (!isGitRepo(root)) return { state: 'refused', reason: 'not a git repository' }
  if (files.length === 0) return { state: 'refused', reason: 'stage needs files' }
  try {
    for (const file of files) {
      const wanted = hunks?.[file]
      if (!wanted) {
        git(root, ['add', '--', file])
        continue
      }
      const raw = git(root, ['diff', '--no-color', '--unified=3', '--', file])
      const patch = parseRawPatches(raw)[0]
      if (!patch) return { state: 'refused', reason: `'${file}' has no unstaged patch to select hunks from` }
      const chosen = patch.hunks.filter(h => wanted.includes(h.id))
      if (chosen.length !== wanted.length) {
        return { state: 'refused', reason: `hunk id(s) not found for '${file}' — re-inspect hunks (they are content-derived)` }
      }
      const patchText = `${[...patch.headerLines, ...chosen.flatMap(h => [h.header, ...h.raw])].join('\n')}\n`
      execFileSync('git', ['apply', '--cached', '--whitespace=nowarn', '-'], {
        windowsHide: true,
        cwd: root,
        input: patchText,
        timeout: 30_000,
        env: { ...subprocessEnv() },
      })
    }
    const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
    return { state: 'ok', detail: `staged: ${staged.join(', ') || '(nothing)'}` }
  } catch (err) {
    return { state: 'refused', reason: `stage failed: ${(err as Error).message.slice(0, 200)}` }
  }
}

export function restoreStaged(root: string, files: string[]): IndexOpOutcome | PlanRefusal {
  if (!isGitRepo(root)) return { state: 'refused', reason: 'not a git repository' }
  if (files.length === 0) return { state: 'refused', reason: 'restore needs files' }
  try {
    // Index-only: the WORKING COPY is untouched by contract.
    git(root, ['restore', '--staged', '--', ...files])
    return { state: 'ok', detail: `unstaged (working copy untouched): ${files.join(', ')}` }
  } catch (err) {
    return { state: 'refused', reason: `restore failed: ${(err as Error).message.slice(0, 200)}` }
  }
}

export function resolveConflict(
  owner: OwnerKey,
  root: string,
  path: string,
  resolution: { take: 'ours' | 'theirs' } | { content: string },
): IndexOpOutcome | PlanRefusal {
  const status = gitStatus(root)
  if ('state' in status) return { state: 'refused', reason: status.note }
  const entry = status.files.find(f => f.path === path && f.kind === 'unmerged')
  if (!entry) return { state: 'refused', reason: `'${path}' is not an unmerged conflict here` }
  try {
    if ('take' in resolution) {
      git(root, ['checkout', resolution.take === 'ours' ? '--ours' : '--theirs', '--', path])
    } else {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      writeFileSync(join(root, path), resolution.content)
    }
    git(root, ['add', '--', path])
    const ev = recordCanonicalEvidence({
      owner,
      kind: 'change',
      origin: 'observed',
      claim: `conflict '${path}' resolved (${'take' in resolution ? resolution.take : 'explicit content'}) and staged`,
      refs: [`mercury://git/status`],
    })
    return { state: 'ok', detail: `resolved '${path}' — staged; evidence mercury://evidence/${ev.id}` }
  } catch (err) {
    return { state: 'refused', reason: `resolve failed: ${(err as Error).message.slice(0, 200)}` }
  }
}

/** Verify: does the CURRENT tree still match what a plan expects? */
export function verifyPlan(owner: OwnerKey, root: string, planId: string): string {
  const plan = getPlan(owner, planId)
  if (!plan) return `no plan '${planId}' in this conversation`
  const status = gitStatus(root)
  if ('state' in status) return status.note
  if (plan.state === 'applied') {
    const shas = (plan.commits ?? []).map(c => c.sha.slice(0, 8)).join(', ')
    return `${planId} applied — commits: ${shas}; tree digest now ${status.digest} (clean: ${status.clean})`
  }
  return status.digest === plan.digest
    ? `${planId} [${plan.state}] — the tree still matches the plan digest (${plan.digest}); applicable`
    : `${planId} [${plan.state}] — the tree DRIFTED (${plan.digest} → ${status.digest}); application would refuse; re-prepare`
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetGitPlanStoreForTesting(): void {
  store.clearAllForShutdown()
}
