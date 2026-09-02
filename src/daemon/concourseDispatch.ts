// ============================================================================
//  concourseDispatch —.4: idempotent prompt-to-session
// dispatch, composed over the supervisor's admission and the
//  roster's stdin delivery.
//
//  The crew clientMessageId law, applied at THIS owner: the caller supplies
//  a stable client idempotency identity; the RESERVATION is one durable
//  store mutation (the ledger row written 'queued' BEFORE any worker or
//  provider use), and a replay of the same id returns the SAME receipt —
//  never a second admission, never a second delivery. A replay whose prompt
//  digest differs is a MATERIAL EDIT and refuses (a new message needs a new
//  id). The ledger stores the prompt's DIGEST only (the shape-only-digest
//  law — dispatch content lives in the worker's own transcript, exactly
//  once).
//
// Receipts speak the vocabulary through the ONE adjudicator
//  (decideTransition): accepted ⇒ 'queued' (durable-queue-receipt = the
//  reservation write) → 'starting' (start-attempt receipt = admission ok) →
//  'working' (positive worker-start receipt = the stdin frame written and
//  the turn armed). Refusals settle 'failed' with the reason; the CALLER's
//  draft is preserved by construction (this owner never consumed it — the
//  prompt rides only into the admitted worker).
// ============================================================================
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { logForDebugging } from '../utils/debug.js'
import { daemonDir } from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'
import { decideTransition, type ConcourseSessionState } from './concourseLifecycle.js'
import {
  canonicalWorkspaceId,
  resolveDefaultedAdmission,
  readSessionWorkers,
  recordCollisionEvidence,
  type ConcourseAdmitRequest,
  type ConcourseAdmitResult,
  type ConcourseMoveV1,
} from './concourseSupervisor.js'
import { workspaceKindOf } from './concourseWorktrees.js'
import { isolationAwarenessNote } from './isolationNote.js'

export interface ConcourseDispatchRecordV1 {
  schema: 1
  clientMessageId: string
  /** sha256 of the prompt text — replay comparison only, never content. */
  promptDigest: string
  /** sha256 over the COMPLETE target + seed envelope (advisor item 8):
   *  prompt, canonical workspace, target session, isolation, model, title,
   *  agent, seats — a seed edit under a replayed id is a material edit.
   *  Schema-additive: pre-field rows compare promptDigest alone. */
  envelopeDigest?: string
  state: ConcourseSessionState
  stateRevision: number
  acceptedAt: number
  /** The dispatch LEDGER's own persisted grammar keeps the workerId
   *  spelling (it is not the session-record schema R2 renamed); writers
   *  map the record's runnerId onto it. */
  workerId?: string
  sessionId?: string
  /** Present once settled (failed refusals carry the reason). */
  reason?: string
  deliveredAt?: number
  /** (the delivery valve): a redirect refused because its target was
   *  PAUSED holds here — the row stays 'queued' (never failed) so a replay
   *  of the same id + content after resume RE-ATTEMPTS delivery. The ledger
   *  stores no content (the digest law): the caller re-supplies it. RETRYABLE
   *  admission refusals (runtime-ceiling · workspace-collision) hold here
   *  too — the board paints them as QUEUED rows; a replay re-attempts
   *  admission. */
  heldReason?: string
  /** The main-checkout holder's title when heldReason is 'repo-held'
   *  — resolved at hold time so every surface names the actual holder. */
  heldByTitle?: string
  /** Display metadata for the QUEUED board fold (never prompt content —
   *  the digest law stands): the op's title + canonical workspace. */
  title?: string
  workspaceId?: string
  /** Attribution origin (3-3-3 challenge): WHO minted the dispatch —
   *  'operator' for the operator's own doors (composer, attach, redirect,
   *  answer), the coordinator seat id for lane-minted deliveries. The
   *  attached surface's [user]/[coordinator] plates read THIS, never an id
   *  prefix (no prefix rule is sound — the operator and the lane share the
   *  redirect/answer doors). Absent on pre-field rows. */
  by?: string
  /** Drive-11: an
   *  ADMISSION-held launch keeps its complete re-dispatch envelope so the
   *  DAEMON replays it the moment its block clears (git-ready today) —
   *  a held row is pending work, not a receipt. Scrubbed wherever the hold
   *  lifts (admit, fail, supersede, replay re-entry): settled rows stay
   *  digest-only, so the digest law holds for everything at rest. */
  heldOp?: HeldOpEnvelopeV1
}

/** The verbatim envelope a daemon-side replay re-supplies. Field set mirrors
 *  envelopeDigestOf exactly — a replay must hash to the SAME envelope or the
 *  idempotency door refuses it as an edit. */
export interface HeldOpEnvelopeV1 {
  prompt: string
  workspaceDir: string
  isolation?: string
  modelKey?: string
  effort?: string
  title?: string
  agentName?: string
  seatsMax?: 1 | 2
  resumeSessionId?: string
  by?: string
  permissionMode?: string
  runnerArgv?: string[]
  /** The saved preset the held launch named: the daemon-side
   *  replay re-supplies it — a held preset launch must never replay as a
   *  silent menu-default birth (the closed-roster poison). */
  kitPreset?: string
}

interface DispatchFileV1 {
  version: 1
  dispatches: Record<string, ConcourseDispatchRecordV1>
}

export function concourseDispatchesPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-dispatches.json')
}

/** The typed hold vocabulary — every painted surface
 *  branches on THIS, never on prose. 'seat' and 'repo-held' are different
 *  truths and must never blur again. */
export type ConcourseHoldReason =
  | 'seat'
  | 'repo-held'
  | 'session-paused'
  | 'session-with-you'
  | 'no-repository'
  | 'git-unavailable'
  | 'unborn-head'

/** Folds legacy free-string holds ('runtime-ceiling', 'workspace-collision')
 *  at read — a daemon restart must never drop or mis-speak queued rows. */
export function normalizeHoldReason(raw: string | undefined): ConcourseHoldReason | undefined {
  if (raw === undefined) return undefined
  if (raw === 'runtime-ceiling' || raw === 'seat') return 'seat'
  if (raw === 'workspace-collision' || raw === 'repo-held') return 'repo-held'
  if (
    raw === 'session-paused' ||
    raw === 'session-with-you' ||
    raw === 'no-repository' ||
    raw === 'git-unavailable' ||
    raw === 'unborn-head'
  )
    return raw
  return 'seat'
}

// ── FN-020 row 3: the ledger off the per-message hot path ────────────────
// Every Enter is a sessionDispatch RPC answered by the handler below, which
// used to re-read and re-parse the WHOLE ledger from disk per message
// although the promise-chain mutex already serializes every mutation. The
// parsed ledger is memoized per path and validated by a stat stamp
// (ino · mtimeMs · size — every publish is a temp+rename, so the inode
// moves too) on every read: an in-process publish refreshes the memo with
// the very map it wrote, and the one out-of-process writer (the UI's
// daemon-less withdraw fallback, ConcourseRoute) is seen on the next read
// because its rename moves the stamp. The map handed out IS this process's
// live copy of the ledger: writers mutate it and publish; readers never
// mutate it (audited: every reader outside this module is read-only).
interface LedgerMemo {
  stamp: string
  map: Record<string, ConcourseDispatchRecordV1>
}
const ledgerMemo = new Map<string, LedgerMemo>()

function ledgerStamp(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

export function readConcourseDispatches(dir?: string): Record<string, ConcourseDispatchRecordV1> {
  const path = concourseDispatchesPath(dir)
  const stamp = ledgerStamp(path)
  if (stamp === null) {
    ledgerMemo.delete(path)
    return {}
  }
  const memo = ledgerMemo.get(path)
  if (memo !== undefined && memo.stamp === stamp) return memo.map
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DispatchFileV1
    if (!raw || raw.version !== 1 || typeof raw.dispatches !== 'object') {
      ledgerMemo.delete(path)
      return {}
    }
    for (const rec of Object.values(raw.dispatches)) {
      const n = normalizeHoldReason(rec.heldReason)
      if (n !== undefined && rec.heldReason !== n) rec.heldReason = n
    }
    ledgerMemo.set(path, { stamp, map: raw.dispatches })
    return raw.dispatches
  } catch {
    ledgerMemo.delete(path)
    return {}
  }
}

// The post-delivery 'working' publish rides AFTER the RPC reply (row 3b):
// one scheduled sync publish per path, coalesced, event-loop-ordered with
// every other publish so the on-disk sequence of states is a subsequence of
// the in-memory sequence in order. A sync publish of the same map that
// lands first makes the scheduled one redundant and clears it. The window
// in which a delivered message's row still reads 'starting' on disk widens
// from sub-millisecond to one event-loop turn; the recovery semantics for a
// 'starting' row are unchanged in kind (boot reconcile settles by the
// worker's own record).
interface DeferredPublish {
  map: Record<string, ConcourseDispatchRecordV1>
  done: Promise<void>
}
const deferredPublish = new Map<string, DeferredPublish>()

function publishDispatchesAfterReply(dispatches: Record<string, ConcourseDispatchRecordV1>, dir?: string): void {
  const path = concourseDispatchesPath(dir)
  const pending = deferredPublish.get(path)
  if (pending !== undefined && pending.map === dispatches) return
  const entry: DeferredPublish = { map: dispatches, done: Promise.resolve() }
  entry.done = new Promise<void>(resolve => {
    setImmediate(() => {
      if (deferredPublish.get(path) === entry) {
        deferredPublish.delete(path)
        try {
          publishDispatches(dispatches, dir)
        } catch (err) {
          // The failed publish dropped the memo: the next read re-parses
          // the disk, exactly what the pre-memo code served after a failed
          // post-delivery publish. Never silent.
          logForDebugging(`[concourse/dispatch] deferred ledger publish failed for ${path}: ${err}`)
        }
      }
      resolve()
    })
  })
  deferredPublish.set(path, entry)
}

/** Proof seam and shutdown courtesy: resolves once every scheduled
 *  after-reply publish has run (or been superseded). */
export async function flushDeferredDispatchPublishes(): Promise<void> {
  await Promise.all([...deferredPublish.values()].map(e => e.done))
}

function publishDispatches(dispatches: Record<string, ConcourseDispatchRecordV1>, dir?: string): void {
  // R7 C-HIGH-2 (ledger GC): the file grew one row per message ever sent.
  // Settled rows (terminal state, no hold) beyond the newest 200 prune at
  // publish; live rows (queued/starting/held) are never touched. 200 keeps
  // the idempotency window far wider than any real replay (retry presses,
  // crash replays — seconds, not epochs).
  const settled = Object.values(dispatches)
    .filter(r => (r.state === 'failed' || r.state === 'working') && r.heldReason === undefined)
    .sort((a, b) => b.acceptedAt - a.acceptedAt)
  for (const stale of settled.slice(200)) delete dispatches[stale.clientMessageId]
  // DURABILITY: the ONE publication primitive (fsync'd temp → atomic
  // rename → dir fsync, win32 retry, boot-swept orphans) — bytes
  // identical to the hand-rolled writer it replaced.
  const path = concourseDispatchesPath(dir)
  try {
    durableAtomicPublishSync(
      path,
      `${JSON.stringify({ version: 1, dispatches } satisfies DispatchFileV1, null, 1)}\n`,
    )
  } catch (err) {
    // A write that did not land leaves the memo nothing true to serve:
    // the next read re-parses the disk (the pre-memo discard-on-failure
    // semantics, kept exactly).
    ledgerMemo.delete(path)
    throw err
  }
  // The memo is the map just written, stamped by the file it became.
  const stamp = ledgerStamp(path)
  if (stamp !== null) ledgerMemo.set(path, { stamp, map: dispatches })
  else ledgerMemo.delete(path)
  const pending = deferredPublish.get(path)
  if (pending !== undefined && pending.map === dispatches) deferredPublish.delete(path)
}

/** Operator x-gesture on a QUEUED board row: withdraw a held
 *  reservation — the row settles 'failed' (its heldReason clears) and
 *  leaves the board; the GC prunes it in time. Idempotent: an unknown or
 *  already-settled id is a noop-false. */
export function withdrawConcourseDispatch(clientMessageId: string, dir?: string): boolean {
  const dispatches = readConcourseDispatches(dir)
  const rec = dispatches[clientMessageId]
  if (!rec || rec.sessionId !== undefined) return false
  if (rec.state !== 'queued' && rec.heldReason === undefined) return false
  rec.state = 'failed'
  delete rec.heldReason
  delete rec.heldOp
  rec.reason = 'withdrawn by the operator (x on the queued row)'
  publishDispatches(dispatches, dir)
  return true
}

/**
 * Settle every WORKING dispatch owned by a runner that died for good. The
 * degrade path (respawn budget exhausted) settled the WORKER record while
 * the DISPATCH stayed state:'working' forever, so the board's own truth
 * never learned WHY the session stopped. The adjudicator still owns
 * legality — a terminal row never moves. Returns how many rows settled.
 */
export function failWorkingDispatchesForRunner(runnerId: string, reason: string, dir?: string): number {
  const dispatches = readConcourseDispatches(dir)
  let moved = 0
  for (const rec of Object.values(dispatches)) {
    if (rec.state !== 'working' || rec.workerId !== runnerId) continue
    advance(rec, 'failed', { reason })
    if (settledFailed(rec)) moved++
  }
  if (moved > 0) publishDispatches(dispatches, dir)
  return moved
}

/** Post-advance read the checker cannot narrow away: advance mutates the
 *  row through a call TypeScript does not see into, and the loop guards
 *  above narrow `state` to 'working'. */
function settledFailed(rec: ConcourseDispatchRecordV1): boolean {
  return rec.state === 'failed'
}

/**
 * Boot reconcile for the same truth: a 'working' dispatch whose worker
 * record already carries endedAt belongs to a daemon that died mid-degrade
 * — settle it now, so a fresh daemon over the same dir never re-serves a
 * 'working' row for a runner that is gone. The workers read is injectable
 * for the hermetic proof; production reads the supervisor's own store.
 */
export function reconcileWorkingDispatches(
  dir?: string,
  workersRead: (d?: string) => Record<string, { endedAt?: number }> = readSessionWorkers,
): number {
  const dispatches = readConcourseDispatches(dir)
  const workers = workersRead(dir)
  let moved = 0
  for (const rec of Object.values(dispatches)) {
    if (rec.state !== 'working' || rec.workerId === undefined) continue
    const worker = workers[rec.workerId]
    if (worker === undefined || worker.endedAt === undefined) continue
    advance(rec, 'failed', { reason: 'the worker ended without settling its dispatch — settled at boot reconcile' })
    if (settledFailed(rec)) moved++
  }
  if (moved > 0) publishDispatches(dispatches, dir)
  return moved
}

export function promptDigestOf(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

// ── the concourseControl applied-ops ledger (advisor item 8) ────────────────
// pause/resume/interrupt carried NO operation identity: interrupt is not
// state-idempotent, so a retry after response loss aborted TWO turns. The
// ledger mirrors the dispatch file's shape and prune law: a replayed
// clientOpId returns the recorded receipt without re-executing.

export interface ConcourseControlOpRecordV1 {
  clientOpId: string
  /** The op the id was minted for — a replay hit requires the FULL match
   *  (3-3-3 challenge: an id colliding across intents must read as a miss,
   *  never return a foreign receipt). */
  action: string
  sessionId: string
  outcome: 'applied' | 'noop' | 'refused'
  detail?: string
  atMs: number
}

export function concourseControlOpsPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-control-ops.json')
}

export function readConcourseControlOps(dir?: string): Record<string, ConcourseControlOpRecordV1> {
  try {
    const raw = JSON.parse(readFileSync(concourseControlOpsPath(dir), 'utf8')) as {
      version: 1
      ops: Record<string, ConcourseControlOpRecordV1>
    }
    if (!raw || raw.version !== 1 || typeof raw.ops !== 'object') return {}
    return raw.ops
  } catch {
    return {}
  }
}

export function recordConcourseControlOp(rec: ConcourseControlOpRecordV1, dir?: string): void {
  const ops = readConcourseControlOps(dir)
  ops[rec.clientOpId] = rec
  const stale = Object.values(ops).sort((a, b) => b.atMs - a.atMs).slice(200)
  for (const s of stale) delete ops[s.clientOpId]
  // DURABILITY: same primitive, same bytes (see publishDispatches).
  durableAtomicPublishSync(concourseControlOpsPath(dir), `${JSON.stringify({ version: 1, ops }, null, 1)}\n`)
}

/** The complete-envelope identity digest (advisor item 8): canonical JSON
 *  over every field that changes WHAT the dispatch does — never content
 *  storage (the digest law stands). */
export function envelopeDigestOf(req: ConcourseDispatchRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        prompt: req.prompt,
        workspaceDir: canonicalWorkspaceId(req.workspaceDir),
        targetSessionId: req.targetSessionId ?? null,
        isolation: req.isolation ?? null,
        modelKey: req.modelKey ?? null,
        effort: req.effort ?? null,
        title: req.title ?? null,
        agentName: req.agentName ?? null,
        seatsMax: req.seatsMax ?? null,
        // Decoded and material (it decides --resume vs a fresh session):
        // absent from the digest it was a hole in the COMPLETE-envelope law.
        resumeSessionId: req.resumeSessionId ?? null,
        // The seat's extras change WHAT the words do (a bash line, a queue
        // band, an addressed agent note, rich content) — material, so they
        // ride the digest.
        mode: req.mode ?? null,
        agentId: req.agentId ?? null,
        priority: req.priority ?? null,
        content: req.content ?? null,
        // An explicit initial permission mode changes the seat's posture —
        // material, so a replay under the same id that changes it is an edit.
        permissionMode: req.permissionMode ?? null,
        // The runner-side options change what the session runs with.
        runnerArgv: req.runnerArgv ?? null,
      }),
      'utf8',
    )
    .digest('hex')
}

/**
 * The operator's prompt as a stream-json user frame (the worker is the
 * operator's OWN chat — verbatim content, no bus framing; the
 * scribeDispatchBridge frame shape). The live battery's first run caught
 * the raw-string class this prevents: an unframed prompt kills the child's
 * stdin parser instantly and respawn-loops it to DEGRADED.
 */
export function buildConcoursePromptFrame(prompt: string, extras?: ConcoursePromptExtras, groundNote?: string): string {
  // BOARD CONTROLS item 6: the ground note OPENS the prompt when the
  // caller composed one — plain text gets it above the words, rich content
  // gets it as the leading text block. A bash line is a COMMAND, not a
  // prompt: the note never rides it (it would corrupt the command).
  const note = groundNote !== undefined && groundNote.length > 0 && extras?.mode !== 'bash' ? groundNote : undefined
  const content =
    extras?.content !== undefined
      ? note !== undefined
        ? [{ type: 'text', text: note }, ...extras.content]
        : extras.content
      : note !== undefined
        ? `${note}\n\n${prompt}`
        : prompt
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    // ONE identity, composer to transcript row (the delivery law): a
    // UUID-shaped clientMessageId rides through as the frame uuid — the
    // queued entry's uuid in the session's own queue, the promptUuid the
    // turn runs under, the transcript user row's uuid the cockpit retires
    // its echo against, and the runner's replay-dedup key. A non-UUID
    // identity (obligation answers, legacy ids) falls back to a mint.
    uuid:
      extras?.identity !== undefined && UUID_SHAPE.test(extras.identity)
        ? extras.identity
        : randomUUID(),
    ...(extras?.priority !== undefined ? { priority: extras.priority } : {}),
    ...(extras?.mode === 'bash' ? { mode: 'bash' } : {}),
    ...(extras?.mode === 'task-notification' && extras.agentId !== undefined
      ? { mode: 'task-notification', agentId: extras.agentId }
      : {}),
  })
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What rides the words beyond their text: the composer mode (a bash line
 *  runs as a shell command in the session's own process), the queue band
 *  the session's own queue files them under when it is busy, rich
 *  content (pastes expanded, images as blocks) in place of the plain text,
 *  and the dispatch's own clientMessageId as the frame identity. */
export interface ConcoursePromptExtras {
  mode?: 'prompt' | 'bash' | 'task-notification'
  /** mode 'task-notification': the addressed agent inside the runner. */
  agentId?: string
  priority?: 'now' | 'next' | 'later'
  content?: unknown[]
  identity?: string
}

function promptExtrasOf(req: Pick<ConcourseDispatchRequest, 'mode' | 'priority' | 'content' | 'agentId'>): ConcoursePromptExtras | undefined {
  if (req.mode === undefined && req.priority === undefined && req.content === undefined) return undefined
  return {
    ...(req.mode !== undefined ? { mode: req.mode } : {}),
    ...(req.agentId !== undefined ? { agentId: req.agentId } : {}),
    ...(req.priority !== undefined ? { priority: req.priority } : {}),
    ...(req.content !== undefined ? { content: req.content } : {}),
  }
}

/** The 'started' signal DECIDES at this seam — the "only
 *  after a positive worker start" is exactly the delivered advance. The
 *  daemon has no host toast: the decision journals (policy gate + a
 *  destination-'journal' claim) and the visible process replays it to the
 *  host exactly once. Fire-and-forget, never silent (the C3 discipline). */
function emitStarted(rec: ConcourseDispatchRecordV1, runnerId: string, sessionId: string): void {
  void import('../services/notificationPolicy.js')
    .then(policy =>
      policy.journalConcourseSignal({
        kind: 'started',
        targetId: runnerId,
        revision: rec.stateRevision,
        title: 'session started',
        detail: `worker ${runnerId} took the prompt`,
        deepLink: { sessionId },
        obligationBacked: false,
      }),
    )
    .catch(err => {
      logForDebugging(`[concourse/dispatch] started-signal journal failed for ${rec.clientMessageId}: ${err}`)
    })
}

/** Move a ledger row through the ONE adjudicator; illegal moves are recorded
 *  bugs (logged, row untouched) — never silent forward jumps. */
function advance(
  rec: ConcourseDispatchRecordV1,
  to: ConcourseSessionState,
  patch?: Partial<ConcourseDispatchRecordV1>,
): void {
  const d = decideTransition(rec.state, to)
  if (d.legal !== true) {
    if (d.reason !== 'idempotent-noop') {
      logForDebugging(`[concourse/dispatch] refused ${rec.state}→${to} (${d.reason}) for ${rec.clientMessageId}`)
    }
    return
  }
  rec.state = to
  rec.stateRevision += 1
  Object.assign(rec, patch)
}

// ── preflight (the deterministic start gate) ───────────

export interface ConcoursePreflightRefusal {
  code: 'invalid-workspace' | 'invalid-model' | 'invalid-effort' | 'no-repository' | 'runtime-ceiling' | 'workspace-collision'
  reason: string
  /** the executable moves beside the block (typed — never clamped). */
  moves?: ConcourseMoveV1[]
}

export type ConcoursePreflightResult = { ok: true } | { ok: false; refusals: ConcoursePreflightRefusal[] }

/**
 * The deterministic start gate, PURE over durable state: identity
 * (workspace exists, canonical), eligibility (the one callable-model owner),
 * capability (worktree isolation needs a repository — the plain-folder
 * honesty), and isolation/collision (the SAME evaluateConcourseAdmission
 * core over records ∩ positive pid liveness). Collects EVERY applicable
 * refusal — a preview names all of it before any provider use. Consumes
 * nothing, writes nothing, spawns nothing (the structural half; the
 * admission handler re-derives against roster truth at submit — this gate
 * is the honest PREVIEW of that decision, never a second authority).
 *
 * Recorded adjudications: the ACCOUNT term (initiating principal →
 * eligible execution seat) is the seam (the frozen
 * workQueue admission owner); the DEPENDENCY term joins when a durable
 * dependency field exists at this owner.
 */
export async function preflightConcourseDispatch(
  req: ConcourseAdmitRequest,
  dir?: string,
): Promise<ConcoursePreflightResult> {
  const refusals: ConcoursePreflightRefusal[] = []
  let workspaceOk = false
  try {
    workspaceOk = statSync(req.workspaceDir).isDirectory()
  } catch {
    /* refused below */
  }
  if (!workspaceOk) {
    // The field the operator fixes is the Project chip — name it and
    // the fix, never stat() speech.
    refusals.push({ code: 'invalid-workspace', reason: `project folder not found: ${req.workspaceDir} — pick an existing folder` })
  }
  // The ONE callable-model owner validates (F1) — the preflight preview
  // speaks the registry's typed refusal, exactly like the admission.
  const modelValidated = await (await import('../services/concourse/workerModels.js')).validateWorkerModelChoice(req.modelKey, 'session')
  // Operator: an effort outside the shared ladder is a TYPED
  // refusal. The ONE normalizer answers first — a plain spelling ('max
  // effort', 'x high') is the same request as its ladder word, so the
  // preview refuses exactly what the admission refuses.
  if (req.effort !== undefined) {
    const { normalizeEffortLevelString, EFFORT_LEVELS } = await import('../utils/effort.js')
    if (normalizeEffortLevelString(req.effort) === undefined) {
      refusals.push({ code: 'invalid-effort', reason: `effort '${req.effort}' is not on the ladder — the levels are ${EFFORT_LEVELS.join(' | ')}` })
    }
  }
  if (!modelValidated.ok) {
    // The typed reason class + the ONE action ride the preview exactly as
    // they ride the admission — a preflight never understates the fix.
    refusals.push({
      code: 'invalid-model',
      reason: `model unavailable (${modelValidated.reason})${modelValidated.detail !== undefined ? ` — ${modelValidated.detail}` : ''}${modelValidated.action !== undefined ? ` · ${modelValidated.action}` : ''}`,
    })
  }
  if (workspaceOk) {
    const workspaceId = canonicalWorkspaceId(req.workspaceDir)
    if ((req.isolation ?? 'exclusive') === 'worktree-isolated' && workspaceKindOf(workspaceId) === 'plain-folder') {
      refusals.push({
        code: 'no-repository',
        reason: 'forking needs a git repository — this folder has none yet',
        moves: [{ verb: 'init-git', label: 'say yes to the git offer — then sessions can fork here' }],
      })
    }
    // SB-C1: an attached record's child is dead by design — its claim is
    // the operator's terminal; the preview must see it exactly as admission.
    const live = Object.values(readSessionWorkers(dir)).filter(
      r =>
        r.endedAt === undefined &&
        ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
    )
    // The ONE fold admission uses — preview and door can never
    // diverge (this also folds the live seat ceiling in; the preview used
    // to under-refuse on lowered-ceiling machines).
    const resolution = resolveDefaultedAdmission(
      live.map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation })),
      { workspaceId, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}) },
    )
    if (resolution.kind === 'git-offer') {
      refusals.push({ code: resolution.code, reason: resolution.error, moves: resolution.moves })
    } else if (!resolution.decision.admit) {
      refusals.push({
        code: resolution.decision.code,
        reason: resolution.decision.reason,
        ...(resolution.decision.moves !== undefined ? { moves: resolution.decision.moves } : {}),
      })
    }
  }
  return refusals.length === 0 ? { ok: true } : { ok: false, refusals }
}

export interface ConcourseDispatchRequest extends ConcourseAdmitRequest {
  clientMessageId: string
  prompt: string
  /** Attribution origin — persisted onto the record verbatim (see
   *  ConcourseDispatchRecordV1.by). Deliberately OUTSIDE envelopeDigest:
   *  attribution metadata never makes a replay a material edit. */
  by?: string
  /** session.redirect: deliver the prompt as an INSTRUCTION
   *  to an EXISTING live session through this same idempotent owner — admit
   *  is skipped, the live worker resolves from the supervisor records, and
   *  the valve refuses paused targets (held, not failed). */
  targetSessionId?: string
  /** The seat's extras (see ConcoursePromptExtras): the composer mode (or
   *  the addressed agent-note form), the queue band, rich content.
   *  Material to the digest. */
  mode?: 'prompt' | 'bash' | 'task-notification'
  /** mode 'task-notification': the target agent inside the session's
   *  runner (the drain-scope id) — the delivery door's addressed form. */
  agentId?: string
  priority?: 'now' | 'next' | 'later'
  content?: unknown[]
}

export type ConcourseDispatchResult = {
  ok: boolean
  clientMessageId: string
  state: ConcourseSessionState
  stateRevision: number
  runnerId?: string
  sessionId?: string
  error?: string
  /** 'replayed' = the same id returned its existing receipt (no new work);
   *  'edited-replay' = same id, DIFFERENT prompt digest — refused. */
  replay?: 'replayed' | 'edited-replay'
  /** The typed hold reason rides the RECEIPT too — the caller must
   *  never be forced back to the ledger file to learn why a row waits. */
  heldReason?: string
  heldByTitle?: string
  /** executable moves beside the block. */
  moves?: ConcourseMoveV1[]
  /** set when admission carved a fork — receipts name the branch
   *  and who holds the main checkout. */
  branchName?: string
  mainHolderTitle?: string
  /** The model the admitted session actually runs on — resolved id plus the
   *  registry's display name. The launch receipt names it, so a launch that
   *  named no model still tells the operator where it landed. */
  modelId?: string
  modelDisplayName?: string
  /** The effort the admitted session started at (the canonical ladder word
   *  the record/spec carry — asked, retained, or the convention). The
   *  launch receipt names it beside the model: a tier nobody asked for is
   *  a stated fact, never a silent default (the chain-of-custody law). */
  effort?: string
  /** Where the admitted session's kit came from: 'carried' —
   *  the request handed a snapshot; 'derived' — the daemon composed it
   *  from the workspace's menu. Set on the admit-new road only (a
   *  redirect delivers into a session that already wears its kit).
   *  'preset' — the dispatch named a saved preset and the
   *  kit derived from ITS deltas; presetName/presetNote then name it for
   *  the launch receipt. */
  kitSource?: 'carried' | 'derived' | 'preset'
  presetName?: string
  presetNote?: string
}

export interface ConcourseDispatchDeps {
  admit: (req: ConcourseAdmitRequest) => Promise<ConcourseAdmitResult>
  /** roster.reply — the stdin delivery leg (arms the worker's turn). */
  deliver: (runnerId: string, prompt: string) => Promise<boolean>
  /** Live-drive ruling: respawn a crash-dead target's runner
   *  around its untouched transcript so the delivery proceeds into the SAME
   *  session instead of refusing 'target-not-live'. */
  revive?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
  dir?: string
}

/** SB-C6: the handler carries its own tail-riding withdraw — the ledger's
 *  read-modify-write spans awaits, so a withdraw executed OUTSIDE the mutex
 *  (the old UI-process direct write) could be clobbered by an in-flight
 *  dispatch's later publish, resurrecting the withdrawn row. */
export interface ConcourseDispatchHandler {
  (req: ConcourseDispatchRequest): Promise<ConcourseDispatchResult>
  withdraw(clientMessageId: string): Promise<boolean>
}

export function makeConcourseDispatchHandler(
  deps: ConcourseDispatchDeps,
): ConcourseDispatchHandler {
  // Deliver an instruction to an EXISTING live session — the
  // redirect leg and the held-replay retry share this one path. The VALVE:
  // a paused target HOLDS the row ('queued' + heldReason, never 'failed');
  // the ledger stores digests only, so re-delivery happens when the CALLER
  // replays the same id + content after resume (the digest law intact).
  const attemptRedirectDelivery = async (
    rec: ConcourseDispatchRecordV1,
    dispatches: Record<string, ConcourseDispatchRecordV1>,
    target: string,
    prompt: string,
    extras?: ConcoursePromptExtras,
  ): Promise<ConcourseDispatchResult> => {
    const workers = readSessionWorkers(deps.dir)
    let targetRec = Object.values(workers).find(w => w.sessionId === target && w.endedAt === undefined)
    if (targetRec && (targetRec.attachedAt !== undefined || targetRec.attachRequestedAt !== undefined)) {
      // (the with-you truth): an attached session is the OPERATOR'S
      // terminal, and a session whose enter valve is closed (drive-12: the
      // drain/follow window — attachRequestedAt) is on its way to them; a
      // delivery now would arm a turn under the handover. Held, not failed:
      // the caller-side pump replays it the moment the session is handed
      // back (or the enter is cancelled and the valve re-opens).
      rec.heldReason = 'session-with-you'
      rec.sessionId = target
      rec.workerId = targetRec.runnerId
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        runnerId: targetRec.runnerId,
        sessionId: target,
        heldReason: 'session-with-you',
        error:
          'this session is with you in the terminal — say it there, or leave it and this message delivers on its own',
        moves: [{ verb: 'queue', label: 'it delivers on its own after you leave the session' }],
      }
    }
    if (targetRec && targetRec.pausedAt !== undefined) {
      rec.heldReason = 'session-paused'
      rec.sessionId = target
      rec.workerId = targetRec.runnerId
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        runnerId: targetRec.runnerId,
        sessionId: target,
        heldReason: 'session-paused',
        error: `paused by ${targetRec.pausedBy ?? 'operator'} — resume the session and this message delivers on its own`,
        moves: [{ verb: 'retry', label: 'resume the session — the message delivers on its own' }],
      }
    }
    if (
      targetRec &&
      (targetRec.pid === undefined || !isProcessAlive(targetRec.pid)) &&
      targetRec.stoppedAt === undefined &&
      targetRec.attachedAt === undefined &&
      deps.revive !== undefined
    ) {
      // Live-drive ruling: a crash-dead runner revives in place
      // — the delivery proceeds into the SAME session (same chat) instead of
      // the refusal maze redirect → resume → redirect the operator hit.
      const rev = await deps.revive(target)
      if (rev.ok) {
        const refreshed = Object.values(readSessionWorkers(deps.dir)).find(
          w => w.sessionId === target && w.endedAt === undefined,
        )
        if (refreshed) targetRec = refreshed
      }
    }
    if (!targetRec || targetRec.pid === undefined || !isProcessAlive(targetRec.pid)) {
      const stopped = targetRec?.stoppedAt !== undefined
      const why = stopped
        ? 'stopped — the session was stopped on purpose; resume it to bring it back'
        : 'the session has no live runner — a replay revives it and delivers into the same chat'
      // R7 C-LOW-2: a settling row sheds its hold — a failed row that kept
      // heldReason re-entered the replay-delivery door forever after.
      delete rec.heldReason
      delete rec.heldOp
      advance(rec, 'failed', { reason: why })
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: why,
        moves: [
          stopped
            ? { verb: 'revive', label: 'resume the session — it comes back around its untouched chat' }
            : { verb: 'revive', label: '↵ replays — it revives the runner and delivers' },
        ],
      }
    }
    delete rec.heldReason
    delete rec.heldOp
    advance(rec, 'starting', { workerId: targetRec.runnerId, sessionId: target })
    // R7 C-LOW-2: the adjudicator can REFUSE the move (a terminal row on a
    // replay path) — delivery rides the verdict, never unconditionally: a
    // settled-failed row must not deliver its prompt once more.
    if (rec.state !== 'starting') {
      publishDispatches(dispatches, deps.dir)
      return {
        ok: false,
        clientMessageId: rec.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: `replay refused: the message already settled '${rec.state}' — a terminal row never re-delivers`,
      }
    }
    publishDispatches(dispatches, deps.dir)
    const delivered = await deps.deliver(
      targetRec.runnerId,
      buildConcoursePromptFrame(prompt, { ...extras, identity: rec.clientMessageId }),
    )
    if (delivered) {
      advance(rec, 'working', { deliveredAt: Date.now() })
      emitStarted(rec, targetRec.runnerId, target)
    } else {
      advance(rec, 'failed', { reason: 'instruction delivery failed (stdin unavailable)' })
    }
    publishDispatchesAfterReply(dispatches, deps.dir)
    return {
      ok: delivered,
      clientMessageId: rec.clientMessageId,
      state: rec.state,
      stateRevision: rec.stateRevision,
      runnerId: targetRec.runnerId,
      sessionId: target,
      ...(delivered ? {} : { error: 'instruction delivery failed (stdin unavailable)' }),
    }
  }

  // R7 C-MED-1: the handler reads the WHOLE ledger, holds it across the
  // admit/deliver awaits, and publishes the whole map back — two interleaved
  // requests would lose/regress each other's rows, and the same-id
  // idempotency door would double-admit. The daemon is one process: a
  // promise-chain mutex serializes the read-modify-write; each caller still
  // sees its own result/rejection.
  let tail: Promise<unknown> = Promise.resolve()
  const run = async (req: ConcourseDispatchRequest): Promise<ConcourseDispatchResult> => {
    const digest = promptDigestOf(req.prompt)
    const envDigest = envelopeDigestOf(req)
    const dispatches = readConcourseDispatches(deps.dir)
    const existing = dispatches[req.clientMessageId]
    if (existing) {
      const edited =
        existing.envelopeDigest !== undefined
          ? existing.envelopeDigest !== envDigest
          : existing.promptDigest !== digest
      if (edited) {
        return {
          ok: false,
          clientMessageId: req.clientMessageId,
          state: existing.state,
          stateRevision: existing.stateRevision,
          replay: 'edited-replay',
          error: 'same clientMessageId with different content — a material edit needs a NEW message identity (the draft is preserved)',
        }
      }
      // The held-replay retry: same id + same content after a valve hold —
      // the caller re-supplied the instruction, so delivery re-attempts
      // (still-paused holds again; resumed delivers exactly once). The
      // replay carries the SAME extras as the held original (mode, band,
      // rich content — the digest just proved the request identical); the
      // old 4-arg call dropped them, so a held bash line replayed as a
      // prompt and held images vanished.
      if (existing.heldReason !== undefined && existing.sessionId !== undefined) {
        return attemptRedirectDelivery(existing, dispatches, existing.sessionId, req.prompt, promptExtrasOf(req))
      }
      if (existing.heldReason === undefined || existing.sessionId !== undefined) return {
        ok: existing.state !== 'failed',
        clientMessageId: req.clientMessageId,
        state: existing.state,
        stateRevision: existing.stateRevision,
        ...(existing.workerId !== undefined ? { runnerId: existing.workerId } : {}),
        ...(existing.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
        ...(existing.reason !== undefined ? { error: existing.reason } : {}),
        replay: 'replayed',
      }
      // An ADMISSION-held record (queued, no session): the replay
      // re-attempts admission below with the SAME reservation — a freed
      // seat or released workspace admits it now.
    }

    // THE RESERVATION — one durable mutation BEFORE any worker/provider use
    // (an admission-held replay reuses its existing reservation).
    const held = existing !== undefined && existing.heldReason !== undefined && existing.sessionId === undefined
    const rec: ConcourseDispatchRecordV1 = held
      ? existing
      : {
          schema: 1,
          clientMessageId: req.clientMessageId,
          promptDigest: digest,
          envelopeDigest: envDigest,
          state: 'queued',
          stateRevision: 1,
          acceptedAt: Date.now(),
        }
    delete rec.heldReason
    delete rec.heldOp
    // Display metadata for the QUEUED board fold (title + canonical
    // workspace — never prompt content).
    if (req.title !== undefined && req.title.length > 0) rec.title = req.title.slice(0, 120)
    rec.workspaceId = canonicalWorkspaceId(req.workspaceDir)
    // Attribution origin — the attached surface's plates read this.
    if (req.by !== undefined && req.by.length > 0) rec.by = req.by.slice(0, 64)
    dispatches[req.clientMessageId] = rec
    publishDispatches(dispatches, deps.dir)

    // The redirect leg: an EXISTING session is the target — admit is skipped
    // entirely (no new worker, no workspace claim; the mid-turn case rides
    // the child's own proven queued-steering input path).
    if (req.targetSessionId !== undefined) {
      return attemptRedirectDelivery(rec, dispatches, req.targetSessionId, req.prompt, promptExtrasOf(req))
    }

    const { clientMessageId: _id, prompt, targetSessionId: _target, ...admitReq } = req
    const admitted = await deps.admit(admitReq)
    if (!admitted.ok) {
      // carve blocks (no git, no commits, git missing) join the
      // retryable set — fixable, then the SAME reservation replays.
      const retryable =
        admitted.code === 'runtime-ceiling' ||
        admitted.code === 'workspace-collision' ||
        admitted.code === 'no-repository' ||
        admitted.code === 'git-unavailable' ||
        admitted.code === 'unborn-head'
      if (retryable) {
        // HELD, not failed (the valve's own posture): the reservation stays
        // 'queued' with the TYPED hold — the board paints the row's own
        // reason and a replay of the same id + content re-attempts admission.
        rec.heldReason = normalizeHoldReason(admitted.code) ?? 'seat'
        if (rec.heldReason === 'repo-held') {
          const holder = Object.values(readSessionWorkers(deps.dir)).find(
            w =>
              w.endedAt === undefined &&
              w.workspaceId === rec.workspaceId &&
              ['exclusive', 'shared'].includes(w.isolation ?? 'exclusive'),
          )
          if (holder?.title !== undefined) rec.heldByTitle = holder.title.slice(0, 60)
          else delete rec.heldByTitle
        }
        rec.reason = admitted.error
        // Drive-11: bank the complete envelope on the held reservation — the
        // daemon-side replay re-supplies it verbatim when the block clears.
        rec.heldOp = {
          prompt: req.prompt,
          workspaceDir: req.workspaceDir,
          ...(req.isolation !== undefined ? { isolation: req.isolation } : {}),
          ...(req.modelKey !== undefined ? { modelKey: req.modelKey } : {}),
          ...(req.effort !== undefined ? { effort: req.effort } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
          ...(req.seatsMax !== undefined ? { seatsMax: req.seatsMax } : {}),
          ...(req.resumeSessionId !== undefined ? { resumeSessionId: req.resumeSessionId } : {}),
          ...(req.by !== undefined ? { by: req.by } : {}),
          ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
          ...(req.runnerArgv !== undefined ? { runnerArgv: [...req.runnerArgv] } : {}),
          ...(req.kitPreset !== undefined ? { kitPreset: req.kitPreset } : {}),
        }
        publishDispatches(dispatches, deps.dir)
        if ((rec.heldReason === 'no-repository' || rec.heldReason === 'unborn-head') && rec.workspaceId !== undefined) {
          // the hold mints its own consent door — a y on the rail
          // (or the coordinator's answer verb) runs git init daemon-side and
          // the pump replays this same reservation on its own.
          const folder = rec.workspaceId
          void import('./permissionAsks.js')
            .then(p => p.mintGitInitAsk(folder))
            .catch(err => logForDebugging(`[concourse/dispatch] git-init ask mint failed: ${err}`))
        }
        return {
          ok: false,
          clientMessageId: rec.clientMessageId,
          state: rec.state,
          stateRevision: rec.stateRevision,
          error: admitted.error,
          heldReason: rec.heldReason,
          ...(rec.heldByTitle !== undefined ? { heldByTitle: rec.heldByTitle } : {}),
          ...(admitted.moves !== undefined ? { moves: admitted.moves } : {}),
        }
      }
      advance(rec, 'failed', { reason: admitted.error })
      publishDispatches(dispatches, deps.dir)
      // An OBSERVED workspace collision mints its typed
      // durable evidence row — who held the workspace, at refusal time.
      // (The preflight preview computes EXPECTED overlap in-memory only —
      // recorded adjudication: a draft keystroke is not an event.)
      if (admitted.code === 'workspace-collision') {
        try {
          const wsId = canonicalWorkspaceId(req.workspaceDir)
          const holders = Object.values(readSessionWorkers(deps.dir))
            .filter(r => r.endedAt === undefined && r.workspaceId === wsId)
            .map(r => ({ workerId: r.runnerId, sessionId: r.sessionId, isolation: r.isolation }))
          recordCollisionEvidence(
            {
              schema: 1,
              kind: 'exclusive-overlap',
              workspaceId: wsId,
              holders,
              observedAt: Date.now(),
              refusedClientMessageId: req.clientMessageId,
              detail: admitted.error,
            },
            deps.dir,
          )
        } catch (err) {
          logForDebugging(`[concourse/dispatch] collision-evidence record failed for ${req.clientMessageId}: ${err}`)
        }
      }
      // A refusal becomes a VISIBLE durable question (the kernel's
      // ref-idempotent attention.raise) — never a silent dead end. Fire and
      // forget: the reply carries the refusal either way.
      void import('../services/concourse/coordinatorKernel.js')
        .then(k =>
          k.runCoordinatorKernel({
            kind: 'dispatch-refused',
            clientMessageId: req.clientMessageId,
            reason: admitted.error,
            workspaceDir: req.workspaceDir,
            promptPreview: prompt,
            ...(req.by !== undefined ? { by: req.by } : {}),
          }),
        )
        .catch(err => {
          // C3: the ride is fire-and-forget but never SILENT — a
          // failing kernel here swallows the R1 obligation raise unseen.
          logForDebugging(`[concourse/dispatch] R1 kernel ride failed for ${req.clientMessageId}: ${err}`)
        })
      return {
        ok: false,
        clientMessageId: req.clientMessageId,
        state: rec.state,
        stateRevision: rec.stateRevision,
        error: admitted.error,
        ...(admitted.moves !== undefined ? { moves: admitted.moves } : {}),
      }
    }
    advance(rec, 'starting', { workerId: admitted.runnerId, sessionId: admitted.sessionId })
    // R7 C-HIGH-2 (supersede): a successful admission settles every OLDER
    // admission-held twin (same instruction digest + workspace, still waiting
    // on a seat) — without this, a re-typed submit strands its predecessor as
    // an immortal QUEUED board ghost no replay will ever admit.
    for (const other of Object.values(dispatches)) {
      if (other === rec) continue
      if (other.heldReason === undefined || other.sessionId !== undefined) continue
      if (other.promptDigest !== rec.promptDigest || other.workspaceId !== rec.workspaceId) continue
      delete other.heldReason
      delete other.heldOp
      advance(other, 'failed', { reason: `superseded — the same instruction admitted as ${rec.clientMessageId}` })
    }
    publishDispatches(dispatches, deps.dir)

    // BOARD CONTROLS item 6: the dispatched agent's prompt opens with the
    // ground note composed from the admission's REAL isolation fact — the
    // record the admit just minted (worktree fork vs shared folder), never
    // a guess. The git-ready replay rides this same door and inherits it;
    // a redirect to an existing session (above) composes none — that
    // session was briefed at its birth.
    const admittedRec = readSessionWorkers(deps.dir)[admitted.runnerId]
    const groundNote =
      admittedRec !== undefined
        ? isolationAwarenessNote({
            isolation: admittedRec.isolation ?? 'exclusive',
            workspaceId: admittedRec.workspaceId,
            ...(admittedRec.branchName !== undefined ? { branchName: admittedRec.branchName } : {}),
          })
        : undefined
    const delivered = await deps.deliver(
      admitted.runnerId,
      buildConcoursePromptFrame(prompt, { ...promptExtrasOf(req), identity: req.clientMessageId }, groundNote),
    )
    if (delivered) {
      advance(rec, 'working', { deliveredAt: Date.now() })
      emitStarted(rec, admitted.runnerId, admitted.sessionId)
    } else {
      advance(rec, 'failed', { reason: 'worker start delivery failed (stdin unavailable)' })
    }
    publishDispatchesAfterReply(dispatches, deps.dir)
    return {
      ok: delivered,
      clientMessageId: req.clientMessageId,
      state: rec.state,
      stateRevision: rec.stateRevision,
      runnerId: admitted.runnerId,
      sessionId: admitted.sessionId,
      ...(admitted.branchName !== undefined ? { branchName: admitted.branchName } : {}),
      ...(admitted.mainHolderTitle !== undefined ? { mainHolderTitle: admitted.mainHolderTitle } : {}),
      ...(admitted.modelId !== undefined ? { modelId: admitted.modelId } : {}),
      ...(admitted.modelDisplayName !== undefined ? { modelDisplayName: admitted.modelDisplayName } : {}),
      ...(admitted.effort !== undefined ? { effort: admitted.effort } : {}),
      ...(admitted.kitSource !== undefined ? { kitSource: admitted.kitSource } : {}),
      ...(admitted.presetName !== undefined ? { presetName: admitted.presetName } : {}),
      ...(admitted.presetNote !== undefined ? { presetNote: admitted.presetNote } : {}),
      ...(delivered ? {} : { error: 'worker start delivery failed (stdin unavailable)' }),
    }
  }
  const handler = ((req: ConcourseDispatchRequest) => {
    const next = tail.then(
      () => run(req),
      () => run(req),
    )
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }) as ConcourseDispatchHandler
  handler.withdraw = clientMessageId => {
    const next = tail.then(
      () => withdrawConcourseDispatch(clientMessageId, deps.dir),
      () => withdrawConcourseDispatch(clientMessageId, deps.dir),
    )
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  return handler
}

/** Drive-11: the launches a git-ready replay would start in this folder —
 *  the sync projection the answering surface names BEFORE the async replay
 *  lands (titles only, never content). */
export function heldGitLaunchesFor(
  folder: string,
  dir?: string,
): ReadonlyArray<{ clientMessageId: string; title?: string }> {
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readConcourseDispatches(dir))
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
    .map(r => ({ clientMessageId: r.clientMessageId, ...(r.title !== undefined ? { title: r.title } : {}) }))
}

/** Drive-11: the daemon-side pump — git just
 *  landed in a folder, so every launch held on its absence replays through
 *  the SAME dispatch door: the same reservation (idempotent by
 *  clientMessageId, envelope re-hashed from the banked heldOp), sequential
 *  so sibling replays negotiate their own worktree forks exactly like fresh
 *  launches. A replay that holds again (or fails) stays visible on the
 *  board with its own reason — never a silent drop. */
export async function replayGitBlockedDispatches(
  folder: string,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
  dir?: string,
): Promise<ReadonlyArray<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }>> {
  const canonical = canonicalWorkspaceId(folder)
  const dispatches = readConcourseDispatches(dir)
  const held = Object.values(dispatches)
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
  const out: Array<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> = []
  for (const rec of held) {
    if (rec.heldOp === undefined) continue
    out.push(await replayHeldRecord(rec, dispatch))
  }
  return out
}

/** One held reservation replayed VERBATIM from its banked heldOp through
 *  the idempotent door — same id, same envelope, never a material edit
 *  (the git-ready replay and the deny-proceed replay both speak here). */
async function replayHeldRecord(
  rec: ConcourseDispatchRecordV1,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
): Promise<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> {
  const op = rec.heldOp!
  try {
    const res = await dispatch({
      clientMessageId: rec.clientMessageId,
      prompt: op.prompt,
      workspaceDir: op.workspaceDir,
      ...(op.isolation !== undefined ? { isolation: op.isolation as ConcourseAdmitRequest['isolation'] } : {}),
      ...(op.modelKey !== undefined ? { modelKey: op.modelKey } : {}),
      ...(op.effort !== undefined ? { effort: op.effort } : {}),
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.agentName !== undefined ? { agentName: op.agentName } : {}),
      ...(op.seatsMax !== undefined ? { seatsMax: op.seatsMax } : {}),
      ...(op.resumeSessionId !== undefined ? { resumeSessionId: op.resumeSessionId } : {}),
      ...(op.by !== undefined ? { by: op.by } : {}),
      ...(op.permissionMode !== undefined ? { permissionMode: op.permissionMode as ConcourseAdmitRequest['permissionMode'] } : {}),
      ...(op.runnerArgv !== undefined ? { runnerArgv: op.runnerArgv } : {}),
      ...(op.kitPreset !== undefined ? { kitPreset: op.kitPreset } : {}),
    })
    return {
      clientMessageId: rec.clientMessageId,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ok: res.ok,
      ...(res.sessionId !== undefined ? { sessionId: res.sessionId } : {}),
      ...(res.branchName !== undefined ? { branchName: res.branchName } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
    }
  } catch (err) {
    logForDebugging(`[concourse/dispatch] held replay failed for ${rec.clientMessageId}: ${err}`)
    return {
      clientMessageId: rec.clientMessageId,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The SB-C1 claim fold at the deny door: a live claim on this folder —
 *  pid-alive or attached, unended, unparked — exactly the admission's own
 *  liveWorkers arm (a parked record holds no claim; stop released its). */
export function folderClaimHeld(folder: string, dir?: string): boolean {
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readSessionWorkers(dir)).some(
    r =>
      r.endedAt === undefined &&
      r.parkedAt === undefined &&
      r.workspaceId === canonical &&
      ((r.pid !== undefined && isProcessAlive(r.pid)) || r.attachedAt !== undefined),
  )
}

/** THE RULED No LEG's gate: what
 *  a git-offer DENY may lawfully start — the OLDEST launch held on git in
 *  this folder whose isolation was DEFAULTED (an explicit worktree pick is
 *  never overridden to exclusive; it stays queued), and only while NO live
 *  claim holds the folder (a held folder admits nothing — those stay
 *  queued, and nothing re-asks). ONE row by design: the ruled sentence is
 *  "runs in this folder as it is, ALONE" — a second defaulted launch would
 *  collide the moment the first admits and re-mint the ask the operator
 *  just declined. Sync projection for the deny receipt; the async replay
 *  below rides the same idempotent door. */
export function denyProceedLaunchesFor(
  folder: string,
  dir?: string,
): ReadonlyArray<{ clientMessageId: string; title?: string }> {
  if (folderClaimHeld(folder, dir)) return []
  const canonical = canonicalWorkspaceId(folder)
  return Object.values(readConcourseDispatches(dir))
    .filter(r => {
      const hold = normalizeHoldReason(r.heldReason)
      return (
        r.sessionId === undefined &&
        r.heldOp !== undefined &&
        r.heldOp.isolation === undefined &&
        r.workspaceId === canonical &&
        (hold === 'no-repository' || hold === 'unborn-head' || hold === 'git-unavailable')
      )
    })
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
    .slice(0, 1)
    .map(r => ({ clientMessageId: r.clientMessageId, ...(r.title !== undefined ? { title: r.title } : {}) }))
}

/** The deny-proceed replay: the gated row (re-derived — the gate is the
 *  law) replays VERBATIM through the same door; on a free folder the
 *  defaulted fold admits it EXCLUSIVE — it runs in the folder as it is,
 *  alone. A replay that holds again (a race took the folder) stays visible
 *  with its own reason — never a silent drop, never a re-ask from here. */
export async function replayDenyProceedDispatches(
  folder: string,
  dispatch: (req: ConcourseDispatchRequest) => Promise<ConcourseDispatchResult>,
  dir?: string,
): Promise<ReadonlyArray<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }>> {
  const rows = denyProceedLaunchesFor(folder, dir)
  const dispatches = readConcourseDispatches(dir)
  const out: Array<{ clientMessageId: string; title?: string; ok: boolean; sessionId?: string; branchName?: string; error?: string }> = []
  for (const row of rows) {
    const rec = dispatches[row.clientMessageId]
    if (rec?.heldOp === undefined) continue
    out.push(await replayHeldRecord(rec, dispatch))
  }
  return out
}
