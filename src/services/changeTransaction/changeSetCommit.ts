
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

export type CommitTargetKind = 'write' | 'create' | 'delete'

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
  kind?: CommitTargetKind
}

export interface TextChangeSetPayload {
  v: 1 | 2
  source: string
  planDigest: string
  bundleDir: string
  targets: PayloadTarget[]
}

export interface CommitRequest {
  ownerKey: string
  source: string
  planDigest: string
  targets: CommitTarget[]
  signal?: AbortSignal
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

class ChangeSetDriftBeforeRename extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk after the drift probe and before its rename — refusing to overwrite the newer bytes`)
    this.name = 'ChangeSetDriftBeforeRename'
  }
}

let beforeRenameHookForProofs: ((path: string) => Promise<void> | void) | null = null
export function _setBeforeRenameHookForProofs(hook: ((path: string) => Promise<void> | void) | null): void {
  beforeRenameHookForProofs = hook
}

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
  }
}

async function atomicRestoreBytes(path: string, bytes: Buffer, mode: number): Promise<void> {
  await durableAtomicPublish(path, bytes, { mode })
  await chmod(path, mode).catch(() => {})
}

function fsyncEnabled(): boolean {
  return flagEnv('MERCURY_DURABLE_FSYNC') !== '0'
}

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


export async function runTextChangeSetCommit(req: CommitRequest): Promise<CommitOutcome> {
  const targets = [...req.targets].sort((a, b) =>
    a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0,
  )
  if (targets.length === 0) {
    throw new Error('runTextChangeSetCommit requires at least one changed target')
  }
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
  const ownerKeyStr =
    typeof req.ownerKey === 'string' ? req.ownerKey : JSON.stringify(req.ownerKey)
  const idempotencyKey = `${ownerKeyStr}#${req.planDigest}`

  const release = await acquirePathLocks(targets.map(t => t.canonicalPath))
  const staged: { tmp: string }[] = []
  const driftedBeforeRename: string[] = []
  let compensationIncomplete: ChangeSetCompensationIncomplete | null = null
  try {
    if (req.signal?.aborted) return { kind: 'cancelled' }

    await recoverChangeSetJournal({ journalDir, bundleRoot })

    const diskState: ('original' | 'planned' | 'other')[] = []
    for (const t of targets) {
      const raw = await readOrNull(t.canonicalPath)
      diskState.push(classifyDiskState(t.kind ?? 'write', raw, t.originalDigest, t.plannedDigest))
    }

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

    const stalePaths = targets
      .filter((_, i) => diskState[i] !== 'original')
      .map(t => t.canonicalPath)
    if (stalePaths.length > 0) return { kind: 'stale', stalePaths }
    if (req.signal?.aborted) return { kind: 'cancelled' }

    faultPoint('changeset-before-bundle', bundleRoot)
    const bundleDir = join(bundleRoot, req.planDigest.slice(0, 16))
    const payloadTargets: PayloadTarget[] = []
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!
      const kind = t.kind ?? 'write'
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

    const compensate = async (): Promise<void> => {
      faultPoint('changeset-before-compensate', journalDir)
      const diverged: string[] = []
      const unrestored: Array<{ path: string; reason: string }> = []
      for (const t of [...targets].reverse()) {
        if (driftedBeforeRename.includes(t.canonicalPath)) continue
        const kind = t.kind ?? 'write'
        try {
          const cur = await readOrNull(t.canonicalPath)
          const state = classifyDiskState(kind, cur, t.originalDigest, t.plannedDigest)
          if (state === 'original') continue
          if (state === 'planned') {
            faultPoint('changeset-during-compensate', t.canonicalPath)
            if (kind === 'create') {
              await unlinkQuiet(t.canonicalPath)
              if ((await readOrNull(t.canonicalPath)) !== null) diverged.push(t.canonicalPath)
              continue
            }
            await atomicRestoreBytes(t.canonicalPath, t.originalBytes, t.mode)
            const re = await readFile(t.canonicalPath)
            if (sha256Hex(re) !== t.originalDigest) diverged.push(t.canonicalPath)
            continue
          }
          diverged.push(t.canonicalPath)
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
            const current = await readOrNull(t.canonicalPath)
            if (classifyDiskState(kind, current, t.originalDigest, t.plannedDigest) === 'other') {
              driftedBeforeRename.push(t.canonicalPath)
              throw new ChangeSetDriftBeforeRename(t.canonicalPath)
            }
            if (kind === 'delete') {
              await unlinkWithWin32Retry(t.canonicalPath)
              return { removed: true }
            }
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
    for (const s of staged) await unlinkQuiet(s.tmp)
    if (driftedBeforeRename.length > 0) {
      let othersOriginal = true
      for (const t of targets) {
        if (driftedBeforeRename.includes(t.canonicalPath)) continue
        const cur = await readOrNull(t.canonicalPath)
        if (classifyDiskState(t.kind ?? 'write', cur, t.originalDigest, t.plannedDigest) !== 'original') othersOriginal = false
      }
      if (othersOriginal) return { kind: 'stale', stalePaths: [...driftedBeforeRename] }
    }
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
    }
  }
  terminal.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let removed = 0
  for (const b of terminal.slice(CHANGESET_BOUNDS.bundleKeepTerminal)) {
    try {
      await rm(join(bundleRoot, b.name), { recursive: true, force: true })
      removed++
    } catch {
    }
  }
  return removed
}


export interface VerbatimCommitFile {
  canonicalPath: string
  originalText: string
  plannedText: string
}

export function commitPlanDigest(targets: CommitTarget[]): string {
  const material = JSON.stringify(
    [...targets]
      .sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : 1))
      .map(t => [t.canonicalPath, t.originalDigest, t.plannedDigest]),
  )
  return sha256Hex(material)
}

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

export function _resetChangeSetLocksForTesting(): void {
  pathLocks.clear()
}

export type { DurableOperation as ChangeSetJournalOperation }

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
