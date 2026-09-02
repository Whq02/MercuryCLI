
import { readdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import { safeParseJSON } from '../utils/json.js'

export type LifecycleLane = 'mechanical-debris' | 'semantic-state' | 'daemon-reconciliation'
export type LifecycleKind = 'semantic' | 'cache' | 'lock' | 'claim' | 'temp' | 'log'
export type LifecycleAction = 'remove' | 'compact' | 'rotate' | 'retain' | 'reference'

export interface LifecycleBudget {
  deadlineMs: number
  removalsLeft: number
  now: () => number
}

export interface LifecycleClassReceipt {
  id: string
  visited: number
  removed: number
  retained: number
  failures: Array<{ path: string; code?: string }>
  done: boolean
}

export interface LifecyclePassReceipt {
  receipts: LifecycleClassReceipt[]
  cycleComplete: boolean
  cycleFailures: number
  removed: number
  budgetExhausted: boolean
}

export interface LifecycleClassDecl {
  id: string
  lane: LifecycleLane
  owner: string
  root: string
  kind: LifecycleKind
  liveReference: string
  terminal: string
  retention: string
  debrisPatterns?: string[]
  action: LifecycleAction
  prover: string
  collect?: (budget: LifecycleBudget) => Promise<LifecycleClassReceipt>
}


const DAY_MS = 24 * 60 * 60 * 1000
export const PRESENCE_SEAT_RETENTION_MS = DAY_MS
export const SEMANTIC_RETENTION_MS = 30 * DAY_MS
export const SKELETON_RETENTION_MS = 7 * DAY_MS

const SIDECAR_RE = /\.(claim|restamp|reap)-(\d+)-[0-9a-f]{8}$/

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function contained(root: string, p: string): boolean {
  const r = resolve(root)
  const t = resolve(p)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function overBudget(budget: LifecycleBudget): boolean {
  return budget.now() >= budget.deadlineMs || budget.removalsLeft <= 0
}

async function listDir(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return []
  }
}

async function newestMtimeMs(dir: string, depthLeft: number): Promise<number> {
  let newest = 0
  try {
    newest = (await stat(dir)).mtimeMs
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
  if (depthLeft <= 0) return newest
  for (const entry of await listDir(dir)) {
    const p = join(dir, entry.name)
    if (entry.isDir) {
      newest = Math.max(newest, await newestMtimeMs(p, depthLeft - 1))
    } else {
      try {
        newest = Math.max(newest, (await stat(p)).mtimeMs)
      } catch {
        newest = Number.MAX_SAFE_INTEGER
      }
    }
  }
  return newest
}

async function removePath(
  guardRoot: string,
  p: string,
  kind: 'file' | 'dir',
  receipt: LifecycleClassReceipt,
  budget: LifecycleBudget,
): Promise<void> {
  if (!contained(guardRoot, p)) {
    receipt.failures.push({ path: p, code: 'EGUARD' })
    return
  }
  try {
    if (kind === 'dir') await rm(p, { recursive: true, force: true })
    else await unlink(p)
    receipt.removed++
    budget.removalsLeft--
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') return
    receipt.failures.push({ path: p, ...(code ? { code } : {}) })
  }
}

const emptyReceipt = (id: string): LifecycleClassReceipt => ({
  id,
  visited: 0,
  removed: 0,
  retained: 0,
  failures: [],
  done: false,
})


async function collectLockSidecars(budget: LifecycleBudget): Promise<LifecycleClassReceipt> {
  const receipt = emptyReceipt('lock-sidecar-temps')
  const roots: string[] = []
  try {
    const { daemonDir } = await import('../daemon/controlSocket.js')
    roots.push(daemonDir())
  } catch {
  }
  try {
    const { adoptiveProjectPath } = await import('../utils/projectStoreAdoption.js')
    const { getProjectRoot } = await import('../bootstrap/state.js')
  } catch {
  }
  for (const root of roots) {
    if (overBudget(budget)) return receipt
    for (const entry of await listDir(root)) {
      if (overBudget(budget)) return receipt
      if (entry.isDir) continue
      const m = SIDECAR_RE.exec(entry.name)
      if (!m) continue
      receipt.visited++
      const ownerPid = Number(m[2])
      if (pidAlive(ownerPid)) {
        receipt.retained++
        continue
      }
      await removePath(root, join(root, entry.name), 'file', receipt, budget)
    }
  }
  receipt.done = true
  return receipt
}

async function collectPresenceSeats(budget: LifecycleBudget): Promise<LifecycleClassReceipt> {
  const receipt = emptyReceipt('presence-seats')
  let root: string
  try {
    const { channelsRoot } = await import('../services/mcp/channelsRoot.js')
    root = channelsRoot()
  } catch {
    receipt.done = true
    return receipt
  }
  for (const room of await listDir(root)) {
    if (overBudget(budget)) return receipt
    if (!room.isDir) continue
    const presenceDir = join(root, room.name, 'presence')
    for (const seat of await listDir(presenceDir)) {
      if (overBudget(budget)) return receipt
      if (seat.isDir || !seat.name.endsWith('.json')) continue
      receipt.visited++
      const seatPath = join(presenceDir, seat.name)
      let staleSince = 0
      try {
        const rec = safeParseJSON(await readFile(seatPath, 'utf8'), false) as { ts?: number } | null
        staleSince = typeof rec?.ts === 'number' ? rec.ts : (await stat(seatPath)).mtimeMs
      } catch {
        try {
          staleSince = (await stat(seatPath)).mtimeMs
        } catch {
          continue
        }
      }
      if (budget.now() - staleSince <= PRESENCE_SEAT_RETENTION_MS) {
        receipt.retained++
        continue
      }
      await removePath(root, seatPath, 'file', receipt, budget)
    }
    await rmdir(presenceDir).catch(() => {})
    await rmdir(join(root, room.name)).catch(() => {})
  }
  receipt.done = true
  return receipt
}

async function collectTaskLists(budget: LifecycleBudget): Promise<LifecycleClassReceipt> {
  const receipt = emptyReceipt('task-lists')
  const root = join(getMercuryHome(), 'tasks')
  for (const list of await listDir(root)) {
    if (overBudget(budget)) return receipt
    if (!list.isDir) continue
    receipt.visited++
    const dir = join(root, list.name)
    const newest = await newestMtimeMs(dir, 1)
    if (budget.now() - newest <= SEMANTIC_RETENTION_MS) {
      receipt.retained++
      continue
    }
    await removePath(root, dir, 'dir', receipt, budget)
  }
  receipt.done = true
  return receipt
}

async function collectCrewSkeletons(budget: LifecycleBudget): Promise<LifecycleClassReceipt> {
  const receipt = emptyReceipt('crew-skeletons')
  let root: string
  try {
    const { crewStoreRoot } = await import('../services/crew/identity.js')
    root = crewStoreRoot()
  } catch {
    receipt.done = true
    return receipt
  }
  const sweep = async (dir: string, depthLeft: number): Promise<void> => {
    if (overBudget(budget)) return
    for (const entry of await listDir(dir)) {
      if (overBudget(budget)) return
      if (!entry.isDir) continue
      const p = join(dir, entry.name)
      if (depthLeft > 0) await sweep(p, depthLeft - 1)
      receipt.visited++
      let mtime = Number.MAX_SAFE_INTEGER
      try {
        mtime = (await stat(p)).mtimeMs
      } catch {
        continue
      }
      if (budget.now() - mtime <= SKELETON_RETENTION_MS) {
        receipt.retained++
        continue
      }
      if (!contained(root, p)) {
        receipt.failures.push({ path: p, code: 'EGUARD' })
        continue
      }
      try {
        await rmdir(p)
        receipt.removed++
        budget.removalsLeft--
      } catch {
        receipt.retained++
      }
    }
  }
  await sweep(root, 2)
  receipt.done = true
  return receipt
}

async function collectShellSnapshots(budget: LifecycleBudget): Promise<LifecycleClassReceipt> {
  const receipt = emptyReceipt('shell-snapshots')
  const root = join(getMercuryHome(), 'shell-snapshots')
  for (const entry of await listDir(root)) {
    if (overBudget(budget)) return receipt
    if (entry.isDir || !entry.name.startsWith('snapshot-')) continue
    receipt.visited++
    const p = join(root, entry.name)
    let mtime: number
    try {
      mtime = (await stat(p)).mtimeMs
    } catch {
      continue
    }
    if (budget.now() - mtime <= SEMANTIC_RETENTION_MS) {
      receipt.retained++
      continue
    }
    await removePath(root, p, 'file', receipt, budget)
  }
  receipt.done = true
  return receipt
}


export const LIFECYCLE_MANIFEST: readonly LifecycleClassDecl[] = [
  {
    id: 'crew-obligations',
    lane: 'semantic-state',
    owner: 'src/services/crew/obligations.ts',
    root: '<crew>/obligations-<project>.json',
    kind: 'semantic',
    liveReference:
      "status 'open' — one durable row per unresolved human question (idempotent by ref; per-obligation storage, never per-event: the conversation ring evicts, obligations do not)",
    terminal:
      "status answered/resolved/withdrawn/superseded — exactly-once settlement (the first mutation wins; race losers stay on the bounded attempt ledger)",
    retention:
      'open rows are never dropped; settled rows retain bounded (200, oldest-settled-first) as the answer/receipt history; one bounded JSON per project',
    action: 'retain',
    prover: 'scripts/notifications/prove-durable-obligations.ts',
  },
  {
    id: 'concourse-draft',
    lane: 'semantic-state',
    owner: 'src/services/concourse/concourseSnapshot.ts',
    root: '<config-home>/concourse-draft.json',
    kind: 'semantic',
    liveReference:
      "the concourse's own view state — the new-session strip draft (survives navigation/resize/restart; cleared ONLY by the positive dispatch receipt), the per-session composer drafts and carets, the held and queued dispatch identities, and the parkedCleared marks: the double-x on a PARKED row hides that chat from the board — a view preference, never session truth (the transcript stays; the boot face and /resume still offer it)",
    terminal:
      'the draft clears on the positive concourseDispatch receipt (one bounded string, 4000 chars); a parkedCleared mark stands until the bound sheds it (a chat that runs again paints live regardless)',
    retention: 'ONE bounded JSON (write-through): the draft string, ≤24 session drafts, ≤256 parkedCleared marks — oldest shed at write',
    action: 'retain',
    prover: 'scripts/notifications/prove-concourse-surface-live.ts',
  },
  {
    id: 'notification-dedup',
    lane: 'semantic-state',
    owner: 'src/services/notificationPolicy.ts',
    root: '<config-home>/notification-dedup.json',
    kind: 'semantic',
    liveReference:
      'a row whose (kind, target, destination) may still replay — emission/ack revisions gate re-emission (edge-triggered; an acknowledged revision never re-emits)',
    terminal:
      'superseded by a later revision for the same key, or aged out by the bound',
    retention:
      'ONE bounded map (500 rows, oldest-emission evicted at write — compaction is in-line, no sweeper); obligation-backed signals dedup on the obligation rows instead',
    action: 'retain',
    prover: 'scripts/notifications/prove-notification-policy.ts',
  },
  {
    id: 'concourse-notification-journal',
    lane: 'semantic-state',
    owner: 'src/services/notificationPolicy.ts',
    root: '<config-home>/notification-journal.json',
    kind: 'semantic',
    liveReference:
      'a decided-but-not-yet-replayed lifecycle signal (seq > consumedSeq) — the daemon decides, the visible process replays to the host exactly once ()',
    terminal: 'consumed (seq ≤ consumedSeq) or aged past the row bound',
    retention:
      'ONE bounded FIFO (100 rows, oldest evicted at append; the consumed cursor rides the same file — no sweeper)',
    action: 'retain',
    prover: 'scripts/notifications/prove-notification-policy.ts',
  },
  {
    id: 'concourse-worker-records',
    lane: 'semantic-state',
    owner: 'src/daemon/concourseSupervisor.ts',
    root: '<daemon>/concourse-workers.json',
    kind: 'semantic',
    liveReference:
      'endedAt undefined AND (its roster short is live OR its pid is alive), OR parkedAt set (the operator CLOSED the chat: no runner by intent, the record and transcript stay as a resumable parked row) — reconcileConcourseWorkers converges the rest at daemon boot and never re-states a parked record',
    terminal: 'endedAt set (release, kill, or crash reconciliation — exactly once)',
    retention:
      'terminal records stay as the resumable-session index (re-admission rides --resume); the file is one bounded JSON keyed by the five worker slots',
    action: 'retain',
    prover: 'scripts/notifications/prove-concourse-supervisor.ts',
  },
  {
    id: 'concourse-dispatch-ledger',
    lane: 'semantic-state',
    owner: 'src/daemon/concourseDispatch.ts',
    root: '<daemon>/concourse-dispatches.json',
    kind: 'semantic',
    liveReference:
      'a nonterminal row (queued/starting/working) — the idempotency reservation a replayed clientMessageId re-answers',
    terminal: 'row state terminal per the lifecycle table (failed refusals keep their reason)',
    retention:
      'rows are digest-only receipts (never prompt content) keyed by clientMessageId; bounded by dispatch volume, compaction joins the cleanup lifecycle',
    action: 'retain',
    prover: 'scripts/notifications/prove-concourse-dispatch.ts',
  },
  {
    id: 'launch-milestones',
    lane: 'semantic-state',
    owner: 'src/substrate/launchMilestones.ts',
    root: '<config-home>/launch-milestones.json',
    kind: 'semantic',
    liveReference: "the LAST boot's spine (entry → route-ready → first-frame → input-live) — the doctor's false-exit-0 read ()",
    terminal: 'evicted past the 48-row FIFO (≈8 boots retained)',
    retention: 'bounded FIFO inside one JSON — self-compacting; telemetry only, never a boot dependency',
    action: 'retain',
    prover: 'scripts/notifications/prove-launch-instrumentation.ts',
  },
  {
    id: 'invocation-capability-record',
    lane: 'semantic-state',
    owner: 'src/substrate/invocationRecord.ts',
    root: '<config-home>/invocation-record.json',
    kind: 'semantic',
    liveReference: 'the newest typed invocation rows (shell family, TTY triple, terminal; redaction-safe basenames only) the doctor reads',
    terminal: 'evicted past the 10-row ring',
    retention: 'bounded ring inside one JSON — self-compacting; telemetry only',
    action: 'retain',
    prover: 'scripts/notifications/prove-launch-instrumentation.ts',
  },
  {
    id: 'coordinator-receipt-journal',
    lane: 'semantic-state',
    owner: 'src/services/concourse/coordinatorReceipts.ts',
    root: '<crew>/coordinator-receipt-journal.json',
    kind: 'semantic',
    liveReference:
      'rows with seq > consumedSeq — daemon-side coordinator receipts awaiting the visible fold (pid-stamped, cursor-guarded exactly-once)',
    terminal: 'seq ≤ consumedSeq, or evicted past the 200-row FIFO cap',
    retention: 'bounded FIFO (cap 200) + a consumed cursor in one JSON file — self-compacting',
    action: 'retain',
    prover: 'scripts/notifications/prove-journal-attribution.ts',
  },
  {
    id: 'concourse-collision-evidence',
    lane: 'semantic-state',
    owner: 'src/daemon/concourseSupervisor.ts',
    root: '<daemon>/concourse-collisions.json',
    kind: 'semantic',
    liveReference:
      'the newest rows inside the FIFO cap — typed observed-collision and authored-retention facts the peek scope line and coordinator board read',
    terminal: 'evicted past the 100-row FIFO cap (newest retained)',
    retention: 'bounded FIFO (cap 100) inside one JSON file — self-compacting by construction',
    action: 'retain',
    prover: 'scripts/notifications/prove-concourse-worktrees.ts',
  },
  {
    id: 'concourse-worker-worktrees',
    lane: 'semantic-state',
    owner: 'src/daemon/concourseWorktrees.ts',
    root: '<daemon>/worktrees/<workerId>',
    kind: 'semantic',
    liveReference:
      "its worker record is live (endedAt undefined) — the worker's cwd for a worktree-isolated claim",
    terminal:
      'the worker settled (release or crash reconcile) — reaped under the DIRT LAW: clean/runtime-only removed + pruned; AUTHORED work retained with a typed evidence row, never destroyed',
    retention:
      'authored-dirt worktrees persist deliberately for the operator; the retention is itself the recorded evidence',
    action: 'retain',
    prover: 'scripts/notifications/prove-concourse-worktrees.ts',
  },
  {
    id: 'lock-sidecar-temps',
    lane: 'mechanical-debris',
    owner: 'src/substrate/pidLock.ts',
    root: '<lock homes>/*.{claim,restamp,reap}-<pid>-<hex8>',
    kind: 'temp',
    liveReference: 'the embedded writer pid is alive (its finally-unlink owns the temp)',
    terminal: 'the embedded writer pid is dead',
    retention: 'immediate once dead-owned',
    debrisPatterns: ['*.claim-<pid>-*', '*.restamp-<pid>-*', '*.reap-<pid>-*'],
    action: 'remove',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
    collect: collectLockSidecars,
  },
  {
    id: 'presence-seats',
    lane: 'mechanical-debris',
    owner: 'src/utils/cockpit/presenceLive.ts',
    root: '<channels>/<room>/presence/<seat>.json',
    kind: 'cache',
    liveReference: 'record ts within the 24h seat retention (reads stale-drop at 10s)',
    terminal: 'record ts (or mtime) older than 24h',
    retention: '24h, then collected; emptied presence/room dirs fold away',
    action: 'remove',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
    collect: collectPresenceSeats,
  },
  {
    id: 'shell-snapshots',
    lane: 'mechanical-debris',
    owner: 'src/utils/bash/ShellSnapshot.ts',
    root: '<config>/shell-snapshots/snapshot-<shell>-<ts>-<id>.sh',
    kind: 'cache',
    liveReference: 'mtime within the 30-day window (live sessions source their own fresh bake)',
    terminal: 'mtime past 30 days',
    retention: '30 days (no collector existed before — the class accumulated forever)',
    action: 'remove',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
    collect: collectShellSnapshots,
  },
  {
    id: 'task-lists',
    lane: 'semantic-state',
    owner: 'src/utils/tasks.ts',
    root: '<config>/tasks/<listId>/',
    kind: 'semantic',
    liveReference: 'any write within 30 days (stale in_progress rows read as history, never mutated)',
    terminal: 'quiet past retention',
    retention: '30 days quiet, then collected whole',
    action: 'remove',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
    collect: collectTaskLists,
  },
  {
    id: 'crew-skeletons',
    lane: 'semantic-state',
    owner: 'src/services/crew/identity.ts',
    root: '<config>/crew/**/ (empty dirs only)',
    kind: 'semantic',
    liveReference: 'dir non-empty, or younger than 7 days',
    terminal: 'empty past the skeleton window (rmdir refuses non-empty by construction)',
    retention: '7 days for empty skeletons; records untouched',
    action: 'remove',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
    collect: collectCrewSkeletons,
  },
  {
    id: 'review-artifacts',
    lane: 'semantic-state',
    owner: 'src/utils/artifacts/reviewStore.ts',
    root: '<config>/review-artifacts/<ra-id>/journal.jsonl',
    kind: 'semantic',
    liveReference: 'append-only journal — every version stays byte-identical forever',
    terminal: 'never (prune-exempt BY DECLARATION)',
    retention:
      'pinned; creation policy is the gate — ordinary headless completion mints none, interactive/explicit review mints exactly one',
    action: 'retain',
    prover: 'scripts/golden-journeys/prove-delivery-artifact.ts',
  },
  {
    id: 'session-transcripts-and-blobs',
    lane: 'semantic-state',
    owner: 'src/utils/cleanup.ts',
    root: '<config>/projects/** · errors · mcp-logs · plans · file-history · session-env · debug · images · pastes · worktrees',
    kind: 'semantic',
    liveReference: 'a session transcript (.jsonl) is never auto-deleted; blobs: mtime within cleanupPeriodDays (default 30) or referenced by a live transcript',
    terminal: 'a blob past the cutoff and unreferenced; a transcript only by the operator\'s own act',
    retention: 'transcripts kept for good; blobs and recordings by cleanupPeriodDays (operator-set), swept by the legacy cleanup families',
    action: 'reference',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
  },
  {
    id: 'append-ledgers',
    lane: 'semantic-state',
    owner: 'src/history.ts · src/utils/observability/invocationTrace.ts · src/utils/cache/cacheClock.ts',
    root: '<config>/history.jsonl · mercury-trace.jsonl · projects/<key>/cache-clock/',
    kind: 'log',
    liveReference: 'the flush-death owners buffer + rotate/compact',
    terminal: 'owner-compacted',
    retention: 'owner-declared (rotation/compaction lanes)',
    action: 'reference',
    prover: 'scripts/substrate/prove-ledger-flush-death.ts',
  },
  {
    id: 'durable-publish-temps',
    lane: 'mechanical-debris',
    owner: 'src/substrate/durablePublish.ts',
    root: '<any store>/<name>.<durable temp pattern>',
    kind: 'temp',
    liveReference: 'younger than the recovery age gate',
    terminal: 'orphaned past the age gate',
    retention: 'swept by recoveryOrchestrator (DR-09/10: the .head.json.*.tmp trace lives HERE, not with the lock fix)',
    action: 'reference',
    prover: 'scripts/substrate/prove-recovery-orchestrator.ts',
  },
  {
    id: 'daemon-records',
    lane: 'daemon-reconciliation',
    owner: 'src/daemon/reconcileRecords.ts',
    root: '<daemon dir>/supervisor.json · supervisor.lock · control.key',
    kind: 'lock',
    liveReference: 'supervisor pid alive (conservative on PID reuse — G13)',
    terminal: 'confirmed-dead supervisor',
    retention: 'reconciled at boot with one receipt; logs rotate bounded',
    action: 'reference',
    prover: 'scripts/substrate/prove-daemon-reconcile.ts',
  },
  {
    id: 'crash-reports',
    lane: 'semantic-state',
    owner: 'src/utils/crashReport.ts',
    root: '<config>/crashes/crash-<ts>-<origin>.json',
    kind: 'log',
    liveReference: 'among the newest 20',
    terminal: 'older than the newest 20',
    retention: 'bounded history (KEEP=20, writer-side; prune failures logged — H-17)',
    action: 'rotate',
    prover: 'scripts/substrate/prove-lifecycle-collector.ts',
  },
  {
    id: 'installed-bundles',
    lane: 'semantic-state',
    owner: 'src/services/privateChannel/installLayout.ts',
    root: '<install>/versions/<version>/ · current.txt · previous.txt',
    kind: 'semantic',
    liveReference: 'named by current.txt or previous.txt (rollback target)',
    terminal: 'unreferenced by both pointers',
    retention: 'update-verb owned (H-12: version dirs are semantic state with a DECLARED keep policy, never ambient debris)',
    action: 'reference',
    prover: 'scripts/node-runtime/prove-launchers.ts',
  },
  {
    id: 'operator-identity-key',
    lane: 'semantic-state',
    owner: 'src/substrate/identity/operatorKey.ts',
    root: '<config-home>/identity/operator.json',
    kind: 'semantic',
    liveReference:
      'always — the operator IS this key: the principal id derives from its public half, and every owner compare and signed authorship resolves through it',
    terminal:
      'never while the home lives — deleting it mints a NEW identity (the adoption law bridges only the pre-key hash generations)',
    retention: 'one 0600 file, born once (exclusive create), never rotated, never collected',
    action: 'retain',
    prover: 'scripts/operator-identity/prove-operator-identity.ts',
  },
] as const


interface LifecycleCursor {
  v: 1
  classIndex: number
  cycleFailures: number
  updatedAtMs: number
}

function cursorPath(): string {
  return join(getMercuryHome(), '.lifecycle-cursor.json')
}

async function readCursor(): Promise<LifecycleCursor> {
  try {
    const raw = safeParseJSON(await readFile(cursorPath(), 'utf8'), false) as Partial<LifecycleCursor> | null
    if (raw && raw.v === 1 && typeof raw.classIndex === 'number' && raw.classIndex >= 0) {
      return {
        v: 1,
        classIndex: raw.classIndex,
        cycleFailures: typeof raw.cycleFailures === 'number' ? raw.cycleFailures : 0,
        updatedAtMs: typeof raw.updatedAtMs === 'number' ? raw.updatedAtMs : 0,
      }
    }
  } catch {
  }
  return { v: 1, classIndex: 0, cycleFailures: 0, updatedAtMs: 0 }
}

async function writeCursor(c: LifecycleCursor): Promise<void> {
  try {
    await writeFile(cursorPath(), JSON.stringify(c))
  } catch {
  }
}

let lastPass: (LifecyclePassReceipt & { atMs: number }) | null = null
export function getLifecycleHealth(): (LifecyclePassReceipt & { atMs: number }) | null {
  return lastPass ? { ...lastPass, receipts: lastPass.receipts.map(r => ({ ...r })) } : null
}

const DEFAULT_PASS_BUDGET_MS = 750
const DEFAULT_MAX_REMOVALS = 200

export async function runLifecyclePass(opts?: {
  budgetMs?: number
  maxRemovals?: number
  now?: () => number
}): Promise<LifecyclePassReceipt> {
  const now = opts?.now ?? Date.now
  const budget: LifecycleBudget = {
    deadlineMs: now() + (opts?.budgetMs ?? DEFAULT_PASS_BUDGET_MS),
    removalsLeft: opts?.maxRemovals ?? DEFAULT_MAX_REMOVALS,
    now,
  }
  const collectible = LIFECYCLE_MANIFEST.filter(c => c.collect)
  const cursor = await readCursor()
  if (cursor.classIndex >= collectible.length) {
    cursor.classIndex = 0
    cursor.cycleFailures = 0
  }
  const receipts: LifecycleClassReceipt[] = []
  let removed = 0
  let cycleComplete = false
  let budgetExhausted = false
  let i = cursor.classIndex
  while (i < collectible.length) {
    const decl = collectible[i]!
    let receipt: LifecycleClassReceipt
    try {
      receipt = await decl.collect!(budget)
    } catch (e) {
      receipt = emptyReceipt(decl.id)
      receipt.failures.push({ path: decl.root, code: getErrnoCode(e) ?? 'EUNCAUGHT' })
      receipt.done = true
    }
    receipts.push(receipt)
    removed += receipt.removed
    cursor.cycleFailures += receipt.failures.length
    if (!receipt.done) {
      budgetExhausted = true
      break
    }
    i++
    if (i >= collectible.length) {
      cycleComplete = true
      break
    }
    if (overBudget(budget)) {
      budgetExhausted = true
      break
    }
  }
  const cycleFailures = cursor.cycleFailures
  if (cycleComplete) {
    await writeCursor({ v: 1, classIndex: 0, cycleFailures: 0, updatedAtMs: now() })
  } else {
    await writeCursor({ v: 1, classIndex: i, cycleFailures: cursor.cycleFailures, updatedAtMs: now() })
  }
  const pass: LifecyclePassReceipt = { receipts, cycleComplete, cycleFailures, removed, budgetExhausted }
  lastPass = { ...pass, atMs: now() }
  if (cycleFailures > 0 && cycleComplete) {
    logForDebugging(
      `[lifecycle] cycle completed with ${cycleFailures} failure(s) — sentinel withheld (${receipts
        .flatMap(r => r.failures.slice(0, 2).map(f => `${r.id}:${f.path}${f.code ? ` (${f.code})` : ''}`))
        .join(' · ')})`,
    )
  }
  return pass
}

export async function _resetLifecycleForProofs(): Promise<void> {
  lastPass = null
  await unlink(cursorPath()).catch(() => {})
}
