// ============================================================================
// concourseSupervisor — the Session Concourse supervisor
// role at the daemon's crewSpawn seam.
//
//  The supervisor owns ONLY: worker admission (the SERVER-SIDE five-runtime
//  lease — the crewSpawn spend-guard discipline), canonical workspace
//  identity (RR-01: realpath+NFC at admission), the durable worker⇄session⇄
//  workspace relationship records, and crash reconciliation. Workers are
//  ordinary roster long-lived children (registerLongLived → the proven
//  headless stream-json invocation: no Ink, no TTY, structured piped IPC,
//  drains kept hot by the roster). It is NOT a second transcript store,
//  event store, or daemon — and the renderer NEVER adopts a worker's session
//  through the REPL switch machinery (the no-adoption law).
//
//  Identity: the supervisor MINTS each worker's runtime SessionId and pins
//  it with `--session-id` on first spawn — the worker's transcript IS a real
//  resumable Mercury session named before the child exists (no init-frame
//  race). A roster RESPAWN of the same worker must NOT re-run --session-id
//  (an existing transcript exits 1 "already in use"): the spec carries
//  respawnExtraArgv = ['--resume', <id>] and the roster's capped-backoff
//  path builds with {respawn: true} — the same durable chat continues.
//
//  Worker env hygiene (the adopted CH-01 adjudication, enforced at THIS
//  spawn seam via the spec's stripEnv): a session worker must never inherit
//  the supervisor's session room (it owns session-<its-own-id>), a splash
//  handoff, a launcher alt-hold, a launch id, or a guest room token — those
//  are the visible process's terminal/launch identity, and inheriting any of
//  them is the worker-terminal-inheritance class.
// ============================================================================
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from '../utils/crypto.js'
import { recordToEntry } from '../fabric/entryCodec.js'
import { billingSafeRetainedForm, servedModelOfAssistantRow } from '../utils/model/retainedModel.js'
import { logForDebugging } from '../utils/debug.js'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import { flagSpellings } from '../substrate/flagRegistry.js'
import { resolveEffectiveSettingsSnapshot } from '../substrate/startupMenu.js'
import { getProcessStartToken, getProcessStartTokenCachedOrRefresh, isProcessAlive } from './ownerWatch.js'
import { daemonDir } from './controlSocket.js'
import { decideTransition, type ConcourseSessionState } from './concourseLifecycle.js'
import { ensureWorkerWorktree, reapWorkerWorktree, workspaceKindOf } from './concourseWorktrees.js'
import type { CrewRosterPort } from './crewSpawn.js'
import { foldLegacyWorkerModelKey, validateWorkerModelChoice } from '../services/concourse/workerModels.js'
import { describeSeatReading, resolveSeatCeiling } from '../services/switchboard/capacityCheck.js'
import { retireSeatProjections } from '../services/engine-connector/seatProjections.js'
import type { StreamJsonChildSpec } from './headlessRun.js'
import { HEADLESS_PERMISSION_MODES, type HeadlessPermissionMode } from './headlessRun.js'
import { decodePermissionModeSpelling, type PermissionMode } from '../types/permissions.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { EFFORT_LEVELS, normalizeEffortLevelString } from '../utils/effort.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../utils/sessionStorage/transcriptReader.js'
import { splitAppendSystemPrompt } from '../services/switchboard/runnerArgv.js'
import { writeSessionCloseReceipts } from '../services/switchboard/sessionReceipts.js'
import { deriveSessionKitForPreset, deriveSessionKitForWorkspace, kitStampOf, noteRecordlessResumeKit, restampSessionKit, type KitStampSource, type SessionKitV1 } from './sessionKit.js'

/** the hard global live-session ceiling. Auto may lower ACTIVE
 *  admission on a smaller machine (the governor's job); nothing raises
 *  this. */
// The runtime ceiling is the MACHINE's own seat reading (the operator's
// line-6 ruling: sessions run concurrently, as many as the machine can
// carry — never an artificial cap). effectiveSeatCeiling() below is the one
// derivation; the retired hard constant does not survive.

/** Worker shorts are roster identities: concourse-w1..concourse-w5. */
export const CONCOURSE_SHORT_PREFIX = 'concourse-w'

// ── canonical workspace identity (RR-01) ────────────────────────────────────

/**
 * Canonicalize a workspace path at ADMISSION (RR-01, adopted): realpath (so
 * case/symlink/separator aliases collapse) + NFC (so composed/decomposed
 * unicode agrees), with the File-Provider EPERM fallback session-identity
 * uses. Identical relative paths in different workspaces stay distinct
 * because the id is the absolute canonical root.
 */
export function canonicalWorkspaceId(dir: string): string {
  try {
    return realpathSync(dir).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

// ── the pure admission decision (frozen by repro-five-lease) ────────────────

/** 'shared' (L19, the solo in-place law): the operator's OWN chat doors —
 *  New Session, every --chat birth, a record-less resume — claim the ground
 *  itself and coexist with each other, exactly like terminal tabs in one
 *  repo. It still collides with 'exclusive' in both directions: a
 *  coordinator dispatch's sole-mutator guarantee holds, and a defaulted
 *  dispatch beside solo chats folds to its worktree as ever. */
export type WorkspaceIsolation = 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'

export interface WorkspaceClaim {
  workspaceId: string
  /** Absent ⇒ 'exclusive' (the conservative default: one mutating session). */
  isolation?: WorkspaceIsolation
}

/** every refusal carries its executable MOVES beside the
 *  block — typed, so no negotiation sentence dies in an 80-char label clamp
 *  downstream. The label is operator copy; the verb is machine vocabulary. */
export interface ConcourseMoveV1 {
  verb: 'worktree' | 'read-only' | 'queue' | 'pause-holder' | 'revive' | 'retry' | 'init-git'
  label: string
}

export type AdmissionDecision =
  | { admit: true }
  | {
      admit: false
      reason: string
      code: 'runtime-ceiling' | 'workspace-collision'
      moves?: ConcourseMoveV1[]
    }

/**
 * The five-lease's deterministic core: pure over ALREADY-canonical claims —
 * the handler canonicalizes (RR-01) before folding. Refusals happen BEFORE
 * any worker/provider use, with the reason preserved for the caller's draft.
 * `ceiling` lets the stored first-boot capacity
 * decision LOWER admission; callers pass it resolved — the function stays
 * pure, and the default keeps every existing caller byte-identical.
 */
export function evaluateConcourseAdmission(
  live: readonly WorkspaceClaim[],
  req: WorkspaceClaim,
  ceiling: number = effectiveSeatCeiling(),
): AdmissionDecision {
  if (live.length >= ceiling) {
    return {
      admit: false,
      code: 'runtime-ceiling',
      reason: `every seat is taken — ${describeSeatReading(ceiling)}`,
      moves: [
        { verb: 'queue', label: 'it queues and starts when a seat frees' },
        { verb: 'pause-holder', label: 'or stop a running session to free one' },
      ],
    }
  }
  const reqIso = req.isolation ?? 'exclusive'
  for (const claim of live) {
    if (claim.workspaceId !== req.workspaceId) continue
    const liveIso = claim.isolation ?? 'exclusive'
    const bothReadOnly = liveIso === 'read-only' && reqIso === 'read-only'
    const eitherIsolated = liveIso === 'worktree-isolated' || reqIso === 'worktree-isolated'
    // L19: solo in-place sessions coexist with each other on the ground.
    const bothShared = liveIso === 'shared' && reqIso === 'shared'
    if (bothReadOnly || eitherIsolated || bothShared) continue
    return {
      admit: false,
      code: 'workspace-collision',
      reason: `the repo's main checkout is held by a live session`,
      moves: [
        { verb: 'worktree', label: 'replay the launch — it forks a worktree of its own' },
        { verb: 'queue', label: 'or wait — it starts when the checkout frees' },
      ],
    }
  }
  return { admit: true }
}

// ── durable worker records (LIFECYCLE-registered class) ─────────────────────

export interface ConcourseWorkerRecordV1 {
  schema: 1
  /** Roster short (concourse-wN) — the process-management identity of the
   *  RUNNER hosting the session (R2 of the wire/schema renames, Law 9: the
   *  session is the unit; `workerId` was the coordinator-frame spelling).
   *  Old files on disk still carry `workerId`: the one reader below folds it
   *  onto this field forever, and the record rewrites under the new spelling
   *  when next written. */
  runnerId: string
  /** The minted runtime SessionId — the canonical session identity. */
  sessionId: string
  /** RR-01 canonical workspace root. */
  workspaceId: string
  isolation: WorkspaceIsolation
  /** The validated CANONICAL model id from the one callable-model owner
   *  (ruled; legacy crew keys in old records fold at use). */
  modelKey: string
  /** A KEYLESS birth (no credential anywhere at admission): the runner
   *  booted with no --model and resolves its own; modelKey above is the
   *  display placeholder. A resume of this record re-validates UNNAMED
   *  (resumeModelKeyOf skips it), so a sign-in landing later takes the
   *  neutral default, never the placeholder's family. */
  keyless?: true
  /** SR-086: the operator's agent handle for this worker — the board's
   *  OWNER column ('Mercury', '@test', …); sanitized at admission. */
  agentName?: string
  /** SR-086: the per-session background-seat ceiling chosen at dispatch. */
  seatsMax?: 1 | 2
  /** The operator's word: the spawn-captured effort (validated EffortLevel;
   *  absent in pre-existing records ⇒ the 'high' convention). */
  effort?: string
  spawnedAt: number
  /** Present once the worker settled (released, crashed unreconciled, or
   *  reaped) — a terminal record never reopens; a NEW admission mints a new
   *  runnerId. */
  endedAt?: number
  /** The durable pause receipt — the 'positive
   *  pause/settlement receipt' IS this record mutation. While set, the
   *  DELIVERY VALVE is closed: the one dispatch owner refuses deliveries to
   *  this worker (the in-flight turn finishes on its own — a pause never
   *  signals, stops, or destroys). Cleared by resume (paused→starting). */
  pausedAt?: number
  pausedBy?: string
  /** A model switch the focused chat asked for while the session was
   *  mid-turn — parked here (the daemon is the settlement owner) and
   *  applied at the turn's end; the facts projection shows it as pending. */
  pendingModelKey?: string
  /** The effort sibling of pendingModelKey (the set-effort verb parks a
   *  mid-turn switch the same way; the idle edge applies it). */
  pendingEffort?: string
  /** The kit-dial sibling (the operator's mid-turn ruling —
   *  apply at the NEXT LAWFUL BEAT): dials asked mid-turn park here with
   *  their asker and drain at the idle edge or the seat's respawn, each
   *  through the record's one writer, then ONE forward to the child. */
  pendingKitEdits?: Array<{ edit: import('./sessionKit.js').SessionKitEditV1; by: string }>
  /** THE SPAWN SWITCHES the operator toggled inside this session
   *  (services/switchboard/spawnSwitches.ts — /subagents, /workflows, the
   *  boot menu opened in-session): the durable truth a respawn re-forwards
   *  to the fresh child. Absent = never toggled — the admission's settings
   *  snapshot (the boot menu's Agents rows at birth) decides. */
  spawnSwitches?: Partial<Record<'subagents' | 'workflows', 'on' | 'off'>>
  /** A toggle asked mid-turn parks here with its asker and lands at the
   *  idle edge or the seat's respawn (the kit dial's beat) — the last
   *  toggle per switch wins. */
  pendingSpawnSwitches?: Array<{ kind: 'subagents' | 'workflows'; on: boolean; by: string }>
  /** Last positively-observed liveness (spawn pid check / reconcile pass). */
  lastLiveAt: number
  pid?: number
  /** The runner pid's process START TOKEN, stamped beside the pid at
   *  admission, revive, reactivate and respawn (release-hardening audit
   *  rank 46): a bare pid pinned a dead session running-but-dead once the
   *  number was reused — the one identity vocabulary (ownerWatch start
   *  tokens, the supervisor-record and pidLock precedent) lets every
   *  liveness read tell the runner from a stranger that inherited its
   *  pid. Absent on pre-token records — those read pid-alone, the old
   *  verdict. */
  procStart?: string
  /** (board truth): the roster stamps these at its OWN turn seams —
   *  reply() (a user frame written to stdin) and the stdout drain's result
   *  frame. A live worker whose last turn SETTLED after its last delivery
   *  paints ready-to-review, never a fabricated 'working'. */
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  /** BORN BLANK (the one-door law): stamped when the session was born
   *  through New Session with no words — a NEWBORN until its first delivery
   *  (`lastDeliveryAt`). The idle reaper's birth grace and the reconcile's
   *  dead-newborn release read exactly this pair; absent on board-dispatched
   *  and resumed records. */
  bornBlankAt?: number
  /** The immutable effective-settings snapshot captured at ADMISSION,
   *  stored WHOLE (durable provenance — per-row value/source/class survive
   *  any later profile/env change); established sessions never silently
   *  observe a later profile, and RE-admission of the same durable session
   *  retains the ORIGINAL capture. Absent on pre-profile
   *  records. */
  settingsSnapshot?: import('../substrate/startupMenu.js').SessionEffectiveSettingsSnapshotV1
  /** the fork's branch, minted ONCE at admission
   *  (mercury/<slug> off the latest local main) — the ONE branch truth every
   *  surface reads; the UI never re-derives it (title slugs collide, retitles
   *  drift). Present iff the worktree was carved in branch mode. */
  branchName?: string
  /** The worker's isolated worktree (present iff isolation is
   *  'worktree-isolated') — the worker's cwd; the CLAIM stays the canonical
   *  repository root. Reaped at settle/reconcile under the dirt law. */
  worktreePath?: string
  /** The typed workspace capability (the plain-folder half) —
   *  'plain-folder' admits honestly with git-only actions refused typed. */
  workspaceKind?: 'git' | 'plain-folder'
  /** The session's stored title (rides the dispatch op; /title and the
   *  board's rename write it; the one-time mint fills it when empty) — the
   *  board and peek speak THIS through the naming owner, never the worker
   *  short (a board painting 'concourse-w1' rows is the title-loss failure
   *  class; session-aware naming, L16). */
  title?: string
  /** Who named it: the operator's typed word, or the one-time model mint.
   *  The mint fills an EMPTY title only — a typed name is never overwritten. */
  titleSource?: 'operator' | 'minted'
  /** The mint's once-ever stamp (set exactly when a minted title lands):
   *  the mint never runs twice for a session, whatever happens later. */
  titleMintedAt?: number
  /** (enter = one-terminal full swap): set while the
   *  OPERATOR's terminal owns this session — the daemon child is dead by
   *  handover, the delivery valve is closed (deliveries hold and replay
   *  after detach, the plain-resume grammar), and foreign adoption is
   *  refused (the no-adoption oracle answers owned). Cleared by detach. */
  attachedAt?: number
  attachedBy?: string
  /** Drive-12 (the PAUSED-honesty law): the ENTER valve — set from the first
   *  attach request through the boundary (the drain/follow window) so no
   *  NEW turn arms while the operator's terminal is taking over. This is NOT
   *  a pause: pausedAt means the OPERATOR/coordinator paused the session
   *  and is what paints PAUSED. Stamping the valve on pausedAt made every
   *  entered session read PAUSED for its whole drain, and a cancelled or
   *  refused leave left it standing (the flip-back-on-its-own ghost). */
  attachRequestedAt?: number
  attachRequestedBy?: string
  /** SB-C4 (close audit): the most recent attach GRANT (applied or noop) —
   *  a detach whose hand-back marker was minted BEFORE this stamp is stale
   *  (the operator re-entered since) and refuses instead of respawning a
   *  child under the attached terminal. */
  lastAttachGrantAt?: number
  /** (operator-ruled, the x gesture): the session
   *  was STOPPED — its child is dead by intent, the record stays on the
   *  board as 'stopped' until the second x (release) removes it. */
  stoppedAt?: number
  stoppedBy?: string
  /** Sweep #2 rider R5: the stop was the daemon's idle retirement of
   *  an EMPTY session (no conversation, no pending work, no attachment or
   *  pause, idle past the registered threshold) — a typed settlement fact
   *  the session list paints, never a silent disappearance (law 1). */
  retired?: { reason: 'idle-empty'; idleMs: number; thresholdMs: number; at: number }
  /** The CRASH fact (the session-end visibility law): the child died
   *  without a clean result — stamped by the roster's crash supervision
   *  (`respawning: true` while its backoff loop keeps relaunching, false at
   *  degrade) and by the boot reconcile that finds a record dead with its
   *  daemon (`respawning: false`). The board paints the row NEEDS YOU with
   *  this reason line and NEVER removes it; only the operator's own acts
   *  clear the fact (a delivery, an enter, a stop) and only their release
   *  removes the row. */
  crash?: { at: number; reason: string; respawning: boolean }
  /** The boot's runner-side options the session was created with (the one
   *  table in services/switchboard/runnerArgv.ts) — a respawn or a resume
   *  runs the session with the same options. Absent on records from a
   *  board launch. */
  runnerArgv?: string[]
  /** (the workflows-allowed tag, operator-ruled):
   *  while set, THIS session may launch subagents/workflows while
   *  backgrounded, up to the default budget. At most ONE standing tag —
   *  grant refuses a second in plain words. Granted by a spoken coordinator
   *  ask naming workflows/subagents, the keep-and-background leave choice,
   *  or the manual-start option; merely visiting never confers it. */
  workflowsAllowed?: true
  workflowsGrantedBy?: string
  workflowsGrantedAt?: number
  /** THE FOCUS FACT (Law 9 rule 4 — "exactly ONE focused chat" — made
   *  durable): set while THIS session is the chat a live terminal is
   *  looking at. One writer, the daemon's focus/blur verbs: the hop stamps
   *  the chat it lands on and clears the one it left under the same
   *  focusedBy ('operator:<terminal pid>', the attachedBy grammar), so the
   *  operator's seat moves with their focus and nothing is cached across a
   *  hop; one-door's create-on-Enter births a session focused THROUGH the
   *  same verb. The reconcile pass clears a stamp whose terminal pid is
   *  dead; a settle ends the fact with the record. First reader: the
   *  launch-authority valve — the chat the operator is INSIDE launches
   *  workflows and agents on their own authority; an unfocused runner stays
   *  grant-gated. */
  focusedAt?: number
  focusedBy?: string
  /** PARKED (the control-plane model — a record state distinct
   *  from crashed and from ended): the operator CLOSED this chat — released
   *  it from the bridge, /clear'd it, quit the screen — so it is not active:
   *  its runner is dead by intent (or finishing its last turn under a park
   *  request), its record and transcript stay, and the board paints
   *  "parked · <age>" with no motion. Never crashed (the reconcile leaves a
   *  parked record alone), never lost (↵ on the row reactivates it in place
   *  through the one resume door). Cleared by the reactivate; ended only by
   *  the operator's own x-x release. `parkReason` is the one-line reason a
   *  failed reactivate leaves on the row. */
  parkedAt?: number
  parkedBy?: string
  parkReason?: string
  /** A park requested on a session MID-TURN: the runner finishes its own
   *  turn, then retires into parked at the turn-settled edge
   *  (completeRequestedPark); a runner found dead with the request standing
   *  converges to parked at the reconcile. */
  parkRequestedAt?: number
  parkRequestedBy?: string
  /** THE ADVISORY CONTRACT (coordinator-tooling ledger T1–T6): the session's
   *  work agreement — additive (the pendingEffort precedent: old readers
   *  unaffected), never deleted (it amends or closes; the record's own
   *  retention). ADVISORY ALWAYS: no reader may gate a tool, a dispatch or
   *  an admission on it. One writer: sessionContract.ts's verb, over the
   *  wire as the sessionControl action 'contract'. */
  contract?: import('./sessionContract.js').SessionContractV1
  /** THE SESSION'S KIT (ledger L24; daemon/sessionKit.ts): the MCP servers,
   *  skills and extensions this session runs with — RESOLVED at birth from
   *  the menu (carried by the screen, else derived here) and owned by the
   *  session afterward. Additive: ABSENT on every pre-kit record = whole-
   *  config behaviour, never healed into an empty kit (empty loads
   *  NOTHING). A live session keeps it whatever the menu does; a
   *  reactivation RE-STAMPS it from the current menu — the deliberate
   *  opposite of the retained model/effort/settingsSnapshot above — and the
   *  displaced kit goes to the session receipt as history. Three writers
   *  only: the admission stamp, the reactivation re-stamp, the
   *  sessionControl action 'set-kit'. */
  kit?: import('./sessionKit.js').SessionKitV1
  /** SATURN (the scheduler reborn; daemon/saturn.ts): the session's OWN
   *  schedules — session facts, daemon-fired, reactivation-surviving,
   *  receipted, MULTIAUTH-NATIVE (each row carries its first-class
   *  account). Additive: absent on every pre-Saturn record; ABSENT ≠ EMPTY
   *  — the last remove drops the field whole, never a healed []. One
   *  writer: daemon/saturn.ts (applyConcourseScheduleOp, over the wire as
   *  the sessionControl action 'set-schedule', plus the ticker's fire-side
   *  pens there). Restart/reactivation retention: the operator's fork-(ii)
   *  ruling lands with the engine. */
  schedules?: import('./saturn.js').SaturnScheduleV1[]
  /** SATURN's held fires (the founding law): a fire that cannot run on the
   *  session's OWN account HOLDS here — typed reason, frozen replay
   *  envelope, receipted, painted ("held: sign-in expired — /logins
   *  releases N held fires"), replayed WHOLE when the hold lifts. Never a
   *  cross-family fallback, never a silent drop. Engine-fed (the ticker);
   *  absent when none — the last release drops the field. */
  heldFires?: import('./saturn.js').HeldFireV1[]
}

/** A newborn: born blank through New Session and never messaged — the
 *  birth grace's and the close paths' one definition. */
export function isNewbornRecord(rec: Pick<ConcourseWorkerRecordV1, 'bornBlankAt' | 'lastDeliveryAt'>): boolean {
  return rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined
}

/** A turn in flight: the last delivery has not settled (the attach yield's
 *  own formula) — read against a runner known alive. */
export function turnInFlightOf(rec: Pick<ConcourseWorkerRecordV1, 'lastDeliveryAt' | 'lastTurnSettledAt'>): boolean {
  return rec.lastDeliveryAt !== undefined && (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
}

// ── typed collision evidence ──────────────────────────

export interface CollisionEvidenceV1 {
  schema: 1
  /** 'exclusive-overlap' = an admission REFUSED on a held workspace (the
   *  observed collision); 'authored-work-retained' = a reap REFUSED because
   *  authored work was present (the visible retention). */
  kind: 'exclusive-overlap' | 'authored-work-retained'
  workspaceId: string
  /** The evidence file's own persisted grammar keeps the workerId spelling
   *  (it is not the session-record schema R2 renamed); writers map the
   *  record's runnerId onto it. */
  holders: Array<{ workerId: string; sessionId?: string; isolation?: WorkspaceIsolation }>
  observedAt: number
  refusedClientMessageId?: string
  detail?: string
  /** Present on retention rows: the exact authored files (bounded). */
  files?: string[]
  /** the retained fork's branch — the merge-back
   *  handoff names it and the board's READY TO REVIEW row wears it. */
  branchName?: string
  /** Set when the merge-back handoff APPLIED (redirect delivered or a merge
   *  session launched) — exactly-once consumption; unconsumed rows re-batch
   *  into the next finished tree's handoff. */
  consumedAt?: number
}

interface CollisionFileV1 {
  version: 1
  rows: CollisionEvidenceV1[]
}

const COLLISION_EVIDENCE_CAP = 100

export function concourseCollisionsPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-collisions.json')
}

export function readCollisionEvidence(dir?: string): CollisionEvidenceV1[] {
  try {
    const raw = JSON.parse(readFileSync(concourseCollisionsPath(dir), 'utf8')) as CollisionFileV1
    if (!raw || raw.version !== 1 || !Array.isArray(raw.rows)) return []
    return raw.rows
  } catch {
    return []
  }
}

/** Append one typed evidence row (bounded FIFO — newest retained). */
export function recordCollisionEvidence(row: CollisionEvidenceV1, dir?: string): void {
  const rows = [...readCollisionEvidence(dir), row].slice(-COLLISION_EVIDENCE_CAP)
  // DURABILITY: the ONE publication primitive — bytes identical to the
  // hand-rolled writer it replaced.
  durableAtomicPublishSync(
    concourseCollisionsPath(dir),
    `${JSON.stringify({ version: 1, rows } satisfies CollisionFileV1, null, 1)}\n`,
  )
}

/** mark retained-work evidence CONSUMED once its merge-back
 *  handoff applied — exactly-once; unconsumed rows re-batch next time. */
export function markCollisionEvidenceConsumed(
  workspaceId: string,
  workerIds: readonly string[],
  dir?: string,
): void {
  const ids = new Set(workerIds)
  const rows = readCollisionEvidence(dir).map(row =>
    row.kind === 'authored-work-retained' &&
    row.workspaceId === workspaceId &&
    row.consumedAt === undefined &&
    row.holders.some(h => ids.has(h.workerId))
      ? { ...row, consumedAt: Date.now() }
      : row,
  )
  durableAtomicPublishSync(
    concourseCollisionsPath(dir),
    `${JSON.stringify({ version: 1, rows } satisfies CollisionFileV1, null, 1)}\n`,
  )
}

interface ConcourseWorkerFileV1 {
  version: 1
  workers: Record<string, ConcourseWorkerRecordV1>
}

export function concourseWorkersPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-workers.json')
}

/** Validated fail-soft read — a torn/foreign file reads as empty (the
 *  reconcile pass rebuilds truth from the roster; never a boot dependency).
 *  The workers read, named for sessions (R1's fifth identifier — it was
 *  readConcourseWorkers). */
export function readSessionWorkers(dir?: string): Record<string, ConcourseWorkerRecordV1> {
  try {
    const raw = JSON.parse(readFileSync(concourseWorkersPath(dir), 'utf8')) as ConcourseWorkerFileV1
    if (!raw || raw.version !== 1 || typeof raw.workers !== 'object') return {}
    // TOLERATED LEGACY SPELLING (R2, read side): a record written before the
    // runnerId rename carries `workerId` — folded onto runnerId here, at the
    // ONE read door, and dropped so the next write rewrites the record under
    // the new spelling alone. No file-version bump: every older build reads
    // version 1 (a bump would read as an empty board there), so the
    // both-spellings read IS the migration. Retirement condition: only when
    // a schema-2 rewrite of all records ever exists — records persist
    // indefinitely, so this fold has no proto-keyed retirement.
    for (const rec of Object.values(raw.workers)) {
      const legacy = rec as ConcourseWorkerRecordV1 & { workerId?: string }
      if (legacy.runnerId === undefined && typeof legacy.workerId === 'string') {
        legacy.runnerId = legacy.workerId
      }
      delete legacy.workerId
    }
    return raw.workers
  } catch {
    return {}
  }
}

/** (board truth): the roster's turn seams stamp the record — a user
 *  frame written to the worker's stdin marks a delivery; the stdout
 *  drain's result frame marks the turn settled. Both publish (and so
 *  stamp the delta below): the board's working/ready-to-review split is a
 *  RECORD fact, never a liveness guess. No-ops for unknown/ended ids. */
export function markConcourseWorkerDelivery(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.lastDeliveryAt = Date.now()
        // The operator's own words landing IS the acknowledgement — a
        // standing crash fact clears (the visibility law's clear side).
        delete rec.crash
        // The contract lifecycle's acknowledged→active promotion (the one
        // invention the five-status cycle needed — sessionContract.ts names
        // the law; strike-able): a delivery landing on an acknowledged
        // contract means the session keeps working under it. Bookkeeping on
        // the record's one writer; gates nothing.
        if (rec.contract !== undefined && rec.contract.status === 'acknowledged') {
          rec.contract.status = 'active'
        }
      }
    }, dir)
  } catch {
    /* projection only — delivery itself already succeeded */
  }
}

export function markConcourseWorkerTurnSettled(runnerId: string, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) rec.lastTurnSettledAt = Date.now()
    }, dir)
  } catch {
    /* projection only */
  }
}

/**
 * The CRASH stamp (the session-end visibility law): a child death without a
 * clean result becomes a DURABLE record fact the board paints — NEEDS YOU
 * with the reason line — never a silent removal or a fabricated
 * ready-to-review. One 'failed' journal per crash EPISODE: a record already
 * carrying a crash fact re-stamps quietly (a respawn loop is one episode;
 * the operator's next act clears the fact and re-arms the journal).
 */
export function markConcourseWorkerCrash(
  runnerId: string,
  crash: { reason: string; respawning: boolean },
  dir?: string,
): void {
  let journal = false
  let sessionId: string | undefined
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        journal = rec.crash === undefined
        sessionId = rec.sessionId
        rec.crash = { at: Date.now(), reason: crash.reason, respawning: crash.respawning }
      }
    }, dir)
  } catch {
    /* projection only — the crash evidence itself lives in the roster/exit ledger */
  }
  if (journal) {
    void import('../services/notificationPolicy.js')
      .then(policy =>
        policy.journalConcourseSignal({
          kind: 'failed',
          targetId: runnerId,
          revision: Date.now(),
          title: 'session crashed',
          detail: `worker ${runnerId}: ${crash.reason}`,
          ...(sessionId !== undefined ? { deepLink: { sessionId } } : {}),
          obligationBacked: false,
        }),
      )
      .catch(err => {
        logForDebugging(`[concourse] failed-signal journal failed for ${runnerId}: ${err}`)
      })
  }
}

/** The pid fields for a worker record: the pid plus the runner's start
 *  token whenever the one token owner can answer synchronously
 *  (release-hardening audit rank 46 — the identity that outlives pid
 *  reuse). Vocabulary: null = unknowable (omit), '' = gone (omit). */
function pidFieldsOf(pid: number | undefined): { pid?: number; procStart?: string } {
  if (pid === undefined) return {}
  const token = getProcessStartToken(pid) ?? getProcessStartTokenCachedOrRefresh(pid)
  return { pid, ...(token !== null && token !== '' ? { procStart: token } : {}) }
}

/** THE session-runner liveness owner (release-hardening audit rank 46): a
 *  recorded pid counts as the runner only while its identity holds — pid
 *  alive AND, where a start token was stamped, the live token matching. A
 *  reused pid (the runner died; an unrelated process inherited the
 *  number) reads DEAD, so the reconcile settles the row instead of
 *  pinning it running-but-dead (enter answered already-live onto nothing,
 *  stop refused with no-kill-channel, re-attach refused for a terminal
 *  that no longer exists). Ambiguity stays alive — never a death verdict
 *  from a probe glitch. */
function workerPidAlive(rec: { pid?: number; procStart?: string }): boolean {
  if (rec.pid === undefined || !isProcessAlive(rec.pid)) return false
  if (rec.procStart !== undefined) {
    // The CACHED token reader only: these reads sit on
    // steady-cadence probe and render paths, where the sync form's
    // spawn-per-read would stall the loop. A cold miss reads null
    // (unknowable ⇒ alive) and converges on the next read.
    const current = getProcessStartTokenCachedOrRefresh(rec.pid)
    if (current === '') return false
    if (current !== null && current !== rec.procStart) return false
  }
  return true
}

/** R7 C-HIGH-1: the record's pid is written at admission; the roster's
 *  crash-respawn re-points only its in-memory entry, so every raw record
 *  reader (dispatch liveness, board state, pause gate, the no-adoption
 *  guard, seat counting) would treat the respawned-live session as dead
 *  forever. The respawn is a RECORD fact too — stamp it here. */
export function markConcourseWorkerRespawn(runnerId: string, pid: number, dir?: string): void {
  try {
    updateConcourseWorkers(workers => {
      const rec = workers[runnerId]
      if (rec && rec.endedAt === undefined) {
        rec.pid = pid
        // The NEW pid's token — a stale token from the old pid must never
        // outlive the respawn.
        const fields = pidFieldsOf(pid)
        if (fields.procStart !== undefined) rec.procStart = fields.procStart
        else delete rec.procStart
        rec.lastLiveAt = Date.now()
      }
    }, dir)
  } catch {
    /* projection only — the respawn itself already succeeded */
  }
}

/** (the H ruling's board-truth channel): the delta STAMP beside the
 *  roster — every published transition bumps a monotonic revision (scoped
 *  by pid; a daemon restart is a full-refresh signal, not a rewind). UIs
 *  fs.watch the stamp and rebuild on change: push over poll, with the
 *  revision guarding duplicate wakes. */
export function concourseDeltaPath(dir: string = daemonDir()): string {
  return join(dir, 'concourse-delta.json')
}

export interface ConcourseDeltaStampV1 {
  version: 1
  revision: number
  pid: number
  at: number
}

let concourseDeltaRevision = 0

function stampConcourseDelta(dir?: string): void {
  try {
    concourseDeltaRevision += 1
    durableAtomicPublishSync(
      concourseDeltaPath(dir),
      `${JSON.stringify({ version: 1, revision: concourseDeltaRevision, pid: process.pid, at: Date.now() } satisfies ConcourseDeltaStampV1)}\n`,
    )
  } catch {
    /* the stamp is a projection — never fail the roster publish */
  }
}

function publishConcourseWorkers(workers: Record<string, ConcourseWorkerRecordV1>, dir?: string): void {
  durableAtomicPublishSync(
    concourseWorkersPath(dir),
    `${JSON.stringify({ version: 1, workers } satisfies ConcourseWorkerFileV1, null, 1)}\n`,
  )
  stampConcourseDelta(dir)
}

export function updateConcourseWorkers(
  mutate: (workers: Record<string, ConcourseWorkerRecordV1>) => void,
  dir?: string,
): Record<string, ConcourseWorkerRecordV1> {
  const workers = readSessionWorkers(dir)
  mutate(workers)
  publishConcourseWorkers(workers, dir)
  return workers
}

// ── the worker spec (CH-01 env hygiene at the spawn seam) ───────────────────

/** Launch/terminal identity a session worker must NEVER inherit (both flag
 *  spellings, mechanically): the splash handoff, the launcher alt-hold, the
 *  launch id. */
export function concourseWorkerStripEnv(): string[] {
  return [
    'MERCURY_SPLASH_HANDOFF',
    'MERCURY_ALT_HELD',
    'MERCURY_LAUNCH_ID',
    // THE NON-SESSION INSULATION (lead-named pin): a
    // STRAY session-kit spelling in the daemon's own env must never reach a
    // child — the strip runs BEFORE the extraEnv overlay, so the worker
    // spec's own deliberate stamp still lands, and a WARM runner (no stamp)
    // boots clean. Only the spec's stamp can ever speak for a session.
    'MERCURY_SESSION_KIT',
  ].flatMap(flagSpellings)
}

/** THE SEAT'S INITIAL PERMISSION MODE (the operator's line-10 parity edit at
 *  the unsoldering signing): a seat is a full Mercury instance, so it boots in
 *  the OPERATOR'S SAVED DEFAULT (settings.permissions.defaultMode) when one is
 *  set — never a posture MORE permissive than the operator's own by accident.
 *  A dispatch may carry an explicit override (the optional
 *  ConcourseAdmitRequest.permissionMode). When neither is set — no saved
 *  default, nothing carried — the fallback stays today's 'flow' for
 *  board-spawned workers. Only a mode that is a valid HEADLESS posture crosses;
 *  anything else (e.g. a saved 'plan') falls back to 'flow' rather than boot a
 *  seat in an unintended posture. Fail-soft: an unreadable settings store is
 *  the 'flow' fallback, never a boot block. */
export function seatInitialPermissionMode(override?: PermissionMode): HeadlessPermissionMode {
  const asHeadless = (mode: string | undefined): HeadlessPermissionMode | undefined => {
    if (mode === undefined || mode.length === 0) return undefined
    const decoded = decodePermissionModeSpelling(mode)
    return (HEADLESS_PERMISSION_MODES as readonly string[]).includes(decoded) ? (decoded as HeadlessPermissionMode) : undefined
  }
  const carried = asHeadless(override)
  if (carried !== undefined) return carried
  try {
    const saved = asHeadless(getInitialSettings().permissions?.defaultMode)
    if (saved !== undefined) return saved
  } catch {
    /* an unreadable settings store falls back to flow — never blocks a spawn */
  }
  return 'flow'
}

export function buildConcourseWorkerSpec(args: {
  runnerId: string
  /** Absent only for a WARM spawn (warm: true) — the claim control assigns
   *  the id before the first turn; every claimed/cold boot carries one. */
  sessionId?: string
  workspaceId: string
  /** Canonical model id (legacy crew keys in durable records fold here —
   *  a live session is never refused a respawn over registry drift). */
  modelKey: string
  /** The keyless admission: the runner boots with no --model. */
  keyless?: true
  /** The per-session effort; absent ⇒ 'high'. */
  effort?: string
  title?: string
  /** True when re-admitting an existing durable session — first boot rides
   *  `--resume` too (there is a transcript to resume). */
  resume?: boolean
  /** The worker's actual cwd when isolation carved a worktree —
   *  absent, the canonical workspace root (the claim) is the cwd. */
  cwd?: string
  /** An explicit permission-mode override the dispatch carried; absent, the
   *  seat resolves the operator's saved default (else 'flow'). */
  permissionMode?: PermissionMode
  /** The boot's runner-side options, verbatim; an operator's
   *  --append-system-prompt composes into the runner's own appendix. */
  runnerArgv?: readonly string[]
  /** A WARM spawn (the warm-runner pool): the identical worker boot with NO
   *  identity flags — no `--session-id`, no `--resume`, no `--name` — so
   *  the runner parks before its first turn awaiting the claim control.
   *  Every other field of the spec is byte-identical to a cold spawn's
   *  (parity 1:1 is the pool's whole contract). */
  warm?: boolean
  /** The session's kit, carried to the runner: rides extraEnv
   *  as MERCURY_SESSION_KIT — the admission stamp's own value, so record
   *  and process can never disagree; spec-carried ⇒ respawns keep the pin.
   *  A WARM spawn carries the ensure's kit (the next birth's — the claim
   *  lands only on byte-equality, warmRunner.ts's gate; prove-kit-birth).
   *  Absent only for a pre-kit record's respawn: the runner then boots
   *  whole-config, exactly the absent-kit law. */
  kit?: SessionKitV1
}): StreamJsonChildSpec {
  const runnerArgv = splitAppendSystemPrompt(args.runnerArgv ?? [])
  // The stream-json wire flags every worker leg carries (the ask-wire and
  // the live tail — see the extraArgv comment below).
  const wireArgv = ['--permission-prompt-tool', 'stdio', '--include-partial-messages'] as const
  return {
    // The spawn folds legacy crew keys synchronously (durable records only
    // ever held those three); NEW records store canonical ids already.
    model: foldLegacyWorkerModelKey(args.modelKey),
    ...(args.keyless ? { keyless: true } : {}),
    // The daemon-worker effort convention ('high') is the DEFAULT; an
    // operator's per-session pick rides the op (the strip's
    // effort seed chip) and resume retains the record's captured value.
    effort: args.effort ?? 'high',
    // A Concourse worker is the OPERATOR's own durable chat — no wrapper
    // pack, no teammate contract. The ONE injected block is the switchboard
    // posture (operator fixes 1+2,): know the delegation law
    // up front instead of hitting its wall, and idle by ENDING the turn —
    // a background session that fake-sleeps blocks the enter boundary.
    appendSystemPrompt: [
      "You run as a BACKGROUND session on the operator's switchboard.",
      'Delegation (subagents/workflows) is available only while this session holds the workflows-allowed tag or the operator is present — when those tools are absent, plan and work single-handed; never wait for them.',
      "'Idle', 'wait', or 'stand by' means END YOUR TURN — the harness wakes you on the next delivery. Never hold a turn open with sleeps or timers to stay available.",
      ...(runnerArgv.append !== null ? ['', runnerArgv.append] : []),
    ].join('\n'),
    role: 'MERCURY_CONCOURSE_WORKER',
    agentName: args.runnerId,
    agentId: `${args.runnerId}@concourse`,
    // plain identity — no mailbox triplet on argv, so the
    // teammate attachment chain can never arm (the greeting sever) and the
    // transcript is the operator's own (no teamName crew-classing). The
    // switcher/tabs hide board-homed rows via boardHomedSessionIds instead.
    plainIdentity: true,
    cwd: args.cwd ?? args.workspaceId,
    // (the transcript-home law): ONE home — the WORKSPACE's
    // project dir, pinned into the child and consumed once at boot, because
    // the worker's cwd is its carved worktree while every reader derives
    // from the workspace. Spec-carried ⇒ respawns keep the pin. A
    // `.mercury`-grounded birth stores PARENT-side (getProjectDir's
    // config-home fold): the config home is never a project of its own, so
    // the pin, the board's key and the ruled display name all agree.
    extraEnv: {
      MERCURY_SESSION_HOME: getProjectDir(args.workspaceId),
      // (the session-kit law): the record's kit rides beside the home pin
      // and is consumed once at child boot the same way (sessionKitPin.ts) —
      // absent = no key, never the string 'undefined'.
      ...(args.kit !== undefined ? { MERCURY_SESSION_KIT: JSON.stringify(args.kit) } : {}),
    },
    permissionMode: seatInitialPermissionMode(args.permissionMode),
    stripEnv: concourseWorkerStripEnv(),
    // (the ask-wire): --permission-prompt-tool stdio routes
    // 'ask' decisions over the stream-json control protocol (the turn parks
    // on a can_use_tool control_request instead of terminal-denying
    // silently) — the roster drain mints the needs-you obligation and the
    // operator's answer rides back as the control_response. Carried on BOTH
    // argv legs so respawns keep the wire.
    // --include-partial-messages: the runner streams its reply's text
    // deltas on stdout; the seat owner republishes them as the session's
    // live tail, so the focused chat paints the reply as it arrives.
    extraArgv: args.warm
      ? [...wireArgv]
      : args.resume
        ? ['--resume', args.sessionId!, ...wireArgv, ...runnerArgv.rest]
        : [
            '--session-id',
            args.sessionId!,
            ...(args.title !== undefined ? ['--name', args.title] : []),
            ...wireArgv,
            ...runnerArgv.rest,
          ],
    // An existing transcript refuses --session-id (exit 1, "already in
    // use") — the roster's capped-backoff respawn continues the SAME
    // durable session instead. An UNCLAIMED warm runner that crashes
    // re-warms in the same identityless shape (the claim patches this to
    // `--resume <id>` the moment a session lands on it).
    respawnExtraArgv: args.warm ? [...wireArgv] : ['--resume', args.sessionId!, ...wireArgv, ...runnerArgv.rest],
  }
}

// ── the admission handler (the crewSpawn policy-floor pattern) ──────────────

export interface ConcourseAdmitDeps {
  /** Live roster accessor (undefined while the daemon is still booting).
   *  `kill` is the reactivate's cold road (a settled handle lingering on
   *  the record's short is reaped before the --resume respawn); the daemon
   *  roster has it, and a port without it simply never reaps. */
  roster: () => (CrewRosterPort & { kill?(short: string): boolean }) | undefined
  /** Daemon record dir override (proofs pin scratch; absent ⇒ daemonDir()). */
  dir?: string
  /** Post-spawn wiring hook (main.ts arms drains/telemetry). */
  onSpawned?: (runnerId: string, spec: StreamJsonChildSpec, pid: number | undefined) => void
  /** The warm-runner pool's claim door (main.ts wires
   *  warmRunner.claimWarmRunner). Consulted only for a FRESH exclusive
   *  session with no runner-side options; a decline of any kind falls back
   *  to the cold spawn below — the pool is an optimisation, never a
   *  dependency. Absent ⇒ every admission spawns cold. */
  claimWarm?: (args: {
    workspaceId: string
    sessionId: string
    modelKey: string
    effort: string
    permissionMode: string
    /** THE KIT the admission stamps (carried ?? derived, the ONE hoisted
     *  value that also feeds the record) — the claim lands only on a
     *  runner whose booted kit equals it (the warm-claim kit gate). */
    kit: SessionKitV1
    /** The reactivate's warm road: the runner loads the parked session's
     *  transcript at the claim. */
    resume?: true
  }) => Promise<
    { claimed: true; short: string; pid?: number; spec: StreamJsonChildSpec } | { claimed: false; reason: string }
  >
  /** The re-warm door: after a claim — and after a kit-drift decline —
   *  the pool pre-spawns the NEXT warm runner in the background (one per
   *  workspace, bounded by the seat reading — both enforced inside the
   *  pool), wearing the kit the operator's births are carrying so the
   *  next claim hits. */
  ensureWarm?: (workspaceDir: string, kit?: SessionKitV1) => void
}

/** The effective seat ceiling — ONE derivation for admission and its
 *  preflight preview: the stored consented-probe recommendation as-is, or
 *  the machine's live reading (cores + free memory; no process scan). */
export function effectiveSeatCeiling(): number {
  return resolveSeatCeiling()
}

export type DefaultedAdmissionResolution =
  | { kind: 'decision'; decision: AdmissionDecision; effectiveIsolation: WorkspaceIsolation }
  | { kind: 'git-offer'; code: 'no-repository'; error: string; moves: ConcourseMoveV1[] }

/** The ruling-1 defaulted-collision fold, extracted to ONE owner —
 *  admission and the preflight preview must return IDENTICAL answers. A
 *  DEFAULTED launch that collides on a held git repo silently retries as a
 *  worktree fork (an explicit isolation choice is never overridden); on a
 *  held PLAIN folder it holds on the git OFFER (standing directive: never a
 *  silent queue — y → init → the pump replays → the same reservation
 *  forks). */
export function resolveDefaultedAdmission(
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  claim: { workspaceId: string; isolation?: WorkspaceIsolation },
  seatCeiling: number = effectiveSeatCeiling(),
): DefaultedAdmissionResolution {
  const requested: WorkspaceIsolation = claim.isolation ?? 'exclusive'
  let decision = evaluateConcourseAdmission(
    live,
    { workspaceId: claim.workspaceId, isolation: requested },
    seatCeiling,
  )
  let effectiveIsolation = requested
  if (!decision.admit && decision.code === 'workspace-collision' && claim.isolation === undefined) {
    if (workspaceKindOf(claim.workspaceId) === 'git') {
      const retry = evaluateConcourseAdmission(
        live,
        { workspaceId: claim.workspaceId, isolation: 'worktree-isolated' },
        seatCeiling,
      )
      if (retry.admit) effectiveIsolation = 'worktree-isolated'
      decision = retry
    } else {
      return {
        kind: 'git-offer',
        code: 'no-repository',
        error: 'two sessions here need git — say yes to the git offer and this one forks on its own',
        moves: [{ verb: 'init-git', label: 'say yes to the git offer — it forks and starts by itself' }],
      }
    }
  }
  return { kind: 'decision', decision, effectiveIsolation }
}

export interface ConcourseAdmitRequest {
  workspaceDir: string
  isolation?: WorkspaceIsolation
  modelKey?: string
  /** Per-session effort (validated EffortLevel);
   *  absent ⇒ 'high' (the convention). Resume retains the record's. */
  effort?: string
  title?: string
  /** SR-086: the operator's agent handle (board OWNER column). */
  agentName?: string
  /** SR-086: the per-session background-seat ceiling. */
  seatsMax?: 1 | 2
  /** Re-admit an EXISTING durable session (a settled worker's transcript):
   *  the worker boots with `--resume <id>` instead of a fresh mint — the
   *  same chat continues (ruling 3: navigation/restart never recreates a
   *  session; resumption is explicit). */
  resumeSessionId?: string
  /** An explicit initial permission mode for the seat (the operator's line-10
   *  parity edit): a dispatch may carry the operator's chosen posture. Absent,
   *  the seat resolves the operator's saved default (settings.permissions
   *  .defaultMode), else 'flow'. */
  permissionMode?: PermissionMode
  /** The boot's runner-side options (the one table in
   *  services/switchboard/runnerArgv.ts): the session runs with them
   *  verbatim, and the record keeps them so a respawn or resume does too. */
  runnerArgv?: string[]
  /** A BIRTH (the one-door law, rule 2 — born = registered): the session is
   *  born blank through New Session, no words follow. The record carries
   *  `bornBlankAt`: the idle reaper never retires a newborn before the
   *  operator's first message (the birth grace), and the reconcile releases
   *  a newborn found dead instead of painting a crash (nothing to bring
   *  back). */
  bornBlank?: boolean
  /** THE /clear SEAT-SWAP (operator-sighted, ruled): the births-
   *  first /clear order collides with a full seat world — both seats held,
   *  the birth demanded a THIRD. This names the live session /clear is
   *  vacating: admission excludes ITS claim from the fold (the reserve — the
   *  birth rides the seat being vacated), and the caller parks it only AFTER
   *  the birth lands, so a failed birth still moves nothing. A concurrent
   *  admission counts the vacating seat as live (conservative; two swaps
   *  cannot overcommit). A hint naming no live record is inert — the old
   *  session already parked or died, the fold needs no exclusion. Admit-door
   *  ONLY: a held dispatch replay must never exclude a seat from a world
   *  that moved on. */
  vacatingSessionId?: string
  /** THE KIT this admission carries (the L18 road: the screen's own fresh
   *  menu truth, validated at the wire — daemon/sessionKit.ts). Absent ⇒ the
   *  daemon derives from the workspace's menu store (the fallback every
   *  door that never saw a screen gets). A resume carrying one RE-STAMPS
   *  the standing record (L24(3): a re-started transcript reloads with the
   *  new boot menu applied). */
  kit?: SessionKitV1
  /** A SAVED PRESET's name (L24(4) + the both-doors ruling;
   *  the coordinator's door): the daemon derives the kit
   *  from the PRESET's deltas instead of the menu's (RECORD E's shape; the
   *  runner completes it at first boot). An unknown or damaged name
   *  REFUSES TYPED and no session is born (the closed-roster law); naming
   *  a preset BESIDE a carried kit refuses the same way — one door. */
  kitPreset?: string
}

export type ConcourseRefusalCode =
  | 'runtime-ceiling'
  | 'workspace-collision'
  | 'invalid-request'
  | 'not-ready'
  | 'spawn-failed'
  // carve failures are their own held-class truths —
  // fixable, then the same reservation replays.
  | 'no-repository'
  | 'git-unavailable'
  | 'unborn-head'

export type ConcourseAdmitResult =
  | {
      ok: true
      runnerId: string
      sessionId: string
      workspaceId: string
      pid?: number
      /** set when admission carved a fork — the receipt names it. */
      branchName?: string
      /** The main-checkout holder's title at carve time (receipt copy). */
      mainHolderTitle?: string
      /** THE MODEL THIS SESSION RUNS ON — the resolved id the spec carries,
       *  and the registry's display name for it. Every launch receipt names
       *  the model it launched on, so an unnamed launch is never a mystery. */
      modelId?: string
      modelDisplayName?: string
      /** THE RETAINED MODEL'S CREDENTIAL (the keyless-birth law applied to
       *  resume): the session was admitted without the model it ran on —
       *  no credential for its family here — and this one line names the
       *  dropped model and its door; the resume door paints it. */
      note?: string
      /** THE EFFORT THIS SESSION STARTED AT — the canonical ladder word the
       *  spec/record carry (the request's, a resume's retained tier, else
       *  the convention 'high'). The launch answer names it so an asked
       *  tier that did not ride is a visible fact, never a quiet default
       *  (the chain-of-custody law). */
      effort?: string
      /** WHERE THE SESSION'S KIT CAME FROM:
       *  'carried' — the door handed the screen's next-session snapshot;
       *  'derived' — the daemon composed it from the workspace's menu
       *  (every birth the screen never saw). The launch receipts name it,
       *  so a coordinator or board birth is never a mystery about what it
       *  loads. TWIN LAW: kitSource and liveHop ride under
       *  ONE truth, never both — kitSource present ⟺ a kit stamp ran;
       *  liveHop present ⟺ nothing stamped. 'preset' = the admit named a
       *  saved preset and the kit derived from ITS deltas. */
      kitSource?: 'carried' | 'derived' | 'preset'
      /** The preset this admission wore (present ⟺ kitSource 'preset'):
       *  the launch receipt names it. */
      presetName?: string
      /** The preset derivation's honesty note (the doesn't-bite census:
       *  MCP deltas naming servers this repo lacks; the skill/extension
       *  first-boot sentence) — the launch receipt carries it. */
      presetNote?: string
      /** THE PURE HOP said so: the resume converged on a
       *  LIVE record — nothing was spawned and nothing was re-stamped, the
       *  carried kit (if any) was deliberately ignored. The client's worn
       *  one-shot preset must NOT be spent on this answer. */
      liveHop?: true
    }
  | { ok: false; error: string; code: ConcourseRefusalCode; moves?: ConcourseMoveV1[] }

/** The model a durable session ran on: its newest record naming one, else
 *  the last REAL served assistant row of its transcript in the workspace's
 *  law home (the retainedModel provenance law — locally-fabricated rows
 *  stamp the synthetic sentinel and are skipped, and the billing-safe form
 *  applies, so this walk and restoreConversationModelFromMessages answer
 *  identically on every resume road); undefined when no real served row
 *  exists (a fresh session, a transcript without a reply yet, a session
 *  whose only rows are interrupts/error stand-ins — the registry default
 *  serves those, never a refusal on the sentinel spelling). */
export function resumeModelKeyOf(sessionId: string, workspaceDir: string, dir?: string): string | undefined {
  const fromRecord = Object.values(readSessionWorkers(dir))
    .filter(r => r.sessionId === sessionId && r.modelKey !== undefined && r.keyless !== true)
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.modelKey
  if (fromRecord !== undefined) return fromRecord
  let workspaceId = workspaceDir
  try {
    workspaceId = canonicalWorkspaceId(workspaceDir)
  } catch {
    // an unreadable workspace resolves nothing; the admission refuses it on its own
  }
  const transcript = join(getProjectDir(workspaceId), `${sessionId}.jsonl`)
  if (!existsSync(transcript)) return undefined
  let retained: string | undefined
  try {
    // The one transcript reader walks the newest lines first in widening
    // windows: the last real served row sits near the tail, so the walk
    // reads the whole file only when no such row exists.
    scanTranscriptLinesBackward(transcript, line => {
      // Cheap tail prefilter only — the shapes are adjudicated below.
      if (!line.includes('assistant') && !line.includes('output')) return
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        // Dual-read through the ONE codec: a Mercury record envelope nests
        // the entry (an assistant turn's model rides payload) and decodes
        // via recordToEntry; a legacy entry line already IS the entry. A
        // hand parse of the envelope read ZERO models and every record-less
        // resume silently fell to the default — never a retained model.
        const entry = (
          typeof row.recordId === 'string' && row.payload !== undefined
            ? (recordToEntry(row as never) as Record<string, unknown>)
            : row
        ) as { type?: string; message?: { model?: unknown } }
        const served = servedModelOfAssistantRow(entry)
        if (served !== undefined) {
          retained = billingSafeRetainedForm(served)
          return true
        }
      } catch {
        // a damaged or foreign line resolves nothing; the walk continues
      }
      return
    })
  } catch {
    // an unreadable transcript resolves nothing
  }
  return retained
}

/**
 * The complete admission policy — validate → canonicalize (RR-01) → count
 * LIVE workers (records ∩ roster, the crewSpawn live-count discipline) →
 * evaluateConcourseAdmission (the five-lease core) → mint the session id →
 * durable record → registerLongLived. Every refusal is a plain preserved
 * string; a refused request consumes NO worker and NO provider call.
 */
export function makeConcourseAdmitHandler(
  deps: ConcourseAdmitDeps,
): (req: ConcourseAdmitRequest) => Promise<ConcourseAdmitResult> {
  return async req => {
    // The ONE callable-model owner validates (ruled): the
    // registry's typed refusal reaches the caller verbatim — a refused row
    // is visible and reasoned, never a silent parse error.
    // Effort resolves through the ONE normalizer first (plain spellings —
    // 'max effort', 'x high' — are the same request as their ladder word);
    // what cannot normalize refuses TYPED, naming the ladder. Downstream
    // reads see only the canonical word.
    if (req.effort !== undefined) {
      const level = normalizeEffortLevelString(req.effort)
      if (level === undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `effort refused ('${req.effort}' is not on the shared ladder — the levels are ${EFFORT_LEVELS.join(' | ')})`,
        }
      }
      req = { ...req, effort: level }
    }
    // THE MODEL A RESUME CONTINUES ON: an explicit pick wins; re-admission
    // of a durable session retains the model the session ran on (its
    // newest record that names one, else the last assistant row of its
    // transcript); a fresh session takes the registry default. A retained
    // model that today's registry refuses is a visible refusal naming it —
    // never a silent substitute.
    const retainedModelKey =
      req.modelKey === undefined && req.resumeSessionId !== undefined
        ? resumeModelKeyOf(req.resumeSessionId, req.workspaceDir, deps.dir)
        : undefined
    const validated = await validateWorkerModelChoice(req.modelKey ?? retainedModelKey, 'session')
    // THE RETAINED MODEL'S CREDENTIAL (the keyless-birth law applied to
    // resume): a resumed session keeps the model it ran on, but when the
    // home holds no credential for that model's family the session is
    // ADMITTED all the same — re-validated UNNAMED (keyless ⇒ the runner
    // boots modelless; another family signed in ⇒ its neutral row) — and a
    // one-line receipt names the dropped model and its door. The first
    // MODEL send is what the credential gates; a shell line runs. A refusal
    // by name here left the revived session with no runner at all.
    let admission = validated
    let retainedNote: string | undefined
    if (!validated.ok && req.modelKey === undefined && retainedModelKey !== undefined && validated.reason.startsWith('no-credential:')) {
      const unnamed = await validateWorkerModelChoice(undefined, 'session')
      if (unnamed.ok) {
        admission = unnamed
        retainedNote =
          unnamed.keyless === true
            ? `the session's model ${retainedModelKey} has no credential here — the first model send picks the neutral default; /model chooses`
            : `the session's model ${retainedModelKey} has no credential here — it continues on ${unnamed.entry.displayName} (the neutral default); /model chooses`
      }
    }
    if (!admission.ok) {
      // The typed reason class + the ONE action ride the error verbatim —
      // whoever reads it (operator, coordinator) relays the real fix. THE
      // ACTION LEADS (the 100-column drive): the face
      // paints this on ONE truncate-end row, and with the action trailing
      // the "(got …)" tail the way out was the first thing cut — the
      // operator read "…on this account (got…" and nothing they could do.
      // Order: reason · action · detail · the (got …) debug tail.
      return {
        ok: false,
        code: 'invalid-request',
        error: `model refused (${admission.reason})${admission.action !== undefined ? ` · ${admission.action}` : ''}${admission.detail !== undefined ? ` — ${admission.detail}` : ''} (got ${JSON.stringify(req.modelKey ?? retainedModelKey ?? '(unset → registry default)')}${retainedModelKey !== undefined && req.modelKey === undefined ? ' — the model this session ran on; --model picks another' : ''})`,
      }
    }
    const modelKey = admission.entry.modelId
    const modelDisplayName = admission.entry.displayName
    // THE KEYLESS ADMISSION (the neutral-default ruling): an unnamed launch
    // on a home with no credential anywhere is admitted with NO model — the
    // record wears the placeholder for display, the runner boots modelless.
    const keyless = admission.keyless === true
    // A keyless admission with sign-ins present carries its receipt (each
    // sign-in's gate and the doors) on the same note the retained-model
    // road uses — the door paints it.
    if (keyless && admission.note !== undefined && retainedNote === undefined) retainedNote = admission.note
    let stat
    try {
      stat = statSync(req.workspaceDir)
    } catch {
      return { ok: false, code: 'invalid-request', error: `workspace does not exist: ${req.workspaceDir}` }
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'invalid-request', error: `workspace is not a directory: ${req.workspaceDir}` }
    }
    const roster = deps.roster()
    if (!roster) return { ok: false, code: 'not-ready', error: 'daemon roster not ready' }

    const workspaceId = canonicalWorkspaceId(req.workspaceDir)
    // ── THE PRESET DOOR (L24(4) + the operator's both-doors
    // ruling): a named preset is the derivation's OTHER source — the
    // daemon derives the kit from the PRESET's deltas instead of the
    // menu's. Resolved HERE, before ANY road (reactivate, warm claim, cold
    // mint), so an unknown or damaged preset refuses TYPED with no session
    // born (the closed-roster law: a silent fall to the menu default would
    // be a leak of scope), and every road below consumes the ONE value. A
    // carried kit beside a preset name is a caller contradiction — one
    // door, typed refusal (the no-dial-frame precedent).
    let preset: { name: string; kit: SessionKitV1; note?: string } | undefined
    if (req.kitPreset !== undefined) {
      if (req.kit !== undefined) {
        return {
          ok: false,
          code: 'invalid-request',
          error: `kit and kitPreset are one door — send one (got a carried kit beside preset '${req.kitPreset.slice(0, 64)}')`,
        }
      }
      const derived = deriveSessionKitForPreset(req.kitPreset, workspaceId)
      if (!derived.ok) return { ok: false, code: 'invalid-request', error: derived.reason }
      preset = { name: req.kitPreset, kit: derived.kit, ...(derived.note !== undefined ? { note: derived.note } : {}) }
    }
    const records = readSessionWorkers(deps.dir)
    const liveShorts = new Set(roster.list().filter(j => !j.outcome).map(j => j.short))
    // SB-C1 (close audit): an ATTACHED session's child is dead BY DESIGN
    // (attachYield killed it at the boundary) but its workspace claim is as
    // live as the operator's terminal — without the attachedAt arm a second
    // exclusive launch admits onto the held checkout. stoppedAt stays out:
    // stop deliberately releases the claim. A PARKED record holds no claim
    // either (its runner is dead by intent; the roster handle may still be
    // settling from the kill) — /clear parks the old chat and births the
    // next in the same room without carving a worktree.
    const liveWorkers = Object.values(records).filter(
      r => r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined),
    )
    // ── THE REACTIVATE (a resume of a STANDING record) ──────────────────
    // A resume whose record still stands — parked by the operator,
    // crashed, stopped, or live — converges on that record: never a second
    // record for one session (the two-states poison). The record's own
    // claim is judged against the OTHER live claims.
    if (req.resumeSessionId !== undefined) {
      const standing = Object.values(records).find(r => r.sessionId === req.resumeSessionId && r.endedAt === undefined)
      if (standing !== undefined) {
        const others = liveWorkers
          .filter(r => r.runnerId !== standing.runnerId)
          .map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation }))
        const reactivated = await reactivateConcourseSession(
          standing,
          {
            modelKey,
            modelDisplayName,
            ...(keyless ? { keyless: true } : {}),
            ...(req.effort !== undefined ? { effort: req.effort } : {}),
            ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
            ...(req.kit !== undefined ? { kit: req.kit } : {}),
            // The resolved preset rides the reactivation whole (name + kit
            // + note): the re-stamp takes ITS kit and the answer names it.
            ...(preset !== undefined ? { preset } : {}),
            by: 'operator',
          },
          others,
          deps,
        )
        return reactivated.ok && retainedNote !== undefined ? { ...reactivated, note: retainedNote } : reactivated
      }
    }
    // the stored first-boot capacity decision may
    // LOWER admission under the hard five; min() re-asserts that nothing
    // raises it. No stored decision resolves to the cap — unchanged.
    // THE /clear SEAT-SWAP: the vacating session's claim leaves the fold
    // for THIS admission only (see the field's law above) — the birth rides
    // the seat /clear is vacating instead of demanding a spare.
    const admissionClaims = liveWorkers.filter(
      r => req.vacatingSessionId === undefined || r.sessionId !== req.vacatingSessionId,
    )
    // The ONE defaulted-collision fold — the preview calls the same.
    const resolution = resolveDefaultedAdmission(
      admissionClaims.map(r => ({ workspaceId: r.workspaceId, isolation: r.isolation })),
      { workspaceId, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}) },
    )
    if (resolution.kind === 'git-offer') {
      return { ok: false, code: resolution.code, error: resolution.error, moves: resolution.moves }
    }
    const { decision } = resolution
    const effectiveIsolation = resolution.effectiveIsolation
    if (!decision.admit)
      return {
        ok: false,
        code: decision.code,
        error: decision.reason,
        ...(decision.moves !== undefined ? { moves: decision.moves } : {}),
      }

    // THE KIT, hoisted: ONE value feeds the warm
    // claim's gate, the spawn spec's carry AND the record's stamp below, so
    // the process and the record can never disagree about what this
    // session was born with.
    const kit = req.kit ?? preset?.kit ?? deriveSessionKitForWorkspace(workspaceId)
    // ── THE WARM CLAIM (claim-over-spawn) ──────────────────────────────
    // A FRESH exclusive session with no runner-side options may land on the
    // workspace's pre-booted warm runner instead of paying the spawn: the
    // pool hands the runner its id, model, posture and effort (validated
    // ABOVE — a refused model refused this admission before any claim ran,
    // so the warm runner survives a bad request untouched) and the record
    // mints only after the runner acknowledges. THE KIT GATE (the warm-
    // claim kit gate, warmRunner.ts): the claim carries the hoisted kit
    // and lands only on a runner that BOOTED it — a decline retires the
    // stale runner, the cold path wears the kit, and the decline-side
    // rewarm below re-arms the pool with it so the NEXT birth claims warm
    // again. Any decline falls through to the cold path unchanged. A
    // resume, a carve, or an operator argv never claims: the warm runner
    // booted without those.
    if (
      deps.claimWarm !== undefined &&
      // A keyless admission never claims: a warm runner booted on a pinned
      // model, and this session must boot on none.
      !keyless &&
      req.resumeSessionId === undefined &&
      // A shared (solo in-place) birth is the warm claim's home case — the
      // warm runner boots on the ground, exactly where the session lands.
      (effectiveIsolation === 'exclusive' || effectiveIsolation === 'shared') &&
      (req.runnerArgv === undefined || req.runnerArgv.length === 0)
    ) {
      const claimSessionId = randomUUID()
      const claimEffort = req.effort ?? 'high'
      const claimStartedAt = Date.now()
      const claimed = await deps.claimWarm({
        workspaceId,
        sessionId: claimSessionId,
        modelKey,
        effort: claimEffort,
        permissionMode: seatInitialPermissionMode(req.permissionMode),
        kit,
      })
      if (claimed.claimed) {
        // The claim's own cost on the first-reply clock, named in the log —
        // the timing receipt's breakdown reads this line.
        // eslint-disable-next-line no-console
        console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes session ${claimSessionId}`)
        const runnerId = claimed.short
        // The pool's settings-drift guard proved this resolution equal to
        // the one the runner booted with — the record tells the truth
        // about what the claimed runner actually runs.
        const snapshot = resolveEffectiveSettingsSnapshot({ sessionId: claimSessionId })
        updateConcourseWorkers(workers => {
          workers[runnerId] = {
            schema: 1,
            runnerId,
            sessionId: claimSessionId,
            workspaceId,
            isolation: effectiveIsolation,
            modelKey,
            effort: claimEffort,
            ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
              ? { agentName: req.agentName.trim().slice(0, 24) }
              : {}),
            ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
            spawnedAt: Date.now(),
            lastLiveAt: Date.now(),
            ...pidFieldsOf(claimed.pid),
            settingsSnapshot: snapshot,
            workspaceKind: workspaceKindOf(workspaceId),
            ...(req.title !== undefined ? { title: req.title } : {}),
            ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
            // THE KIT STAMP (the admission's one of three writers): the
            // SAME hoisted value the claim gate just proved the runner
            // booted — record ≡ process by construction (the fallback
            // every door that never saw a screen gets rode the hoist:
            // coordinator births, other terminals).
            ...kitStampOf(kit),
          }
        }, deps.dir)
        deps.onSpawned?.(runnerId, claimed.spec, claimed.pid)
        // The NEXT warm runner pre-spawns in the background, wearing the
        // kit this birth carried (sticky facts make it the next birth's
        // too) — the answer to this admission never waits on it.
        if (deps.ensureWarm !== undefined) {
          const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit), 0)
          rewarm.unref?.()
        }
        return {
          ok: true,
          ...(retainedNote !== undefined ? { note: retainedNote } : {}),
          runnerId,
          sessionId: claimSessionId,
          workspaceId,
          modelId: modelKey,
          modelDisplayName,
          effort: claimEffort,
          kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
          ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
          ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
        }
      }
      logForDebugging(`[daemon] warm claim declined (${claimed.reason}) — spawning cold`)
      // The decline-side rewarm (the kit gate's recovery): a kit-drift
      // decline retired the stale runner; re-arm the pool with the kit
      // THIS birth carries (sticky facts make it the next birth's too), so
      // one cold spawn is the whole price of a menu edit. Idempotent and
      // bounded inside the pool (same-kit ensures keep; the seat reading
      // holds) — a decline that retired nothing re-arms nothing new.
      if (deps.ensureWarm !== undefined) {
        const rewarm = setTimeout(() => deps.ensureWarm!(workspaceId, kit), 0)
        rewarm.unref?.()
      }
    }

    // Lowest free worker slot — respawn-stable identity. Shorts mint as
    // concourse-wN for ANY N (the admission ceiling above is the machine's
    // only cap); the loop bound is a sanity fence over pathological state,
    // never a seat cap. EVERY un-ended record reserves its short — a
    // stopped or crashed row still on the board must never be overwritten
    // by a fresh admission recycling its id (the silent-vanish class).
    const used = new Set(
      Object.values(records)
        .filter(r => r.endedAt === undefined)
        .map(r => r.runnerId),
    )
    let runnerId: string | null = null
    for (let n = 1; n <= used.size + 4096; n++) {
      const candidate = `${CONCOURSE_SHORT_PREFIX}${n}`
      if (!used.has(candidate) && !roster.has(candidate).present) {
        runnerId = candidate
        break
      }
    }
    if (runnerId === null) {
      return { ok: false, code: 'runtime-ceiling', error: `no free worker slot — ${describeSeatReading(effectiveSeatCeiling())}` }
    }

    const sessionId = req.resumeSessionId ?? randomUUID()
    // The typed workspace capability + the isolated worktree. A
    // worktree-isolated claim on a PLAIN FOLDER refuses typed (the
    // honest capability limit); a git workspace carves the worker's own
    // detached worktree — the worker cwd moves there, the CLAIM stays the
    // canonical root (several isolated sessions share one repository
    // lawfully — ruling 5). Idempotent by dir (crash-mid-create re-ensures).
    const workspaceKind = workspaceKindOf(workspaceId)
    let workerCwd = workspaceId
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    if (effectiveIsolation === 'worktree-isolated') {
      // every carve is BRANCH mode — mercury/<slug> off the latest
      // local main, minted once here (the record is the one branch truth).
      // The untitled seed is the SESSION id, never the runner short: shorts
      // recycle by design and the short-keyed store forgets a clobbered
      // record's branchName, so a short-seeded name recurs onto branches
      // that linger forever (the L19 fatal).
      const wt = await ensureWorkerWorktree(workspaceId, runnerId, deps.dir, {
        branchName: mintWorktreeBranchName(req.title ?? sessionId.slice(0, 8), records),
      })
      if (!wt.ok) {
        // carve failures are HELD-class (fixable, then the same
        // reservation replays) — never a terminal invalid-request.
        if (wt.code === 'no-repository' || wt.code === 'unborn-head') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'init-git', label: 'say yes to the git offer — then it forks on its own' }],
          }
        }
        if (wt.code === 'git-unavailable') {
          return {
            ok: false,
            code: wt.code,
            error: wt.error,
            moves: [{ verb: 'retry', label: 'install git, then replay the launch' }],
          }
        }
        return { ok: false, code: 'invalid-request', error: wt.error }
      }
      workerCwd = wt.path
      worktreePath = wt.path
      worktreeBranch = wt.branchName
    }
    // ONE immutable effective-settings snapshot at admission. A NEW
    // session resolves fresh; RE-admission of an existing durable session
    // RETAINS its original capture (resume keeps the settings the session
    // started with — a later profile revision reaches new sessions only).
    const priorSnapshot =
      req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.settingsSnapshot !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.settingsSnapshot
        : undefined
    const snapshot = priorSnapshot ?? resolveEffectiveSettingsSnapshot({ sessionId })
    // Effort: an explicit pick wins; RE-admission retains the session's
    // captured effort (the settings-retention posture); else the
    // convention.
    const effort =
      req.effort ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.effort !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.effort
        : undefined) ??
      'high'
    // W0.1 migration: converge a pre-law transcript (worktree-derived home)
    // into the law home on re-admission — best-effort; the child-side
    // resume fallback still finds an unmoved legacy transcript.
    if (req.resumeSessionId !== undefined && worktreePath !== undefined) {
      migrateTranscriptHomeToLaw({ sessionId, workspaceId, worktreePath })
    }
    // The runner-side options: the request's, else (a resume) the ones the
    // session was created with.
    const runnerArgv =
      req.runnerArgv ??
      (req.resumeSessionId !== undefined
        ? Object.values(records)
            .filter(r => r.sessionId === req.resumeSessionId && r.runnerArgv !== undefined)
            .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.runnerArgv
        : undefined)
    // (The kit was hoisted above the warm claim — the ONE value the gate
    // compared, the spec carries and the stamp writes.)
    const spec = buildConcourseWorkerSpec({
      runnerId,
      sessionId,
      workspaceId,
      modelKey,
      ...(keyless ? { keyless: true } : {}),
      effort,
      cwd: workerCwd,
      kit,
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.resumeSessionId !== undefined ? { resume: true } : {}),
      ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
      ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv } : {}),
    })
    const reg = roster.registerLongLived(runnerId, spec)
    if (!reg.ok) return { ok: false, code: 'spawn-failed', error: reg.error ?? 'registerLongLived refused' }
    updateConcourseWorkers(workers => {
      workers[runnerId!] = {
        schema: 1,
        runnerId: runnerId!,
        sessionId,
        workspaceId,
        isolation: effectiveIsolation,
        modelKey,
        effort,
        ...(keyless ? { keyless: true } : {}),
        // SR-086: the operator's agent handle + seat ceiling ride the op
        // into the durable record (the board's OWNER/SEATS truth).
        ...(typeof req.agentName === 'string' && req.agentName.trim().length > 0
          ? { agentName: req.agentName.trim().slice(0, 24) }
          : {}),
        ...(req.seatsMax === 1 || req.seatsMax === 2 ? { seatsMax: req.seatsMax } : {}),
        spawnedAt: Date.now(),
        lastLiveAt: Date.now(),
        ...pidFieldsOf(reg.pid),
        settingsSnapshot: snapshot,
        workspaceKind,
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(runnerArgv !== undefined && runnerArgv.length > 0 ? { runnerArgv: [...runnerArgv] } : {}),
        ...(req.bornBlank === true ? { bornBlankAt: Date.now() } : {}),
        // THE KIT STAMP (the same one writer as the warm mint above): carried,
        // else derived from the workspace's menu — a record-less resume takes
        // this road too (it derives loudly; nothing defaults in silence).
        // The SAME hoisted value the spawn spec carried.
        ...kitStampOf(kit),
      }
    }, deps.dir)
    // THE RECORD-LESS RESUME'S LOUD ROW: reaching the cold
    // mint with a resumeSessionId means NO record stands — the reactivate
    // branch above converged every standing one. The fresh stamp is
    // ledgered on the session's receipt so the operator can read why the
    // resumed chat wears today's menu (the recordToEntry silent-default
    // precedent, answered loudly). Fail-soft inside.
    if (req.resumeSessionId !== undefined) {
      noteRecordlessResumeKit({ workspaceId, sessionId }, kit, req.kit !== undefined ? 'carried' : 'derived', 'daemon:admit')
    }
    deps.onSpawned?.(runnerId, spec, reg.pid)
    const mainHolderTitle =
      worktreeBranch !== undefined
        ? liveWorkers.find(
            r => r.workspaceId === workspaceId && ['exclusive', 'shared'].includes(r.isolation ?? 'exclusive'),
          )?.title
        : undefined
    return {
      ok: true,
      ...(retainedNote !== undefined ? { note: retainedNote } : {}),
      runnerId,
      sessionId,
      workspaceId,
      modelId: modelKey,
      modelDisplayName,
      effort,
      kitSource: req.kit !== undefined ? 'carried' : preset !== undefined ? 'preset' : 'derived',
      ...(preset !== undefined ? { presetName: preset.name, ...(preset.note !== undefined ? { presetNote: preset.note } : {}) } : {}),
      ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
      ...(worktreeBranch !== undefined ? { branchName: worktreeBranch } : {}),
      ...(mainHolderTitle !== undefined ? { mainHolderTitle } : {}),
    }
  }
}

/** the daemon-minted branch identity — mercury/<slug of title, else the
 *  session id's head>, deduped against every record's branchName (live AND
 *  settled: old branches linger in the repo). The records can forget (the
 *  short-keyed store clobbers a recycled slot's old record), so the REAL
 *  collision guard lives inside ensureWorkerWorktree: candidates are probed
 *  against git's own branch list and exhaustion mints a time-tailed name. */
function mintWorktreeBranchName(
  seed: string,
  records: Record<string, ConcourseWorkerRecordV1>,
): string {
  const slug =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'session'
  const taken = new Set(
    Object.values(records)
      .map(r => r.branchName)
      .filter((b): b is string => b !== undefined),
  )
  const base = `mercury/${slug}`
  if (!taken.has(base)) return base
  for (let n = 2; n <= 9; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

// ── pause / resume (the delivery valve's record half) ───────────────

export type ConcoursePauseOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-paused' | 'not-paused' }
  | { outcome: 'refused'; reason: 'unknown-worker' | 'terminal-immutable' | 'not-pausable-yet' }

/**
 * Close the delivery valve for a worker (session.pause). The
 * table is the ONE adjudicator: a live worker ('working') may pause; a
 * record without positive liveness derives 'starting' and REFUSES typed
 * ('not-pausable-yet' — starting→paused is not a lawful move); a
 * settled record is terminal-immutable. Idempotent: pausing a paused
 * worker is a noop. The in-flight turn (if any) finishes on its own —
 * nothing is signalled or destroyed.
 */
export function pauseConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    if (rec.pausedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-paused' }
      return
    }
    const derived: ConcourseSessionState =
      workerPidAlive(rec) ? 'working' : 'starting'
    const d = decideTransition(derived, 'paused')
    if (d.legal !== true) {
      out = { outcome: 'refused', reason: d.reason === 'terminal-immutable' ? 'terminal-immutable' : 'not-pausable-yet' }
      return
    }
    rec.pausedAt = Date.now()
    rec.pausedBy = by
    out = { outcome: 'applied' }
  }, dir)
  return out
}

/**
 * Re-open the valve (session.resume): paused→starting per the table
 * (the start-attempt receipt — the next delivery re-arms the turn; the
 * projection re-derives 'working' from liveness). Resuming a non-paused
 * worker is a noop.
 */
export function resumeConcourseWorker(
  runnerId: string,
  by: string,
  dir?: string,
): ConcoursePauseOutcome {
  void by
  let out: ConcoursePauseOutcome = { outcome: 'refused', reason: 'unknown-worker' }
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec) return
    if (rec.endedAt !== undefined) {
      out = { outcome: 'refused', reason: 'terminal-immutable' }
      return
    }
    // Drive-12: resume re-opens BOTH valves — an operator pause and a
    // cancelled/abandoned enter (the attach valve) — so a follow-cancel's
    // valve-resume can never leave the enter valve standing.
    if (rec.pausedAt === undefined && rec.attachRequestedAt === undefined) {
      out = { outcome: 'noop', reason: 'not-paused' }
      return
    }
    if (rec.pausedAt !== undefined) {
      const d = decideTransition('paused', 'starting')
      if (d.legal !== true) {
        out = { outcome: 'refused', reason: 'not-pausable-yet' }
        return
      }
    }
    delete rec.pausedAt
    delete rec.pausedBy
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    rec.lastLiveAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

/** A settled worker's worktree reaps under the dirt law; a retained
 *  worktree (authored work OR a committed-ahead fork branch — ruling 2)
 *  records its typed evidence row (visible, never silent) and hands
 *  the merge-back inputs to the caller. Idempotent — a missing dir noops. */
function reapSettledWorktree(
  rec: ConcourseWorkerRecordV1,
  dir?: string,
): { branchName?: string; committedAhead?: number; files: string[] } | undefined {
  if (rec.worktreePath === undefined) return undefined
  const outcome = reapWorkerWorktree(rec.workspaceId, rec.runnerId, dir, {
    // SB-C2: the record's path is the one truth — suffixed carves reap right.
    path: rec.worktreePath,
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
  })
  if (outcome.outcome !== 'retained') return undefined
  recordCollisionEvidence(
    {
      schema: 1,
      kind: 'authored-work-retained',
      workspaceId: rec.workspaceId,
      holders: [{ workerId: rec.runnerId, sessionId: rec.sessionId, isolation: rec.isolation }],
      observedAt: Date.now(),
      detail:
        outcome.committedAhead !== undefined && outcome.committedAhead > 0
          ? `fork retained at settle — ${outcome.committedAhead} commit(s) ahead on ${rec.branchName ?? 'its branch'}${outcome.files.length > 0 ? ` + ${outcome.files.length} uncommitted file(s)` : ''}`
          : `worktree retained at settle — authored work present (${outcome.files.length} file(s)) at ${rec.worktreePath}`,
      files: outcome.files.slice(0, 20),
      ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    },
    dir,
  )
  return {
    ...(rec.branchName !== undefined ? { branchName: rec.branchName } : {}),
    ...(outcome.committedAhead !== undefined ? { committedAhead: outcome.committedAhead } : {}),
    files: outcome.files,
  }
}

/** Settle a worker record exactly once (release/kill path). Idempotent. */
export function settleConcourseWorker(runnerId: string, dir?: string): boolean {
  let settled = false
  let endedSessionId: string | undefined
  let settledRec: ConcourseWorkerRecordV1 | undefined
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (rec && rec.endedAt === undefined) {
      rec.endedAt = Date.now()
      // The focus fact ends with the record: an ended session is nobody's seat.
      delete rec.focusedAt
      delete rec.focusedBy
      settled = true
      endedSessionId = rec.sessionId
      settledRec = rec
    }
  }, dir)
  // The session's closing paper trail (ledger T5–T6): the FIRST settle is
  // the finish seam — the machine floor + the agent's own close land beside
  // the transcript exactly once. A record already PARKED wrote its trail at
  // the park stamp (its runner has been dead by intent since — nothing new
  // is derivable), and a released newborn has no conversation to certify:
  // both skip. The trail is a projection — it never fails the settle.
  if (settled && settledRec !== undefined && settledRec.parkedAt === undefined && !isNewbornRecord(settledRec)) {
    try {
      writeSessionCloseReceipts(getProjectDir(settledRec.workspaceId), settledRec.sessionId, 'settle', settledRec.agentName)
    } catch {
      /* the paper trail never blocks a settle */
    }
  }
  // Worktree lifecycle closes with the record (dirt law inside).
  const retainedInfo =
    settled && settledRec !== undefined ? reapSettledWorktree(settledRec, dir) : undefined
  // The seat's projections (its facts, its asks) retire with the record.
  if (settled && endedSessionId !== undefined) {
    try {
      retireSeatProjections(endedSessionId, dir)
    } catch {
      /* a projection — never fails the settle */
    }
  }
  // An EXPLICIT settle is a completion — the crash path
  // (reconcile) emits 'failed' instead; the two seams genuinely know
  // different things. Journal-decided, visible-replayed (one toast).
  if (settled && endedSessionId !== undefined) {
    const sid2 = endedSessionId
    void import('../services/notificationPolicy.js')
      .then(policy =>
        policy.journalConcourseSignal({
          kind: 'completed',
          targetId: runnerId,
          revision: Date.now(),
          title: 'session settled',
          detail: `worker ${runnerId} released`,
          deepLink: { sessionId: sid2 },
          obligationBacked: false,
        }),
      )
      .catch(err => {
        logForDebugging(`[concourse] completed-signal journal failed for ${runnerId}: ${err}`)
      })
  }
  // Exactly the FIRST settle (the endedAt guard above): open
  // obligations naming the ended session supersede at the obligations owner
  // (a question whose session is absent must not keep demanding an answer).
  // Fire and forget; the settle receipt never waits on the kernel.
  if (settled && endedSessionId !== undefined) {
    const sid = endedSessionId
    const rec2 = settledRec
    // a retained fork rides the SAME kernel
    // event with everything the pure evaluator needs — the live main-holder
    // and the whole unconsumed batch for this workspace (several finished
    // trees hand off together, oldest first).
    let retained:
      | {
          workspaceId: string
          title: string
          branchName?: string
          mainHolderSessionId?: string
          batchBranches: string[]
          batchWorkerIds: string[]
          /** Drive-12 (the consolidator-blindness law): WHERE the work is —
           *  the fork's worktree path + its commit state, so a merge brief
           *  can say "read it there" instead of naming a branch a fresh
           *  session may not find (uncommitted files live only in the
           *  worktree). */
          worktreePath?: string
          committedAhead?: number
          uncommittedFiles?: string[]
        }
      | undefined
    if (retainedInfo !== undefined && rec2 !== undefined) {
      const holder = Object.values(readSessionWorkers(dir)).find(
        r =>
          r.endedAt === undefined &&
          r.workspaceId === rec2.workspaceId &&
          (r.isolation ?? 'exclusive') === 'exclusive' &&
          workerPidAlive(r),
      )
      const unconsumed = readCollisionEvidence(dir)
        .filter(
          e =>
            e.kind === 'authored-work-retained' &&
            e.workspaceId === rec2.workspaceId &&
            e.consumedAt === undefined &&
            e.branchName !== undefined,
        )
        .sort((a, b) => a.observedAt - b.observedAt)
      retained = {
        workspaceId: rec2.workspaceId,
        title: rec2.title ?? runnerId,
        ...(rec2.branchName !== undefined ? { branchName: rec2.branchName } : {}),
        ...(holder !== undefined ? { mainHolderSessionId: holder.sessionId } : {}),
        batchBranches: [...new Set(unconsumed.map(e => e.branchName as string))],
        batchWorkerIds: [...new Set(unconsumed.flatMap(e => e.holders.map(h => h.workerId)))],
        ...(rec2.worktreePath !== undefined ? { worktreePath: rec2.worktreePath } : {}),
        ...(retainedInfo.committedAhead !== undefined ? { committedAhead: retainedInfo.committedAhead } : {}),
        ...(retainedInfo.files.length > 0 ? { uncommittedFiles: retainedInfo.files.slice(0, 20) } : {}),
      }
    }
    void import('../services/concourse/coordinatorKernel.js')
      .then(k =>
        k
          .runCoordinatorKernel({
            kind: 'worker-settled',
            sessionId: sid,
            runnerId,
            ...(retained !== undefined ? { retained } : {}),
          })
          .then(receipts => {
            if (
              retained !== undefined &&
              receipts.some(
                r =>
                  (r.verb === 'session.redirect' || r.verb === 'session.launch') &&
                  // A QUEUED merge-back is spoken for — the held reservation
                  // starts on its own; leaving the evidence unconsumed minted
                  // a second merge-review dispatch at the next settle
                  // (FN-017 rank 4).
                  (r.outcome === 'applied' || r.outcome === 'queued'),
              )
            ) {
              markCollisionEvidenceConsumed(retained.workspaceId, retained.batchWorkerIds, dir)
            }
          }),
      )
      .catch(err => {
        // C3 (FN-006): never silent — a failing kernel here swallows the R2
        // supersede sweep for the ended session unseen.
        logForDebugging(`[concourse] R2 kernel ride failed for ${runnerId}: ${err}`)
      })
  }
  return settled
}

// ── crash reconciliation (the reconcileRecords conservative discipline) ─────

export interface ConcourseReconcileReceipt {
  settled: string[]
  live: string[]
  /** Blank newborns found dead and RELEASED (never a crash row). */
  newbornsReleased: string[]
  /** Parked records left exactly as they stand (a dead runner is the parked
   *  state's own shape — never crashed, never released), plus park REQUESTS
   *  whose runner was found dead and so converged to parked. */
  parked: string[]
}

/**
 * Converge worker records against observed liveness: a record whose roster
 * entry is absent AND whose pid is not alive takes the CRASH fact exactly
 * once (the session-end visibility law — the row STAYS on the board as
 * NEEDS YOU with the reason; the operator's release removes it); ANY
 * liveness signal leaves the record untouched (the G13 polarity — never
 * steal from a safety gate). The worktree is NOT reaped here: a crashed
 * fork's authored work is exactly the work the operator decides over, and
 * the release path reaps under the dirt law. Runs at daemon boot recovery
 * beside reconcileDaemonRecords, and is safe to re-run at any time.
 */
export function reconcileConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string>,
  dir?: string,
): ConcourseReconcileReceipt {
  const receipt: ConcourseReconcileReceipt = { settled: [], live: [], newbornsReleased: [], parked: [] }
  updateConcourseWorkers(workers => {
    for (const rec of Object.values(workers)) {
      if (rec.endedAt !== undefined) continue
      // The focus fact heals with its terminal: a stamp whose pid is gone
      // (the terminal died mid-focus, so no blur was ever sent) would keep
      // the session "with the operator" — and launching on a dead seat's
      // authority — forever. A live pid is left alone; a stamp that names
      // no pid is foreign and clears too. The valve itself never trusts a
      // dead seat; this keeps the record honest between its reads.
      if (rec.focusedAt !== undefined) {
        const seatPid = stampedTerminalPid(rec.focusedBy)
        if (seatPid === undefined || !isProcessAlive(seatPid)) {
          logForDebugging(`[concourse] focus stamp healed off ${rec.runnerId} (terminal ${rec.focusedBy ?? 'unnamed'} is gone)`)
          delete rec.focusedAt
          delete rec.focusedBy
        }
      }
      // PARKED IS A RECORD STATE (the control-plane model): the operator
      // closed this chat, so a dead runner is exactly its shape — the
      // reconcile never converts parked to crashed or to released; the row
      // stays "parked · <age>" until ↵ reactivates it or x-x releases it.
      // A park still REQUESTED on a runner found dead (the turn never
      // settled — the daemon or the runner died mid-drain) converges to
      // parked here: the operator closed it; nothing about that is a crash.
      if (rec.parkedAt !== undefined) {
        receipt.parked.push(rec.runnerId)
        continue
      }
      if (rec.parkRequestedAt !== undefined) {
        const requestedRunnerLive = rosterLiveShorts.has(rec.runnerId) || (workerPidAlive(rec))
        if (!requestedRunnerLive) {
          stampParked(rec, rec.parkRequestedBy ?? 'daemon:reconcile')
          receipt.parked.push(rec.runnerId)
          continue
        }
      }
      // Operator ruling: deliberate states are NOT crashes. An
      // ATTACHED record's child was killed by the yield (the operator's
      // terminal owns the session — a dead pid is the DESIGN), and a
      // STOPPED record's child by the x law (the row stays ◇ STOPPED until
      // removed). Settling them here vanished sessions moments after the
      // operator entered or stopped them — the exact non-persistence hit.
      if (rec.attachedAt !== undefined || rec.stoppedAt !== undefined) {
        receipt.live.push(rec.runnerId)
        continue
      }
      const rosterLive = rosterLiveShorts.has(rec.runnerId)
      const pidLive = workerPidAlive(rec)
      if (rosterLive || pidLive) {
        rec.lastLiveAt = Date.now()
        receipt.live.push(rec.runnerId)
        continue
      }
      // A BLANK NEWBORN found dead (born through New Session, never
      // messaged — the screen quit before the first words, the daemon died
      // with it) has NOTHING to bring back: no words, no transcript. It
      // settles RELEASED below, never painted as a crash — the visibility
      // law protects work, and a newborn has none; a NEEDS-YOU row for
      // every boot-and-quit would be pure noise.
      if (rec.bornBlankAt !== undefined && rec.lastDeliveryAt === undefined) {
        receipt.newbornsReleased.push(rec.runnerId)
        continue
      }
      // A crash fact already standing is a CONVERGED record: neither list,
      // no re-journal — the minute-tick re-run stays silent (idempotence).
      // One truth still converges: a roster stamp promising a respawn
      // (`respawning: true` — "resumed, re-send the ask") from a daemon
      // that then died with the runner would stand stale here, advising a
      // re-send at a session nothing will respawn. The record is provably
      // dead-with-daemon on this path, so the fact takes the found-dead
      // wording — same crash episode: the original stamp time stays, no
      // re-journal, and the next run is a pure continue.
      if (rec.crash !== undefined) {
        if (rec.crash.respawning) {
          rec.crash = {
            at: rec.crash.at,
            reason: 'crashed — found dead with its daemon; enter to resume, or x x releases it',
            respawning: false,
          }
        }
        continue
      }
      rec.crash = {
        at: Date.now(),
        reason: 'crashed — found dead with its daemon; enter to resume, or x x releases it',
        respawning: false,
      }
      receipt.settled.push(rec.runnerId)
    }
  }, dir)
  // The release rides the ordinary settle door (worktree reap, projections
  // retired, the settle signal) — one owner for a record's end.
  for (const runnerId of receipt.newbornsReleased) settleConcourseWorker(runnerId, dir)
  if (receipt.newbornsReleased.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.newbornsReleased.length} blank newborn(s) found dead as RELEASED (nothing to bring back): ${receipt.newbornsReleased.join(', ')}`)
  }
  if (receipt.settled.length > 0) {
    logForDebugging(`[concourse] reconciled ${receipt.settled.length} dead worker record(s) as CRASHED (rows kept): ${receipt.settled.join(', ')}`)
    // A reconcile-settle is a CRASH detection — 'failed', never
    // 'completed' (the explicit-release seam owns that kind).
    const at = Date.now()
    for (const runnerId of receipt.settled) {
      const sid = readSessionWorkers(dir)[runnerId]?.sessionId
      void import('../services/notificationPolicy.js')
        .then(policy =>
          policy.journalConcourseSignal({
            kind: 'failed',
            targetId: runnerId,
            revision: at,
            title: 'session died',
            detail: `worker ${runnerId} found dead at reconcile`,
            ...(sid !== undefined ? { deepLink: { sessionId: sid } } : {}),
            obligationBacked: false,
          }),
        )
        .catch(err => {
          logForDebugging(`[concourse] failed-signal journal failed for ${runnerId}: ${err}`)
        })
    }
  }
  return receipt
}

/** The bounded atomic supervisor summary consumers read (Auto-entry, the
 *  live-count chip, /sessions) — records ∩ roster truth, one read. */
export function listConcourseWorkers(
  rosterLiveShorts: ReadonlySet<string> | null,
  dir?: string,
): ConcourseWorkerRecordV1[] {
  const records = Object.values(readSessionWorkers(dir)).filter(r => r.endedAt === undefined)
  if (rosterLiveShorts === null) return records
  return records.filter(r => rosterLiveShorts.has(r.runnerId))
}

// ── attach/detach handover + the workflows-allowed tag ───

/** Move a pre-law transcript (worktree-derived home) into
 *  the law home (the workspace's project dir). Best-effort; called with the
 *  child DEAD (attach) or not yet spawned (re-admission). */
export function migrateTranscriptHomeToLaw(rec: {
  sessionId: string
  workspaceId: string
  worktreePath?: string
}): void {
  if (rec.worktreePath === undefined) return
  try {
    const lawHome = getProjectDir(rec.workspaceId)
    const lawPath = join(lawHome, `${rec.sessionId}.jsonl`)
    const legacyPath = join(getProjectDir(rec.worktreePath), `${rec.sessionId}.jsonl`)
    if (!existsSync(lawPath) && existsSync(legacyPath)) {
      mkdirSync(lawHome, { recursive: true })
      renameSync(legacyPath, lawPath)
    }
  } catch {
    // best-effort — the child-side resume fallback still finds a legacy home
  }
}

export type ConcourseAttachOutcome =
  | { outcome: 'applied'; runnerId: string }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-attached'; runnerId: string }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'terminal-immutable' | 'attached-elsewhere' | 'no-kill-channel'
      detail?: string
    }

/**
 * the enter half: yield the daemon child so the operator's
 * terminal can become the session. First call closes the delivery valve (no
 * NEW turn can arm); an in-flight turn drains on its own — the caller
 * watches the delta stamp and re-requests (push, never a poll loop here);
 * at the boundary the child is killed (intentional stop — the roster never
 * respawns a killed worker) and attachedAt stamps the handover. Idempotent
 * by state; the transcript converges to the law home while the child is
 * dead.
 */
export function attachYieldConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): ConcourseAttachOutcome {
  let out: ConcourseAttachOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.attachedAt !== undefined) {
      // SB-C3 (close audit): the noop grant is IDENTITY-checked — two
      // terminals on one home would otherwise both 'noop' into the same transcript
      // (two live writers). The recorded attacher wins unless its process
      // is dead (crashed-owner recovery re-grants). Legacy stamps without a
      // pid keep the old single-terminal behavior.
      const recordedPid = /^operator:(\d+)$/.exec(rec.attachedBy ?? '')?.[1]
      const callerMatches = rec.attachedBy === undefined || rec.attachedBy === 'operator' || rec.attachedBy === by
      const holderDead = recordedPid !== undefined && !isProcessAlive(Number(recordedPid))
      if (!callerMatches && !holderDead) {
        out = {
          outcome: 'refused',
          reason: 'attached-elsewhere',
          detail: 'this session is open in another terminal — leave it there, then ↵ here',
        }
        return
      }
      rec.attachedBy = by
      rec.lastAttachGrantAt = Date.now()
      out = { outcome: 'noop', reason: 'already-attached', runnerId: rec.runnerId }
      return
    }
    if (rec.attachRequestedAt === undefined) {
      rec.attachRequestedAt = Date.now()
      rec.attachRequestedBy = by
    }
    const alive = workerPidAlive(rec)
    const turnInFlight =
      alive &&
      rec.lastDeliveryAt !== undefined &&
      (rec.lastTurnSettledAt === undefined || rec.lastTurnSettledAt < rec.lastDeliveryAt)
    if (turnInFlight) {
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      // attachedAt's contract is "the daemon child is dead by handover" — a
      // handover stamped over a live, unkilled child arms TWO writers on one
      // transcript (the SB-C3 disaster case). No kill, no handover.
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — enter refused`,
        }
        return
      }
    }
    rec.attachedAt = Date.now()
    rec.attachedBy = by
    rec.lastAttachGrantAt = Date.now()
    delete rec.attachRequestedAt
    delete rec.attachRequestedBy
    // Entering IS the operator seeing the session — a standing crash fact
    // clears here (the visibility law's clear side).
    delete rec.crash
    rec.lastLiveAt = Date.now()
    migrateTranscriptHomeToLaw(rec)
    out = { outcome: 'applied', runnerId: rec.runnerId }
  }, dir)
  return out
}

export type ConcourseDetachOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'not-attached' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'respawn-failed' | 'superseded-by-reattach'
      detail?: string
    }

/**
 * the leave half: the operator's terminal releases the
 * session; the SAME durable session continues as a daemon child (--resume
 * respawn on the SAME worker short — the board row's identity). Clears
 * attachedAt and re-opens the valve exactly as a plain resume does (held
 * deliveries replay caller-side through the idempotent dispatch door). A
 * respawn refusal leaves an honest ownerless state: attachedAt cleared,
 * valve closed, next dispatch/admit re-arms explicitly.
 */
export function detachRespawnConcourseSession(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean }
        registerLongLived(
          short: string,
          spec: StreamJsonChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  dir?: string,
  opts?: { mintedAtMs?: number },
): ConcourseDetachOutcome {
  void by
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt === undefined) return { outcome: 'noop', reason: 'not-attached' }
  // SB-C4: a hand-back marker minted BEFORE the latest attach grant is a
  // stale replay — the operator re-entered while it waited; respawning now
  // would put a daemon child under the attached terminal (two writers).
  if (
    opts?.mintedAtMs !== undefined &&
    rec.lastAttachGrantAt !== undefined &&
    rec.lastAttachGrantAt > opts.mintedAtMs
  ) {
    return {
      outcome: 'refused',
      reason: 'superseded-by-reattach',
      detail: 'the session was re-entered after this hand-back was queued — nothing to do',
    }
  }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: rec.modelKey,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    // The record's standing kit rides the hand-back respawn:
    // no restamp on this road — the session keeps its own.
    ...(rec.kit !== undefined ? { kit: rec.kit } : {}),
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
  })
  // A settled long-lived handle lingers on the short until reaped (the
  // release path's R7 C-LOW-1 class) — reap-then-register, one retry.
  let reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok && roster.has(rec.runnerId).present) {
    roster.kill(rec.runnerId)
    reg = roster.registerLongLived(rec.runnerId, spec)
  }
  if (!reg.ok) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (w) {
        delete w.attachedAt
        delete w.attachedBy
        delete w.attachRequestedAt
        delete w.attachRequestedBy
      }
    }, dir)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  }
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w) return
    delete w.attachedAt
    delete w.attachedBy
    delete w.attachRequestedAt
    delete w.attachRequestedBy
    delete w.pausedAt
    delete w.pausedBy
    w.lastLiveAt = Date.now()
    if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
  }, dir)
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}

export type ConcourseReviveOutcome =
  | { outcome: 'applied'; runnerId: string; pid?: number }
  | { outcome: 'noop'; reason: 'already-live' }
  | {
      outcome: 'refused'
      reason: 'unknown-session' | 'attached' | 'stopped' | 'respawn-failed'
      detail?: string
    }

/**
 * Live-drive ruling (the redirect-friction fix): a session whose
 * runner died is REVIVED in place — same durable session, same worker short,
 * --resume respawn around the untouched transcript — instead of deliveries
 * refusing 'target-not-live' or a valve resume reporting success on a dead
 * pid. A deliberate stop (stoppedAt) stays stopped unless the caller is the
 * resume verb itself (allowStopped — the operator asked for it back); an
 * attached session is the operator's terminal, never respawned under them.
 */
export function reviveConcourseWorker(
  sessionId: string,
  by: string,
  roster:
    | {
        kill(short: string): boolean
        has(short: string): { present: boolean }
        registerLongLived(
          short: string,
          spec: StreamJsonChildSpec,
        ): { ok: boolean; pid?: number; error?: string }
      }
    | undefined,
  opts?: {
    allowStopped?: boolean
    clearCrash?: boolean
    /** The kit the respawned child must boot with when the CALLER is about
     *  to restamp the record (the reactivate road: the revive's spec is
     *  built BEFORE the restamp writes) — without it the child would carry
     *  the record's displaced kit while the record takes the new one.
     *  Absent ⇒ the record's standing kit (a plain revive changes nothing). */
    kitOverride?: SessionKitV1
  },
  dir?: string,
): ConcourseReviveOutcome {
  void by
  const rec = Object.values(readSessionWorkers(dir)).find(
    r => r.sessionId === sessionId && r.endedAt === undefined,
  )
  if (!rec) return { outcome: 'refused', reason: 'unknown-session' }
  if (rec.attachedAt !== undefined)
    return { outcome: 'refused', reason: 'attached', detail: 'the session is with the operator' }
  if (rec.stoppedAt !== undefined && opts?.allowStopped !== true)
    return {
      outcome: 'refused',
      reason: 'stopped',
      detail: 'stopped — the session was stopped on purpose; resume it to bring it back',
    }
  if (workerPidAlive(rec)) return { outcome: 'noop', reason: 'already-live' }
  if (!roster)
    return { outcome: 'refused', reason: 'respawn-failed', detail: 'daemon roster not ready' }
  const reviveKit = opts?.kitOverride ?? rec.kit
  const spec = buildConcourseWorkerSpec({
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelKey: rec.modelKey,
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.title !== undefined ? { title: rec.title } : {}),
    ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
    ...(reviveKit !== undefined ? { kit: reviveKit } : {}),
    resume: true,
    cwd: rec.worktreePath ?? rec.workspaceId,
  })
  let reg = roster.registerLongLived(rec.runnerId, spec)
  if (!reg.ok && roster.has(rec.runnerId).present) {
    roster.kill(rec.runnerId)
    reg = roster.registerLongLived(rec.runnerId, spec)
  }
  if (!reg.ok)
    return {
      outcome: 'refused',
      reason: 'respawn-failed',
      ...(reg.error !== undefined ? { detail: reg.error } : {}),
    }
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w) return
    delete w.stoppedAt
    delete w.stoppedBy
    delete w.retired
    // A revive is a reactivation: the parked state (and any park still
    // requested) ends with the runner's return; the operator's own
    // reactivate clears a standing crash fact in the SAME publication (the
    // row never flickers NEEDS YOU on its way back to live).
    clearParkedFields(w)
    if (opts?.clearCrash === true) delete w.crash
    w.lastLiveAt = Date.now()
    if (reg.pid !== undefined) Object.assign(w, pidFieldsOf(reg.pid))
  }, dir)
  return {
    outcome: 'applied',
    runnerId: rec.runnerId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
  }
}

// ── THE REACTIVATE DOOR (the daemon half of the one resume path) ────────────

/** Every stamp a reactivated record sheds in the one publication that
 *  flips it live: the park, the stop, the crash, a pause, an enter valve. */
function clearReactivatedFields(rec: ConcourseWorkerRecordV1): void {
  clearParkedFields(rec)
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.crash
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
}

/** A refused reactivate leaves the row PARKED with the daemon's own
 *  sentence on it — never a ghost, never a crash: whatever the row was
 *  (parked, crashed, stopped), the operator asked for it back and what
 *  stands now is "parked, for this reason". */
function refuseReactivate(
  rec: ConcourseWorkerRecordV1,
  code: ConcourseRefusalCode,
  error: string,
  dir?: string,
  moves?: ConcourseMoveV1[],
): ConcourseAdmitResult {
  updateConcourseWorkers(workers => {
    const w = workers[rec.runnerId]
    if (!w || w.endedAt !== undefined) return
    if (w.parkedAt === undefined) stampParked(w, 'daemon:reactivate', error)
    else w.parkReason = error
  }, dir)
  return { ok: false, code, error, ...(moves !== undefined ? { moves } : {}) }
}

/**
 * THE REACTIVATE (the control-plane model): a resume of a session whose
 * record STANDS — parked by the operator, crashed, stopped, or live —
 * converges on that record; never a second record for one session. A live
 * runner is simply entered (the hop's road; a park requested mid-turn is
 * withdrawn — the operator came back before the turn settled). A dead one
 * comes back IN PLACE: the warm pool's claim carrying `resume: true` when
 * the pool can serve it — exclusive, no runner options, no carved worktree,
 * the birth's own conditions — so ↵ on a parked row is the warm claim's
 * millisecond class like New Session (the record moves onto the claimed
 * runner's short in ONE publication); the cold `--resume` respawn on the
 * record's own short otherwise (the same class as a cold birth). Every
 * refusal leaves the row PARKED with the daemon's sentence on it.
 */
export async function reactivateConcourseSession(
  rec: ConcourseWorkerRecordV1,
  args: {
    modelKey: string
    modelDisplayName?: string
    /** The keyless admission (no credential anywhere): the respawn boots
     *  modelless; the record carries the fact. */
    keyless?: true
    effort?: string
    permissionMode?: PermissionMode
    /** The CURRENT menu's kit the reactivation carries: the record RE-STAMPS
     *  (the §0.4 law — the opposite of the retained model/effort beside it;
     *  the displaced kit goes to the receipt). A live session is a hop and
     *  never re-stamps. */
    kit?: SessionKitV1
    /** A resolved PRESET riding the reactivation (the
     *  admit's preset door resolved it BEFORE this call): the re-stamp
     *  takes ITS kit (source 'preset') and the answer names it. Never
     *  beside `kit` (the admit refused that frame). */
    preset?: { name: string; kit: SessionKitV1; note?: string }
    by: string
  },
  live: ReadonlyArray<{ workspaceId: string; isolation?: WorkspaceIsolation }>,
  deps: ConcourseAdmitDeps,
): Promise<ConcourseAdmitResult> {
  const roster = deps.roster()
  if (!roster) return refuseReactivate(rec, 'not-ready', 'parked — the daemon roster is not ready · ↵ again retries', deps.dir)
  const display = args.modelDisplayName !== undefined ? { modelDisplayName: args.modelDisplayName } : {}
  const alive = workerPidAlive(rec)
  if (alive || rec.attachedAt !== undefined) {
    if (rec.parkRequestedAt !== undefined) {
      updateConcourseWorkers(workers => {
        const w = workers[rec.runnerId]
        if (!w) return
        delete w.parkRequestedAt
        delete w.parkRequestedBy
      }, deps.dir)
    }
    return {
      ok: true,
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelId: rec.modelKey,
      ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
      ...display,
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
      // THE PURE HOP says so on the wire: a live session
      // is a hop — no re-stamp ran, so a worn one-shot preset client-side
      // stays armed.
      liveHop: true,
    }
  }
  // L19 (the solo in-place law): this door's reactivations are the
  // operator's own act (`by: 'operator'`, every caller) — a worktree-less
  // 'exclusive' record predates the shared kind, and re-fencing the ground
  // at ITS reactivation would refuse beside today's in-place chats. It
  // re-claims as 'shared' and the record rewrites, so the next judgement
  // and the board both read the truth. Worktree and read-only records keep
  // their own claims.
  const claimIsolation: WorkspaceIsolation =
    (rec.isolation ?? 'exclusive') === 'exclusive' && rec.worktreePath === undefined ? 'shared' : rec.isolation
  const decision = evaluateConcourseAdmission(live, { workspaceId: rec.workspaceId, isolation: claimIsolation })
  if (!decision.admit) {
    return refuseReactivate(rec, decision.code, `parked — ${decision.reason} · ↵ again retries`, deps.dir, decision.moves)
  }
  // The L19 re-claim RIDES each road's own record write below (the R1
  // one-publication law: the flip advances the delta stamp exactly once —
  // a standalone isolation stamp here made it two).
  const isolationDrift = claimIsolation !== (rec.isolation ?? 'exclusive')
  const effort = args.effort ?? rec.effort ?? 'high'
  // THE CURRENT MENU's kit for this reactivation (L24(3): a re-started
  // transcript reloads with the new boot menu applied): carried by the
  // screen, else derived here from the record's workspace. Computed AFTER
  // the live-hop return above — a hop never derives, never re-stamps.
  const kit = args.kit ?? args.preset?.kit ?? deriveSessionKitForWorkspace(rec.workspaceId)
  const kitSource: KitStampSource = args.kit !== undefined ? 'carried' : args.preset !== undefined ? 'preset' : 'derived'
  // ── THE WARM ROAD ──────────────────────────────────────────────────────
  if (
    deps.claimWarm !== undefined &&
    ((rec.isolation ?? 'exclusive') === 'exclusive' || rec.isolation === 'shared') &&
    rec.worktreePath === undefined &&
    (rec.runnerArgv === undefined || rec.runnerArgv.length === 0)
  ) {
    const claimStartedAt = Date.now()
    const claimed = await deps.claimWarm({
      workspaceId: rec.workspaceId,
      sessionId: rec.sessionId,
      modelKey: args.modelKey,
      effort,
      permissionMode: seatInitialPermissionMode(args.permissionMode),
      // THE KIT GATE on the reactivate's warm road: the re-stamp below
      // writes this kit — the claim lands only on a runner that booted it.
      kit,
      resume: true,
    })
    if (claimed.claimed) {
      // eslint-disable-next-line no-console
      console.error(`[daemon] warm claim acked in ${Date.now() - claimStartedAt}ms: ${claimed.short} takes back session ${rec.sessionId} (${rec.runnerId} reactivated in place)`)
      const short = claimed.short
      updateConcourseWorkers(workers => {
        const current = workers[rec.runnerId]
        if (!current || current.endedAt !== undefined) return
        if (short !== rec.runnerId) delete workers[rec.runnerId]
        const next: ConcourseWorkerRecordV1 = { ...current, runnerId: short, modelKey: args.modelKey, effort, lastLiveAt: Date.now() }
        if (args.keyless === true) next.keyless = true
        else delete next.keyless
        if (claimed.pid !== undefined) next.pid = claimed.pid
        else delete next.pid
        if (isolationDrift) next.isolation = claimIsolation
        clearReactivatedFields(next)
        // THE RE-STAMP (the second of the kit's three writers): the
        // reactivated record takes the CURRENT menu's kit; what it parked
        // with goes to the receipt. Model and effort above stay retained.
        restampSessionKit(next, kit, kitSource, args.by)
        workers[short] = next
      }, deps.dir)
      deps.onSpawned?.(short, claimed.spec, claimed.pid)
      if (deps.ensureWarm !== undefined) {
        const rewarm = setTimeout(() => deps.ensureWarm!(rec.workspaceId, kit), 0)
        rewarm.unref?.()
      }
      return {
        ok: true,
        runnerId: short,
        sessionId: rec.sessionId,
        workspaceId: rec.workspaceId,
        modelId: args.modelKey,
        effort,
        kitSource,
        ...(args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
        ...display,
        ...(claimed.pid !== undefined ? { pid: claimed.pid } : {}),
      }
    }
    logForDebugging(`[daemon] warm claim declined for the reactivate of ${rec.sessionId} (${claimed.reason}) — respawning cold`)
    // The decline-side rewarm (the kit gate's recovery, the birth arm's
    // twin): re-arm the pool with the kit this reactivation re-stamps.
    if (deps.ensureWarm !== undefined) {
      const rewarm = setTimeout(() => deps.ensureWarm!(rec.workspaceId, kit), 0)
      rewarm.unref?.()
    }
  }
  // ── THE COLD ROAD: the same record, --resume respawn on its own short ──
  const keylessDrift = (args.keyless === true) !== (rec.keyless === true)
  if (args.modelKey !== rec.modelKey || effort !== rec.effort || isolationDrift || keylessDrift) {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      w.modelKey = args.modelKey
      w.effort = effort
      if (args.keyless === true) w.keyless = true
      else delete w.keyless
      if (isolationDrift) w.isolation = claimIsolation
    }, deps.dir)
  }
  const reviveRoster = {
    kill: (short: string): boolean => roster.kill?.(short) ?? false,
    has: (short: string): { present: boolean } => roster.has(short),
    registerLongLived: (short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string } => roster.registerLongLived(short, spec),
  }
  // kitOverride: the revive's spec must carry the kit the restamp below
  // writes — record and process agree, even though the spec is built first.
  const revived = reviveConcourseWorker(rec.sessionId, args.by, reviveRoster, { allowStopped: true, clearCrash: true, kitOverride: kit }, deps.dir)
  if (revived.outcome === 'refused') {
    return refuseReactivate(rec, 'spawn-failed', `parked — ${revived.detail ?? revived.reason} · ↵ again retries`, deps.dir)
  }
  // THE RE-STAMP on the cold road — the same writer as the warm road's,
  // after the respawn landed (a 'noop' revive found the session live: a
  // hop, never a re-stamp).
  if (revived.outcome === 'applied') {
    updateConcourseWorkers(workers => {
      const w = workers[rec.runnerId]
      if (!w || w.endedAt !== undefined) return
      restampSessionKit(w, kit, kitSource, args.by)
    }, deps.dir)
  }
  const pid = revived.outcome === 'applied' ? revived.pid : rec.pid
  deps.onSpawned?.(
    rec.runnerId,
    buildConcourseWorkerSpec({
      runnerId: rec.runnerId,
      sessionId: rec.sessionId,
      workspaceId: rec.workspaceId,
      modelKey: args.modelKey,
      ...(args.keyless ? { keyless: true } : {}),
      effort,
      // The notification spec mirrors the revive's own carry.
      kit,
      ...(rec.title !== undefined ? { title: rec.title } : {}),
      ...(rec.runnerArgv !== undefined ? { runnerArgv: rec.runnerArgv } : {}),
      ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
      resume: true,
      cwd: rec.worktreePath ?? rec.workspaceId,
    }),
    pid,
  )
  return {
    ok: true,
    runnerId: rec.runnerId,
    sessionId: rec.sessionId,
    workspaceId: rec.workspaceId,
    modelId: args.modelKey,
    effort,
    // The re-stamp's source — only when the respawn (and so the re-stamp)
    // actually applied; a 'noop' revive found the session live mid-flight
    // (a hop, no re-stamp) and the answer honestly names no source.
    ...(revived.outcome === 'applied' ? { kitSource } : {}),
    ...(revived.outcome === 'applied' && args.preset !== undefined ? { presetName: args.preset.name, ...(args.preset.note !== undefined ? { presetNote: args.preset.note } : {}) } : {}),
    ...display,
    ...(pid !== undefined ? { pid } : {}),
  }
}

export type ConcourseStopOutcome =
  | { outcome: 'applied'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-stopped' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

/** Operator x-gesture, first press: STOP the session — kill its child
 *  (intentional, never respawned), stamp stoppedAt; the record STAYS on
 *  the board so the operator sees what they stopped (the second x
 *  releases it through the existing concourseRelease door). */
export function stopConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  retired?: ConcourseWorkerRecordV1['retired'],
): ConcourseStopOutcome {
  let out: ConcourseStopOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    // A parked runner is already dead by intent; the row keeps its parked
    // state (the ladder ranks parked above stopped — never a second state).
    if (rec.stoppedAt !== undefined || rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-stopped' }
      return
    }
    if (workerPidAlive(rec)) {
      // stoppedAt's contract is "child dead by intent" — never stamp it when
      // the kill did not happen (no roster) or was refused (the roster no
      // longer knows this short, e.g. after a daemon restart). The record
      // stays live so the board never claims a dead child over a running
      // one, and a released claim can never admit a second runner beside it.
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
    }
    rec.stoppedAt = Date.now()
    rec.stoppedBy = by
    if (retired !== undefined) rec.retired = retired
    // The operator's own stop outranks a standing crash fact — the row
    // paints ◇ STOPPED with their reason, not a stale crash line.
    delete rec.crash
    out = { outcome: 'applied', runnerId: rec.runnerId }
  }, dir)
  return out
}

// ── park: the CLOSE state (the control-plane model) ─────────────

/** The park stamp. A closed chat is not active and is nobody's seat: the
 *  operator's other stamps end with it (nothing is stopped, paused or
 *  entering about a parked chat), and a standing crash fact clears — closing
 *  the chat is the operator's own act on it. The reason, when given, is the
 *  one line the row paints instead of "parked · <age>". */
function stampParked(rec: ConcourseWorkerRecordV1, by: string, reason?: string): void {
  rec.parkedAt = Date.now()
  rec.parkedBy = by
  if (reason !== undefined) rec.parkReason = reason
  else delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
  delete rec.stoppedAt
  delete rec.stoppedBy
  delete rec.retired
  delete rec.pausedAt
  delete rec.pausedBy
  delete rec.attachRequestedAt
  delete rec.attachRequestedBy
  delete rec.crash
  delete rec.focusedAt
  delete rec.focusedBy
  // The park is the close where finish never came (ledger T5–T6): the same
  // paper trail the settle writes — machine floor + agent close — lands at
  // this one stamp, once per park episode (every caller guards parkedAt
  // before stamping; a reactivate clears it, so a later finish writes its
  // own). Appends beside the transcript; never fails the park.
  try {
    writeSessionCloseReceipts(getProjectDir(rec.workspaceId), rec.sessionId, 'park', rec.agentName)
  } catch {
    /* the paper trail never blocks a park */
  }
}

/** The reactivate's clear: every park field ends with the runner's return. */
function clearParkedFields(rec: ConcourseWorkerRecordV1): void {
  delete rec.parkedAt
  delete rec.parkedBy
  delete rec.parkReason
  delete rec.parkRequestedAt
  delete rec.parkRequestedBy
}

/** The row's line for a session whose turn the quit path had to cut at the
 *  drain ceiling (one owner). */
export const PARK_DRAIN_CUT_REASON = 'parked — turn cut at the drain ceiling'

export type ConcourseParkOutcome =
  | { outcome: 'applied'; runnerId: string; released: boolean }
  | { outcome: 'draining'; runnerId: string }
  | { outcome: 'noop'; reason: 'already-parked' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'no-kill-channel'; detail?: string }

/**
 * THE PARK VERB — the close state's one writer. The operator closed this
 * chat (released it from the bridge, /clear'd it, quit the screen): an idle
 * runner is killed and the record parks AT ONCE; a runner MID-TURN finishes
 * its own turn first (the request stamps, the turn-settled edge completes
 * the park — a closed chat never loses the reply it was writing); a runner
 * already dead parks without a kill. NEWBORN × PARKED (one-door's rule,
 * kept): a chat born and never messaged has nothing to bring back — it is
 * RELEASED, not parked. Idempotent by state.
 */
export function parkConcourseSession(
  sessionId: string,
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; afterTurn?: boolean },
): ConcourseParkOutcome {
  let out: ConcourseParkOutcome = { outcome: 'refused', reason: 'unknown-session' }
  let releaseNewborn: string | undefined
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.parkedAt !== undefined) {
      out = { outcome: 'noop', reason: 'already-parked' }
      return
    }
    const alive = workerPidAlive(rec)
    if (alive && !isNewbornRecord(rec) && turnInFlightOf(rec) && opts?.afterTurn !== false) {
      if (rec.parkRequestedAt === undefined) {
        rec.parkRequestedAt = Date.now()
        rec.parkRequestedBy = by
      }
      out = { outcome: 'draining', runnerId: rec.runnerId }
      return
    }
    if (alive) {
      // parkedAt's contract is "the runner is dead by intent" — never stamp
      // it over a child the kill did not reach (the stop verb's own law).
      const killed = roster !== undefined && roster.kill(rec.runnerId)
      if (!killed) {
        out = {
          outcome: 'refused',
          reason: 'no-kill-channel',
          detail: `worker ${rec.runnerId} has a live child (pid ${rec.pid}) and no kill channel — record left live`,
        }
        return
      }
    }
    if (isNewbornRecord(rec)) {
      releaseNewborn = rec.runnerId
      out = { outcome: 'applied', runnerId: rec.runnerId, released: true }
      return
    }
    stampParked(rec, by, opts?.reason)
    out = { outcome: 'applied', runnerId: rec.runnerId, released: false }
  }, dir)
  // The newborn's release rides the ordinary settle door (one owner for a
  // record's end) — after the publication above, exactly once.
  if (releaseNewborn !== undefined) settleConcourseWorker(releaseNewborn, dir)
  return out
}

/**
 * The turn-settled edge of a park REQUESTED mid-turn: the runner's own turn
 * is done, so it retires into parked now. A delivery that re-armed a turn
 * meanwhile defers it to the next edge. Quiet on every record without a
 * standing request (this rides every seat's idle edge).
 */
export function completeRequestedPark(
  runnerId: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
): boolean {
  const standing = readSessionWorkers(dir)[runnerId]
  if (!standing || standing.endedAt !== undefined || standing.parkedAt !== undefined || standing.parkRequestedAt === undefined) return false
  let completed = false
  updateConcourseWorkers(workers => {
    const rec = workers[runnerId]
    if (!rec || rec.endedAt !== undefined || rec.parkedAt !== undefined || rec.parkRequestedAt === undefined) return
    const alive = workerPidAlive(rec)
    if (alive && turnInFlightOf(rec)) return
    if (alive && !(roster !== undefined && roster.kill(rec.runnerId))) return
    stampParked(rec, rec.parkRequestedBy ?? 'daemon')
    completed = true
  }, dir)
  return completed
}

/** Park requests still draining: a runner alive under a standing request
 *  (its turn not yet settled). The quit path waits on this set. */
export function pendingParkRequests(dir?: string): string[] {
  return Object.values(readSessionWorkers(dir))
    .filter(r => r.endedAt === undefined && r.parkedAt === undefined && r.parkRequestedAt !== undefined && workerPidAlive(r))
    .map(r => r.runnerId)
}

export interface ConcourseParkAllReceipt {
  parked: string[]
  draining: string[]
  released: string[]
  skipped: string[]
  refused: string[]
}

/**
 * CLOSE-ALL: the screen quit (or the owned daemon lost its screen), so every
 * active session parks — idle ones at once, mid-turn ones after their own
 * turn, newborns released. What stands as the operator's OWN state is left
 * alone: a stopped row (their x), an attached one (their terminal), and —
 * when `exceptFocusedByLiveTerminal` is set (the screen's own quit) — a
 * chat another live terminal is looking at.
 */
export function parkAllConcourseSessions(
  by: string,
  roster: { kill(short: string): boolean } | undefined,
  dir?: string,
  opts?: { reason?: string; exceptFocusedByLiveTerminal?: boolean },
): ConcourseParkAllReceipt {
  const receipt: ConcourseParkAllReceipt = { parked: [], draining: [], released: [], skipped: [], refused: [] }
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined || rec.parkedAt !== undefined) continue
    if (rec.stoppedAt !== undefined || rec.attachedAt !== undefined) {
      receipt.skipped.push(rec.runnerId)
      continue
    }
    if (opts?.exceptFocusedByLiveTerminal === true && rec.focusedAt !== undefined && rec.focusedBy !== by) {
      const seatPid = stampedTerminalPid(rec.focusedBy)
      if (seatPid !== undefined && isProcessAlive(seatPid)) {
        receipt.skipped.push(rec.runnerId)
        continue
      }
    }
    const out = parkConcourseSession(rec.sessionId, by, roster, dir, opts?.reason !== undefined ? { reason: opts.reason } : undefined)
    if (out.outcome === 'applied') (out.released ? receipt.released : receipt.parked).push(rec.runnerId)
    else if (out.outcome === 'draining') receipt.draining.push(rec.runnerId)
    else if (out.outcome === 'refused') receipt.refused.push(rec.runnerId)
  }
  return receipt
}

export type ConcourseTagOutcome =
  | { outcome: 'applied' }
  | { outcome: 'noop'; reason: 'already-granted' | 'not-granted' }
  | { outcome: 'refused'; reason: 'unknown-session' | 'cap-one'; detail?: string }

/** W3: grant the workflows-allowed tag — cap ONE standing tag at a time
 *  (the operator's rule, "just to keep it simple for now"); a second
 *  grant is refused in plain words naming the holder. */
export function grantConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed === true) {
      out = { outcome: 'noop', reason: 'already-granted' }
      return
    }
    const holder = Object.values(workers).find(
      r => r.endedAt === undefined && r.workflowsAllowed === true,
    )
    if (holder) {
      out = {
        outcome: 'refused',
        reason: 'cap-one',
        detail: `"${holder.title ?? holder.runnerId}" already holds workflows-allowed — one tagged session at a time; revoke it first`,
      }
      return
    }
    rec.workflowsAllowed = true
    rec.workflowsGrantedBy = by
    rec.workflowsGrantedAt = Date.now()
    out = { outcome: 'applied' }
  }, dir)
  return out
}

/** W3: revoke the workflows-allowed tag (idempotent by state). */
export function revokeConcourseWorkflows(
  sessionId: string,
  by: string,
  dir?: string,
): ConcourseTagOutcome {
  void by
  let out: ConcourseTagOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return
    if (rec.workflowsAllowed !== true) {
      out = { outcome: 'noop', reason: 'not-granted' }
      return
    }
    delete rec.workflowsAllowed
    delete rec.workflowsGrantedBy
    delete rec.workflowsGrantedAt
    out = { outcome: 'applied' }
  }, dir)
  return out
}

// ── the focus fact (Law 9 rule 4 made durable) ──────────────────────────────

export type ConcourseFocusOutcome =
  | { outcome: 'applied'; runnerId: string; cleared: string[] }
  | { outcome: 'noop'; reason: 'already-focused' | 'not-focused' }
  | { outcome: 'refused'; reason: 'unknown-session' }

/** The terminal pid a seat stamp names ('operator:<pid>', the attachedBy
 *  grammar), or undefined for a stamp that names none. */
export function stampedTerminalPid(by: string | undefined): number | undefined {
  const pid = /^operator:(\d+)$/.exec(by ?? '')?.[1]
  return pid === undefined ? undefined : Number(pid)
}

/**
 * THE FOCUS VERB — the fact's one writer. The session `by` is looking at
 * takes the stamp and every other live record `by` had stamped loses it in
 * the same publication: one focused chat per terminal, so a hop A→B moves
 * the operator's seat and A returns to the grant-gated law at once.
 * Idempotent by state (re-focusing the focused chat is a noop). Callers:
 * the hop (the connector's attach) and one-door's create-on-Enter, which
 * births a session born-and-focused through THIS door — never a second
 * writer.
 */
export function focusConcourseSession(sessionId: string, by: string, dir?: string): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const cleared: string[] = []
    for (const other of Object.values(workers)) {
      if (other === rec || other.endedAt !== undefined || other.focusedBy !== by) continue
      delete other.focusedAt
      delete other.focusedBy
      cleared.push(other.runnerId)
    }
    if (rec.focusedAt !== undefined && rec.focusedBy === by && cleared.length === 0) {
      out = { outcome: 'noop', reason: 'already-focused' }
      return
    }
    rec.focusedAt = Date.now()
    rec.focusedBy = by
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared }
  }, dir)
  return out
}

/**
 * THE BLUR VERB: the terminal that stamped the seat gives it back (its
 * connector lost the slot — a hop away, a blank chat taking the slot,
 * close-all). A stamp another terminal owns is never touched: noop.
 */
export function blurConcourseSession(sessionId: string, by: string, dir?: string): ConcourseFocusOutcome {
  let out: ConcourseFocusOutcome = { outcome: 'refused', reason: 'unknown-session' }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (rec.focusedAt === undefined || rec.focusedBy !== by) {
      out = { outcome: 'noop', reason: 'not-focused' }
      return
    }
    delete rec.focusedAt
    delete rec.focusedBy
    out = { outcome: 'applied', runnerId: rec.runnerId, cleared: [rec.runnerId] }
  }, dir)
  return out
}

/**
 * SESSION-AWARE NAMING's one writer (L16): store the session's title on its
 * record. An OPERATOR title always lands (typed names outrank and outlive
 * everything); a MINTED title fills an EMPTY slot only and stamps
 * titleMintedAt exactly once — the never-overwrite and never-twice laws
 * live HERE, at the record's one writer, not in any caller. Publishing
 * stamps the delta, so every board repaints the new name within a beat.
 */
export function setConcourseSessionTitle(
  sessionId: string,
  rawTitle: string,
  by: string,
  source: 'operator' | 'minted',
  dir?: string,
): { outcome: 'applied' | 'noop' | 'refused'; detail?: string } {
  void by
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (title.length === 0) return { outcome: 'refused', detail: 'a title needs words' }
  let out: { outcome: 'applied' | 'noop' | 'refused'; detail?: string } = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    if (source === 'minted') {
      if (rec.titleMintedAt !== undefined) {
        out = { outcome: 'noop', detail: 'minted once already — the mint never runs twice' }
        return
      }
      if ((rec.title ?? '').trim().length > 0) {
        out = { outcome: 'noop', detail: 'a title already stands — the mint fills empty titles only' }
        return
      }
      rec.titleMintedAt = Date.now()
    }
    rec.title = title
    rec.titleSource = source
    out = { outcome: 'applied' }
  }, dir)
  return out
}

/**
 * The NO-ADOPTION guard's oracle (the binding law): the
 * runnerId of the LIVE worker that owns this session's transcript, or null.
 * Adopting a live worker's session through the REPL switch machinery would
 * re-point the session file pointer under a running headless turn — the
 * exact cross-process twin of the mid-turn corruption class the resume
 * guard exists for. Conservative liveness: a record owns only while its pid
 * is positively alive (a dead worker's session is honestly resumable —
 * reconciliation settles the record). Sync + fail-soft: a torn/absent
 * records file answers null, never a resume outage.
 */
export function sessionOwnedByLiveWorker(sessionId: string, dir?: string): string | null {
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt !== undefined) continue
    if (rec.sessionId !== sessionId) continue
    // while attachedAt stands the OPERATOR's terminal owns
    // this transcript (the child is dead by handover) — a foreign adoption
    // would be the same two-writer corruption class, so the oracle answers
    // owned. The switchboard's own enter path never rides this guard.
    if (rec.attachedAt !== undefined) return rec.runnerId
    if (workerPidAlive(rec)) return rec.runnerId
  }
  return null
}

/** sessionIds of every CURRENT board-homed worker record
 *  (endedAt unset — live, paused, or crash-respawnable). While a record
 *  stands, the concourse board is the session's home: the switcher, tab
 *  strip, and RECENT lane hide these rows (post-sever they are
 *  operator-classed, so the crew filter alone would let them flood back).
 *  A settled/released session has no standing record and shows as a normal
 *  operator transcript. A PARKED record is resumable history, not a live
 *  board home — the pickers offer it exactly as they offer a released
 *  chat (every pick rides the one resume door). Sync + fail-soft:
 *  unreadable records ⇒ empty set. */
export function boardHomedSessionIds(dir?: string): Set<string> {
  const out = new Set<string>()
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && rec.parkedAt === undefined) out.add(rec.sessionId)
  }
  return out
}

/** Live worker count for the fleet chip (records ∩ positive pid liveness) —
 *  the supervisor-truth read liveCountBridge re-points to (the PID-registry
 *  count retired per the migration). Sync + fail-soft to 0. */
export function countLiveConcourseWorkers(dir?: string): number {
  let n = 0
  for (const rec of Object.values(readSessionWorkers(dir))) {
    if (rec.endedAt === undefined && workerPidAlive(rec)) n++
  }
  return n
}
