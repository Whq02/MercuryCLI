// ============================================================================
//  changeTransaction/changeSetCommit — the ONE shared multi-file text commit
//  core. ChangeSet plans through anchored hunks, Structure
//  through its AST planner, LSP through WorkspaceEdit normalization — all
//  three delegate the WRITE mechanics here: deterministic ordered path
//  locks, current-byte revalidation, the durable recovery bundle, durable
//  temp staging, the journaled rename walk, digest-guarded compensation
//  verified by reread, and honest terminal classification.
//
//  The guarantee:
//    1. any revalidation/scope/cancel failure before the first rename
//       writes NOTHING;
//    2. a normal apply reaches the COMPLETE planned state, verified by
//       reread;
//    3. a midway interruption is journaled (kind `text-change-set`) and
//       deterministically reconciled at the next boot;
//    4. compensation restores originals ONLY where current bytes still
//       match the planned output — later bytes are NEVER overwritten; the
//       exact unresolved paths are reported.
//
//  Fault seams (MERCURY_FAULT_INJECT, throw|kill):
//    changeset-before-bundle · changeset-after-stage ·
//    changeset-before-journal · changeset-before-rename ·
//    changeset-during-reread · changeset-before-compensate ·
//    changeset-during-compensate · changeset-recover-op
//    (+ the journal owner's journal-after-prepare / journal-before-step /
//     journal-after-step / journal-before-commit around every step).
// ============================================================================

import { chmod, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { isTransientWin32FsCode, WIN32_RENAME_RETRY_DELAYS_MS } from '../../substrate/durablePublish.js'
import { dirname, join } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  durableAtomicPublish,
  durableTempName,
  faultPoint,
  renameWithWin32Retry,
} from '../../substrate/durablePublish.js'
import {
  compactJournalDir,
  isJournalWriterAlive,
  isTerminalJournalState,
  journalOperationPath,
  listJournalOperations,
  republishJournalOperation,
  runJournaledOperation,
  type DurableOperation,
  type JournalRecoverySummary,
} from '../../substrate/operationJournal.js'
import {
  CHANGESET_BOUNDS,
  changeSetBundleRoot,
  changeSetJournalDir,
} from './changeSetContracts.js'
import { canonicalPathKey, sha256Hex } from './changeSetPlan.js'

export const TEXT_CHANGE_SET_KIND = 'text-change-set'

/** How one target changes. 'write' rewrites existing bytes (the classic
 *  form); 'create' lands planned bytes at a path that must NOT exist;
 *  'delete' removes a path whose bytes must match the original digest. A
 *  file MOVE is a delete at the old path + a create at the new one, inside
 *  ONE walk. */
export type CommitTargetKind = 'write' | 'create' | 'delete'

/** One CHANGED target, exact bytes both sides. For 'create' the original
 *  side is ABSENCE (originalBytes/originalDigest unused); for 'delete' the
 *  planned side is ABSENCE (plannedBytes/plannedDigest unused). */
export interface CommitTarget {
  canonicalPath: string
  originalDigest: string
  plannedDigest: string
  originalBytes: Buffer
  plannedBytes: Buffer
  mode: number
  kind?: CommitTargetKind
}

interface PayloadTarget {
  path: string
  originalDigest: string
  plannedDigest: string
  tmp: string
  mode: number
  bundleFile: string
  /** Absent = 'write' (every v1 record). */
  kind?: CommitTargetKind
}

/** The journal payload — digests and paths ONLY, never file content. v1 is
 *  the all-write form older builds decode; v2 appears exactly when a target
 *  carries a non-write kind (an older build refuses to guess at it and
 *  leaves the record waiting — the honest downgrade). */
export interface TextChangeSetPayload {
  v: 1 | 2
  source: string
  planDigest: string
  bundleDir: string
  targets: PayloadTarget[]
}

export interface CommitRequest {
  ownerKey: string
  /** Which planner produced the set ('changeset' · 'structure' · 'lsp'). */
  source: string
  planDigest: string
  /** CHANGED targets only, in deterministic canonical-path order. */
  targets: CommitTarget[]
  signal?: AbortSignal
  /** Hermetic proof seams. */
  journalDir?: string
  bundleRoot?: string
}

export type CommitOutcome =
  | { kind: 'committed'; changedPaths: string[]; operationId: string }
  | { kind: 'replayed'; changedPaths: string[]; operationId: string }
  | { kind: 'stale'; stalePaths: string[] }
  | { kind: 'cancelled' }
  | { kind: 'in-flight'; operationId: string }
  | { kind: 'failed-restored'; reason: string }
  | { kind: 'indeterminate'; divergedPaths: string[]; landedPaths: string[]; reason: string }

class ChangeSetRereadDivergence extends Error {
  constructor(
    readonly diverged: string[],
    readonly landed: string[],
  ) {
    super(`post-write reread diverged at ${diverged.join(', ')}`)
    this.name = 'ChangeSetRereadDivergence'
  }
}

/** A target whose bytes moved between the drift probe and its own rename
 *  (FN-015 rank 67): an external save inside the staging window. Thrown
 *  from the commit step, it aborts the walk into compensation; the catch
 *  path answers the same stale verdict the pre-staging probe would have. */
class ChangeSetDriftBeforeRename extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk after the drift probe and before its rename — refusing to overwrite the newer bytes`)
    this.name = 'ChangeSetDriftBeforeRename'
  }
}

/** Proof seam: runs before each target's pre-rename revalidation, so the
 *  staging-window drift proof can land an external save from inside the
 *  window. Null in the product. */
let beforeRenameHookForProofs: ((path: string) => Promise<void> | void) | null = null
export function _setBeforeRenameHookForProofs(hook: ((path: string) => Promise<void> | void) | null): void {
  beforeRenameHookForProofs = hook
}

/** Compensation ended with paths not back at their originals — two
 *  classes the user's next action differs on (FN-015 rank 66): paths that
 *  hold LATER bytes nobody may overwrite (settle by hand), and paths whose
 *  restore itself failed (a transient hold, a read-only bit) and still hold
 *  the planned bytes intact (boot recovery, or a retry, settles them). */
class ChangeSetCompensationIncomplete extends Error {
  constructor(
    readonly diverged: string[],
    readonly unrestored: Array<{ path: string; reason: string }> = [],
  ) {
    const parts: string[] = []
    if (unrestored.length > 0) {
      parts.push(
        `compensation could not restore ${unrestored.map(u => `${u.path} (${u.reason})`).join(', ')} — the planned bytes are still in place there`,
      )
    }
    if (diverged.length > 0) {
      parts.push(`${diverged.join(', ')} hold${diverged.length === 1 ? 's' : ''} later bytes nobody may overwrite`)
    }
    super(parts.join('; '))
    this.name = 'ChangeSetCompensationIncomplete'
  }
}

// ── deterministic ordered path locks (in-process) ───────────────────────────
// Every acquirer takes its paths in sorted order, so overlapping sets can
// never deadlock; disjoint sets never wait on each other here. Keys are the
// case-folded canonical form (canonicalPathKey), taken ONCE each: a repeated
// path chained the lock on ITSELF — the second take waited on the first's
// release, which only lands when the whole set returns — so one duplicate
// target wedged the commit forever and every later commit to that path
// queued behind it (FN-015 rank 5).

const pathLocks = new Map<string, Promise<void>>()

async function acquirePathLocks(paths: string[]): Promise<() => void> {
  const sorted = [...new Set(paths.map(canonicalPathKey))].sort()
  const releases: (() => void)[] = []
  for (const p of sorted) {
    const prev = pathLocks.get(p) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(r => {
      release = r
    })
    pathLocks.set(
      p,
      prev.then(
        () => gate,
        () => gate,
      ),
    )
    await prev.catch(() => {})
    releases.push(release)
  }
  return () => {
    for (const r of releases) r()
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* already gone — renamed away or never created */
  }
}

/** Atomic byte write with EXACT mode restoration (chmod after rename —
 *  durableAtomicPublish's open-mode is umask-masked). */
async function atomicRestoreBytes(path: string, bytes: Buffer, mode: number): Promise<void> {
  await durableAtomicPublish(path, bytes, { mode })
  await chmod(path, mode).catch(() => {})
}

function fsyncEnabled(): boolean {
  return flagEnv('MERCURY_DURABLE_FSYNC') !== '0'
}

/** Classify CURRENT disk bytes against one target, kind-aware: 'original' =
 *  the pre-commit state (absence, for a create), 'planned' = the committed
 *  state (absence, for a delete), 'other' = later bytes nobody overwrites. */
function classifyDiskState(
  kind: CommitTargetKind,
  raw: Buffer | null,
  originalDigest: string,
  plannedDigest: string,
): 'original' | 'planned' | 'other' {
  const d = raw === null ? null : sha256Hex(raw)
  switch (kind) {
    case 'create':
      if (raw === null) return 'original'
      return d === plannedDigest ? 'planned' : 'other'
    case 'delete':
      if (raw === null) return 'planned'
      return d === originalDigest ? 'original' : 'other'
    default:
      if (raw === null) return 'other'
      return d === originalDigest ? 'original' : d === plannedDigest ? 'planned' : 'other'
  }
}

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

// ── the commit walk ─────────────────────────────────────────────────────────

/**
 * Commit a fully planned, already-authorized change set. Callers hold their
 * own domain guarantees (anchors/digests/parse guards/permission); this walk
 * owns everything from "locks" to "verified terminal outcome".
 */
export async function runTextChangeSetCommit(req: CommitRequest): Promise<CommitOutcome> {
  // Deterministic commit order regardless of caller order (the same law the
  // lock acquisition uses).
  const targets = [...req.targets].sort((a, b) =>
    a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0,
  )
  if (targets.length === 0) {
    throw new Error('runTextChangeSetCommit requires at least one changed target')
  }
  // One target per file, by the folded key: a set naming one canonical path
  // twice is a caller defect (a planner that did not fold two spellings of a
  // document), refused by name here — the walk below writes each path once
  // and the lock table above holds each key once.
  const seenKeys = new Map<string, string>()
  for (const t of targets) {
    const key = canonicalPathKey(t.canonicalPath)
    const prior = seenKeys.get(key)
    if (prior !== undefined) {
      throw new Error(
        `runTextChangeSetCommit: ${t.canonicalPath} appears more than once in the target set${prior === t.canonicalPath ? '' : ` (also spelled ${prior})`} — fold one file's edits into one target`,
      )
    }
    seenKeys.set(key, t.canonicalPath)
  }
  const journalDir = req.journalDir ?? changeSetJournalDir()
  const bundleRoot = req.bundleRoot ?? changeSetBundleRoot()
  // OwnerKey is canonically a string; a non-string owner (proof harnesses
  // cast objects) must never degrade to '[object Object]' — that would
  // collide DIFFERENT owners onto one idempotency key.
  const ownerKeyStr =
    typeof req.ownerKey === 'string' ? req.ownerKey : JSON.stringify(req.ownerKey)
  const idempotencyKey = `${ownerKeyStr}#${req.planDigest}`

  const release = await acquirePathLocks(targets.map(t => t.canonicalPath))
  const staged: { tmp: string }[] = []
  // The targets whose bytes moved inside the staging window (FN-015 rank
  // 67), recorded by the commit step and read by the catch path below —
  // declared at function scope so the catch can see it: the catch answers
  // stale for them whatever error the journal surfaces (a compensation that
  // leaves the newer bytes in place throws its own incompleteness).
  const driftedBeforeRename: string[] = []
  // The compensation's own verdict when it ends incomplete (FN-015 rank
  // 66): the journal rethrows the ORIGINAL fault and only logs the
  // compensation's throw, so the catch path reads the classes from here.
  let compensationIncomplete: ChangeSetCompensationIncomplete | null = null
  try {
    if (req.signal?.aborted) return { kind: 'cancelled' }

    // Reconcile any dead incomplete change-set ops FIRST — the journal
    // owner's blind dead-writer default must never fire for this kind.
    await recoverChangeSetJournal({ journalDir, bundleRoot })

    // Read every target's CURRENT bytes ONCE, locks held — the same probe
    // feeds replay classification and drift revalidation.
    const diskState: ('original' | 'planned' | 'other')[] = []
    for (const t of targets) {
      const raw = await readOrNull(t.canonicalPath)
      diskState.push(classifyDiskState(t.kind ?? 'write', raw, t.originalDigest, t.plannedDigest))
    }

    // Committed-plan REPLAY is DISK-TRUTH-GUARDED (a prover caught the blind
    // form: after a prior commit, a DRIFTED target replayed success and a
    // pathRename moved the file on top of foreign bytes):
    //   · prior commit + every target still PLANNED ⇒ honest replay;
    //   · prior commit + every target back at ORIGINAL (external revert) ⇒
    //     a REAL new commit — the idempotency key gains an attempt salt so
    //     the journal's own replay cannot claim work it didn't redo;
    //   · anything else falls through to revalidation (⇒ honest stale).
    const priorCommits = (await listJournalOperations(journalDir)).filter(
      o =>
        o.kind === TEXT_CHANGE_SET_KIND &&
        o.state === 'committed' &&
        (o.idempotencyKey === idempotencyKey ||
          o.idempotencyKey.startsWith(idempotencyKey + '#r')),
    )
    let effectiveKey = idempotencyKey
    if (priorCommits.length > 0) {
      if (diskState.every(s => s === 'planned')) {
        const prior = priorCommits[priorCommits.length - 1]!
        const result = prior.result as { changedPaths?: string[] } | undefined
        return {
          kind: 'replayed',
          changedPaths: result?.changedPaths ?? targets.map(t => t.canonicalPath),
          operationId: prior.operationId,
        }
      }
      effectiveKey = `${idempotencyKey}#r${priorCommits.length}`
    }

    // Revalidate EVERY target against CURRENT bytes. Any drift refuses the
    // whole set — nothing staged, nothing written.
    const stalePaths = targets
      .filter((_, i) => diskState[i] !== 'original')
      .map(t => t.canonicalPath)
    if (stalePaths.length > 0) return { kind: 'stale', stalePaths }
    if (req.signal?.aborted) return { kind: 'cancelled' }

    // The durable recovery bundle — originals + manifest published BEFORE
    // any commit step (bytes live in the bundle dir, never in the journal).
    faultPoint('changeset-before-bundle', bundleRoot)
    const bundleDir = join(bundleRoot, req.planDigest.slice(0, 16))
    const payloadTargets: PayloadTarget[] = []
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!
      const kind = t.kind ?? 'write'
      // A 'create' has no original to bundle — its compensation is an unlink.
      const bundleFile = kind === 'create' ? '' : `t${i}.bin`
      if (bundleFile) {
        await durableAtomicPublish(join(bundleDir, bundleFile), t.originalBytes, { mode: 0o600 })
      }
      payloadTargets.push({
        path: t.canonicalPath,
        originalDigest: t.originalDigest,
        plannedDigest: t.plannedDigest,
        tmp: '',
        mode: t.mode,
        bundleFile,
        ...(kind !== 'write' ? { kind } : {}),
      })
    }

    // Stage every planned output beside its target (the durable temp
    // pattern — a crash here leaves only sweeper-owned temps behind).
    // 'delete' targets stage nothing; 'create' targets stage into the
    // destination directory, which must exist before the temp opens.
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!
      const kind = t.kind ?? 'write'
      if (kind === 'delete') {
        faultPoint('changeset-after-stage', t.canonicalPath)
        continue
      }
      if (kind === 'create') {
        await mkdir(dirname(t.canonicalPath), { recursive: true })
      }
      const tmp = durableTempName(t.canonicalPath)
      const fh = await open(tmp, 'wx', t.mode)
      try {
        await fh.writeFile(t.plannedBytes)
        await fh.chmod(t.mode).catch(() => {})
        if (fsyncEnabled()) await fh.sync()
      } finally {
        await fh.close()
      }
      staged.push({ tmp })
      payloadTargets[i]!.tmp = tmp
      faultPoint('changeset-after-stage', t.canonicalPath)
    }
    if (req.signal?.aborted) {
      for (const s of staged) await unlinkQuiet(s.tmp)
      return { kind: 'cancelled' }
    }

    const payload: TextChangeSetPayload = {
      // v1 exactly when every target is a plain write — those records stay
      // byte-decodable by older builds; any create/delete makes it v2.
      v: targets.every(t => (t.kind ?? 'write') === 'write') ? 1 : 2,
      source: req.source,
      planDigest: req.planDigest,
      bundleDir,
      targets: payloadTargets,
    }
    await durableAtomicPublish(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({ ...payload, ownerKey: ownerKeyStr, createdAt: new Date().toISOString() }, null, 2),
    )
    faultPoint('changeset-before-journal', journalDir)

    // Digest-guarded compensation, verified by reread. Restores originals
    // ONLY where current bytes still match the planned output; later bytes
    // are never overwritten — those paths surface as indeterminate (the
    // catch-path disk probe classifies; the throw below keeps the journal
    // record honest for boot recovery).
    const compensate = async (): Promise<void> => {
      faultPoint('changeset-before-compensate', journalDir)
      const diverged: string[] = []
      // Per-target fault isolation (FN-015 rank 66): one restore that throws
      // — a transient editor/indexer/scanner hold past the publish ladder, a
      // read-only bit — used to escape the loop, leaving every not-yet-
      // visited target at its planned bytes with the staged temps in place,
      // and the user told those intact files "differ from both plan and
      // original". A throwing restore is recorded and the walk continues.
      const unrestored: Array<{ path: string; reason: string }> = []
      for (const t of [...targets].reverse()) {
        // Never renamed — the operator's newer bytes stand; nothing to
        // compensate and nothing to report as diverged (FN-015 rank 67).
        if (driftedBeforeRename.includes(t.canonicalPath)) continue
        const kind = t.kind ?? 'write'
        try {
          const cur = await readOrNull(t.canonicalPath)
          const state = classifyDiskState(kind, cur, t.originalDigest, t.plannedDigest)
          if (state === 'original') continue // untouched (absence, for a create)
          if (state === 'planned') {
            faultPoint('changeset-during-compensate', t.canonicalPath)
            if (kind === 'create') {
              // The planned bytes landed at a path that must return to absence.
              await unlinkQuiet(t.canonicalPath)
              if ((await readOrNull(t.canonicalPath)) !== null) diverged.push(t.canonicalPath)
              continue
            }
            // write: planned bytes present → restore originals.
            // delete: the path is absent → restore originals.
            await atomicRestoreBytes(t.canonicalPath, t.originalBytes, t.mode)
            const re = await readFile(t.canonicalPath)
            if (sha256Hex(re) !== t.originalDigest) diverged.push(t.canonicalPath)
            continue
          }
          diverged.push(t.canonicalPath) // later bytes — never overwritten
        } catch (restoreError) {
          unrestored.push({ path: t.canonicalPath, reason: (restoreError as Error).message })
        }
      }
      for (const s of staged) await unlinkQuiet(s.tmp)
      if (diverged.length > 0 || unrestored.length > 0) {
        compensationIncomplete = new ChangeSetCompensationIncomplete(diverged, unrestored)
        throw compensationIncomplete
      }
    }

    const outcome = await runJournaledOperation<{ changedPaths: string[] }>({
      journalDir,
      ownerKey: ownerKeyStr,
      kind: TEXT_CHANGE_SET_KIND,
      idempotencyKey: effectiveKey,
      payload,
      steps: [
        ...targets.map((t, i) => ({
          id: `commit-${i}`,
          target: t.canonicalPath,
          run: async () => {
            const kind = t.kind ?? 'write'
            faultPoint('changeset-before-rename', t.canonicalPath)
            if (beforeRenameHookForProofs !== null) await beforeRenameHookForProofs(t.canonicalPath)
            // Revalidate against CURRENT bytes immediately before the rename
            // (FN-015 rank 67): the single probe ran before staging, and the
            // window from there to this rename — one fsynced temp per file,
            // the bundle, the manifest, the journal lock and the prepared
            // record — is wide on a slow disk. An editor save, a formatter
            // or a watch-mode generator landing inside it was overwritten
            // by the planned bytes and reported as a clean success. Bytes
            // that are neither the original nor the planned (a replay's own
            // landed rename is fine) are drift: abort into compensation.
            const current = await readOrNull(t.canonicalPath)
            if (classifyDiskState(kind, current, t.originalDigest, t.plannedDigest) === 'other') {
              driftedBeforeRename.push(t.canonicalPath)
              throw new ChangeSetDriftBeforeRename(t.canonicalPath)
            }
            if (kind === 'delete') {
              // The bundle already holds the verified original bytes. The same
              // win32 bounded-retry law as the write step three lines below: a
              // transient AV/indexer/editor hold on the file returns EPERM/EBUSY,
              // and a bare unlink aborted the whole settlement into compensation
              // for a lock that clears inside a third of a second (TASK-017 S2,
              // changeset-delete-skips-win32-lock-law).
              await unlinkWithWin32Retry(t.canonicalPath)
              return { removed: true }
            }
            // The win32 bounded-retry law: a transient AV/indexer
            // lock on ONE target must not abort the whole settlement into
            // compensation — the staged temp stays valid between attempts.
            await renameWithWin32Retry(payloadTargets[i]!.tmp, t.canonicalPath)
            return { digest: t.plannedDigest.slice(0, 16) }
          },
        })),
        {
          id: 'verify',
          target: 'reread-verify',
          run: async () => {
            const diverged: string[] = []
            const landed: string[] = []
            for (const t of targets) {
              faultPoint('changeset-during-reread', t.canonicalPath)
              const re = await readOrNull(t.canonicalPath)
              const state = classifyDiskState(t.kind ?? 'write', re, t.originalDigest, t.plannedDigest)
              if (state === 'planned') landed.push(t.canonicalPath)
              else diverged.push(t.canonicalPath)
            }
            if (diverged.length > 0) throw new ChangeSetRereadDivergence(diverged, landed)
          },
        },
      ],
      compensate,
      result: () => ({ changedPaths: targets.map(t => t.canonicalPath) }),
    })

    if (outcome.outcome === 'in-flight') {
      for (const s of staged) await unlinkQuiet(s.tmp)
      return { kind: 'in-flight', operationId: outcome.operationId }
    }
    if (outcome.outcome === 'replayed') {
      for (const s of staged) await unlinkQuiet(s.tmp)
      return {
        kind: 'replayed',
        changedPaths: outcome.result?.changedPaths ?? targets.map(t => t.canonicalPath),
        operationId: outcome.operationId,
      }
    }
    await compactChangeSetBundles(bundleRoot, journalDir)
    return {
      kind: 'committed',
      changedPaths: targets.map(t => t.canonicalPath),
      operationId: outcome.operationId,
    }
  } catch (e) {
    // Terminal classification by DISK TRUTH, never by bookkeeping flags — a
    // crash mid-compensation must not read as "fully restored". Probe every
    // target against both digests:
    //   · all originals            ⇒ failed (complete restoration, verified);
    //   · any path matching NEITHER ⇒ indeterminate, exact diverged paths;
    //   · planned bytes remaining  ⇒ indeterminate (KNOWN-written paths;
    //     boot recovery settles them — the journal record is retained).
    for (const s of staged) await unlinkQuiet(s.tmp)
    if (driftedBeforeRename.length > 0) {
      // The drifted path keeps the newer bytes (compensation never
      // overwrites them, and reports it as diverged — which is exactly the
      // drift). When every OTHER target is back at its original the verdict
      // is the drift probe's own — stale, naming the path — never an
      // indeterminate apply (FN-015 rank 67).
      let othersOriginal = true
      for (const t of targets) {
        if (driftedBeforeRename.includes(t.canonicalPath)) continue
        const cur = await readOrNull(t.canonicalPath)
        if (classifyDiskState(t.kind ?? 'write', cur, t.originalDigest, t.plannedDigest) !== 'original') othersOriginal = false
      }
      if (othersOriginal) return { kind: 'stale', stalePaths: [...driftedBeforeRename] }
    }
    // The fault that aborted the walk, and — when the compensation ended
    // incomplete — its own two-class sentence beside it: which paths could
    // not be restored (errno, planned bytes intact) and which hold later
    // bytes nobody may overwrite.
    const failure = (e as Error).message
    const reason =
      compensationIncomplete !== null && compensationIncomplete !== e
        ? `${failure} — ${compensationIncomplete.message}`
        : failure
    const landed: string[] = []
    const diverged: string[] = []
    let allOriginal = true
    for (const t of targets) {
      const cur = await readOrNull(t.canonicalPath)
      const state = classifyDiskState(t.kind ?? 'write', cur, t.originalDigest, t.plannedDigest)
      if (state === 'original') continue
      allOriginal = false
      if (state === 'planned') landed.push(t.canonicalPath)
      else diverged.push(t.canonicalPath)
    }
    if (allOriginal) {
      return {
        kind: 'failed-restored',
        reason: `${reason} — every touched path verified back at its original bytes`,
      }
    }
    return {
      kind: 'indeterminate',
      divergedPaths: diverged,
      landedPaths: landed,
      reason:
        diverged.length > 0
          ? reason
          : `${reason} — compensation incomplete; boot recovery will settle the remaining path(s)`,
    }
  } finally {
    release()
  }
}

// ── boot/startup recovery (the deterministic tri-state walker) ──────────────

function decodePayload(raw: unknown): TextChangeSetPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<TextChangeSetPayload>
  if (
    (p.v !== 1 && p.v !== 2) ||
    typeof p.planDigest !== 'string' ||
    typeof p.bundleDir !== 'string' ||
    !Array.isArray(p.targets) ||
    p.targets.some(
      t =>
        !t ||
        typeof t.path !== 'string' ||
        typeof t.originalDigest !== 'string' ||
        typeof t.plannedDigest !== 'string' ||
        (t.kind !== undefined && t.kind !== 'write' && t.kind !== 'create' && t.kind !== 'delete'),
    )
  ) {
    return null
  }
  return p as TextChangeSetPayload
}

type ReconcileVerdict =
  | { kind: 'roll-forward' }
  | { kind: 'compensated'; note: string }
  | { kind: 'unresolved'; note: string }

/** Disk-truth reconciliation (the brief's startup law):
 *    · every target matches planned  ⇒ roll forward (commit marker);
 *    · a strict subset matches planned, the rest match originals ⇒
 *      compensate the applied subset from the bundle, verified by reread;
 *    · any target matches NEITHER digest ⇒ unresolved — later bytes are
 *      left untouched, temps and bundle retained as evidence. */
async function reconcileFromPayload(p: TextChangeSetPayload): Promise<ReconcileVerdict> {
  const states: ('planned' | 'original' | 'other')[] = []
  for (const t of p.targets) {
    const cur = await readOrNull(t.path)
    states.push(classifyDiskState(t.kind ?? 'write', cur, t.originalDigest, t.plannedDigest))
  }
  if (states.includes('other')) {
    const paths = p.targets.filter((_, i) => states[i] === 'other').map(t => t.path)
    return {
      kind: 'unresolved',
      note: `unresolved: bytes at ${paths.join(', ')} match neither the original nor the planned output — recovery will not overwrite them; re-read those files and settle by hand (bundle retained: ${p.bundleDir})`,
    }
  }
  // Staged temps of the dead writer are not needed on either settled
  // branch (roll-forward already renamed them; compensation discards them).
  for (const t of p.targets) {
    if (t.tmp) await unlinkQuiet(t.tmp)
  }
  if (states.every(s => s === 'planned')) return { kind: 'roll-forward' }
  const restored: string[] = []
  for (let i = p.targets.length - 1; i >= 0; i--) {
    if (states[i] !== 'planned') continue
    const t = p.targets[i]!
    const kind = t.kind ?? 'write'
    if (kind === 'create') {
      // Committed state is presence-of-planned-bytes; compensation returns
      // the path to absence — no bundle entry exists or is needed.
      faultPoint('changeset-during-compensate', t.path)
      await unlinkQuiet(t.path)
      if ((await readOrNull(t.path)) !== null) {
        return { kind: 'unresolved', note: `compensation of created ${t.path} did not verify (still present)` }
      }
      restored.push(t.path)
      continue
    }
    let orig: Buffer
    try {
      orig = await readFile(join(p.bundleDir, t.bundleFile))
    } catch (e) {
      return {
        kind: 'unresolved',
        note: `bundle entry for ${t.path} unreadable (${(e as Error).message}) — retained for inspection`,
      }
    }
    if (sha256Hex(orig) !== t.originalDigest) {
      return { kind: 'unresolved', note: `bundle entry for ${t.path} does not verify — retained for inspection` }
    }
    faultPoint('changeset-during-compensate', t.path)
    await atomicRestoreBytes(t.path, orig, t.mode)
    const re = await readFile(t.path)
    if (sha256Hex(re) !== t.originalDigest) {
      return { kind: 'unresolved', note: `restoration of ${t.path} did not verify by reread` }
    }
    restored.push(t.path)
  }
  return {
    kind: 'compensated',
    note: `writer died mid-operation; ${restored.length} applied path(s) restored to verified originals`,
  }
}

export interface ChangeSetRecoveryOptions {
  journalDir?: string
  bundleRoot?: string
}

/**
 * Deterministic, idempotent startup/resume recovery for the change-set
 * journal. Safe to re-run any number of times and safe if interrupted —
 * every decision derives from CURRENT disk digests, transitions are durable
 * republishes through the journal format owner, and unresolved records
 * (later bytes) are preserved untouched with their evidence.
 */
export async function recoverChangeSetJournal(
  opts: ChangeSetRecoveryOptions = {},
): Promise<JournalRecoverySummary> {
  const journalDir = opts.journalDir ?? changeSetJournalDir()
  const bundleRoot = opts.bundleRoot ?? changeSetBundleRoot()
  const summary: JournalRecoverySummary = {
    scanned: 0,
    rolledForward: [],
    compensated: [],
    waiting: [],
    unrecoverable: [],
  }
  const ops = (await listJournalOperations(journalDir)).filter(o => o.kind === TEXT_CHANGE_SET_KIND)
  for (const op of ops) {
    summary.scanned++
    if (isTerminalJournalState(op.state)) continue
    if (isJournalWriterAlive(op)) {
      summary.waiting.push(op.operationId)
      continue
    }
    const payload = decodePayload(op.payload)
    if (!payload) {
      // A record this build cannot decode is never guessed at.
      summary.waiting.push(op.operationId)
      continue
    }
    try {
      faultPoint('changeset-recover-op', journalOperationPath(journalDir, op.operationId))
      const verdict = await reconcileFromPayload(payload)
      if (verdict.kind === 'roll-forward') {
        await republishJournalOperation(journalDir, {
          ...op,
          state: 'committed',
          steps: op.steps.map(s => ({ ...s, state: 'applied' as const })),
          result: { changedPaths: payload.targets.map(t => t.path) },
        })
        summary.rolledForward.push(op.operationId)
      } else if (verdict.kind === 'compensated') {
        await republishJournalOperation(journalDir, {
          ...op,
          state: 'aborted',
          failure: verdict.note,
          steps: op.steps.map(s => (s.state === 'applied' ? { ...s, state: 'compensated' as const } : s)),
        })
        summary.compensated.push(op.operationId)
      } else {
        if (op.failure !== verdict.note) {
          await republishJournalOperation(journalDir, { ...op, failure: verdict.note })
        }
        summary.unrecoverable.push(op.operationId)
      }
    } catch {
      summary.unrecoverable.push(op.operationId)
    }
  }
  await compactJournalDir(journalDir).catch(() => {})
  await compactChangeSetBundles(bundleRoot, journalDir).catch(() => {})
  return summary
}

/** Bounded terminal-bundle retention: bundles whose operation is still
 *  incomplete are ALWAYS retained; settled bundles keep the newest
 *  {@link CHANGESET_BOUNDS.bundleKeepTerminal} and older ones are removed. */
export async function compactChangeSetBundles(
  bundleRoot: string,
  journalDir: string,
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(bundleRoot)
  } catch {
    return 0
  }
  const ops = await listJournalOperations(journalDir)
  const liveDigests = new Set<string>()
  for (const op of ops) {
    if (op.kind !== TEXT_CHANGE_SET_KIND || isTerminalJournalState(op.state)) continue
    const payload = decodePayload(op.payload)
    if (payload) liveDigests.add(payload.planDigest.slice(0, 16))
  }
  const terminal: { name: string; mtimeMs: number }[] = []
  for (const name of names) {
    if (liveDigests.has(name)) continue
    try {
      terminal.push({ name, mtimeMs: (await stat(join(bundleRoot, name))).mtimeMs })
    } catch {
      /* raced */
    }
  }
  terminal.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let removed = 0
  for (const b of terminal.slice(CHANGESET_BOUNDS.bundleKeepTerminal)) {
    try {
      await rm(join(bundleRoot, b.name), { recursive: true, force: true })
      removed++
    } catch {
      /* raced */
    }
  }
  return removed
}

// ── the verbatim adapter (Structure/LSP planners → the shared core) ─────────

/** One file of a verbatim utf8 commit: the planner computed EXACT output
 *  text against an EXACT current snapshot. */
export interface VerbatimCommitFile {
  canonicalPath: string
  originalText: string
  plannedText: string
}

/** Content-addressed digest of a commit plan (sorted path+digest material —
 *  deterministic regardless of caller order or object-key order). */
export function commitPlanDigest(targets: CommitTarget[]): string {
  const material = JSON.stringify(
    [...targets]
      .sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : 1))
      .map(t => [t.canonicalPath, t.originalDigest, t.plannedDigest]),
  )
  return sha256Hex(material)
}

/**
 * Commit a set of exact utf8 text replacements through the shared walk.
 * Structure keeps its AST planning + parse guards, LSP keeps WorkspaceEdit
 * normalization + server stabilization — the write/revalidate/stage/journal/
 * compensate/reread mechanics live HERE, once.
 */
export async function runVerbatimTextCommit(opts: {
  ownerKey: string
  source: string
  files: VerbatimCommitFile[]
  signal?: AbortSignal
  journalDir?: string
  bundleRoot?: string
}): Promise<CommitOutcome> {
  const targets: CommitTarget[] = []
  for (const f of opts.files) {
    const originalBytes = Buffer.from(f.originalText, 'utf8')
    const plannedBytes = Buffer.from(f.plannedText, 'utf8')
    let mode = 0o644
    try {
      mode = (await stat(f.canonicalPath)).mode & 0o7777
    } catch {
      /* revalidation inside the walk will surface a vanished file as stale */
    }
    targets.push({
      canonicalPath: f.canonicalPath,
      originalDigest: sha256Hex(originalBytes),
      plannedDigest: sha256Hex(plannedBytes),
      originalBytes,
      plannedBytes,
      mode,
    })
  }
  return runTextChangeSetCommit({
    ownerKey: opts.ownerKey,
    source: opts.source,
    planDigest: commitPlanDigest(targets),
    targets,
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.journalDir !== undefined && { journalDir: opts.journalDir }),
    ...(opts.bundleRoot !== undefined && { bundleRoot: opts.bundleRoot }),
  })
}

/** TEST-ONLY: drain the in-process path-lock table between proof cases. */
export function _resetChangeSetLocksForTesting(): void {
  pathLocks.clear()
}

export type { DurableOperation as ChangeSetJournalOperation }

/** unlink with the owner's win32 transient-lock ladder (durablePublish's
 *  50/100/200ms), for the change-set delete step. */
async function unlinkWithWin32Retry(path: string): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await unlink(path)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const delay = WIN32_RENAME_RETRY_DELAYS_MS[attempt]
      if (process.platform !== 'win32' || !isTransientWin32FsCode(code) || delay === undefined) throw e
      attempt++
      await new Promise(r => setTimeout(r, delay))
    }
  }
}
