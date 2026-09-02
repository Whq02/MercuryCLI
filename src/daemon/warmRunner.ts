// ============================================================================
//  daemon/warmRunner — the warm-runner pool (the operator's word:
//  the first reply after a cold boot is as fast
//  as it was).
//
//  A WARM RUNNER is one idle session-runner process the daemon pre-spawns
//  for a workspace: booted through the worker role's whole init (config,
//  providers, MCP and skills rosters — WEARING the next birth's kit: the
//  arming screen's carried snapshot, else the workspace's menu derivation,
//  spec-carried as MERCURY_SESSION_KIT exactly like a cold spawn's) but
//  with NO record on the board, NO transcript, NO identity and NO model
//  pinned — the spawn carries neither `--session-id` nor `--resume`, so
//  the runner parks before its first turn awaiting a claim. Looking still creates nothing: the pool lives only in
//  this map, never in the durable records, so the board, the session lists,
//  reconcile and idle retirement ignore it BY CONSTRUCTION (they all read
//  records). `mercury daemon status` names it honestly on its own line.
//
//  THE CLAIM: admission (concourseSupervisor.makeConcourseAdmitHandler)
//  finds a live warm runner for the same workspace and claims it instead of
//  spawning — one `claim_session` control hands the runner its session id,
//  model, permission posture and effort BEFORE the first words; the record
//  is minted only after the runner acknowledges. THE KIT GATE: the claim
//  lands only when the admitted session's kit equals the runner's booted
//  kit byte-for-byte (the record stamps what the process actually wears —
//  never a whole-config process under a kit-stamped record; the frame
//  itself carries no kit — the env boot plus this equality make that
//  redundant). The claim is an optimisation, never a dependency: any
//  decline here (no runner, dead runner, settings drift, kit drift, an
//  unanswered control) falls back to the cold spawn path unchanged.
//
//  RETIREMENT: a warm runner dies with its owner (it is an ordinary roster
//  child — the daemon's teardown and the worker parent-watch both take it),
//  on its own idle budget (MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES, shorter
//  than the session default — swept from the daemon's minute tick), and on
//  a workspace switch (`retiring` on the ensure). It never survives a
//  daemon restart: it is a child process with no record to reconcile.
//
//  ENGAGE BOUND: a warm runner is never a default-on background engage
//  beyond what the daemon pre-warm already is. It spawns only on the
//  screen's own doors — the owned daemon's boot (the screen spawned that
//  daemon after its first paint, owner-pid stamped) and the screen's
//  concourseWarm call from the same mount hook that pre-warms the daemon —
//  and the re-warm after a claim, while the claimed screen session lives.
// ============================================================================
import { statSync } from 'node:fs'

import { flagEnv } from '../substrate/flagRegistry.js'
import { resolveEffectiveSettingsSnapshot } from '../substrate/startupMenu.js'
import { minutesKnobToMs } from '../utils/deadline.js'
import { logForDebugging } from '../utils/debug.js'
import { validateWorkerModelChoice } from '../services/concourse/workerModels.js'
import { deriveSessionKitForWorkspace, type SessionKitV1 } from './sessionKit.js'
import {
  buildConcourseWorkerSpec,
  canonicalWorkspaceId,
  CONCOURSE_SHORT_PREFIX,
  effectiveSeatCeiling,
  readSessionWorkers,
} from './concourseSupervisor.js'
import type { StreamJsonChildSpec } from './headlessRun.js'
import { isProcessAlive } from './ownerWatch.js'

export const DEFAULT_WARM_RUNNER_IDLE_RETIRE_MINUTES = 5

/** The warm runner's own idle budget — deliberately shorter than the
 *  session default (an unclaimed process holds providers and MCP servers
 *  open); 0 disables the sweep. */
export function warmRunnerIdleRetireMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_WARM_RUNNER_IDLE_RETIRE_MINUTES'), DEFAULT_WARM_RUNNER_IDLE_RETIRE_MINUTES)
}

/** The pool's off switch: MERCURY_WARM_RUNNER=0 disables every warm spawn
 *  (the boot self-warm, the RPC door, the re-warm after a claim) — for the
 *  per-process spawn-census drives and any operator who wants no idle
 *  runner. Anything else ⇒ on: the line-7 restoration is the default. */
export function warmRunnerPoolEnabled(): boolean {
  return flagEnv('MERCURY_WARM_RUNNER') !== '0'
}

/** The claim control's answer deadline: a warm runner still finishing its
 *  init answers the instant its stdin loop opens (the control waits in the
 *  pipe), so an honest claim never approaches this — past it the runner is
 *  in an unknown state and the claim declines to the cold path. */
const CLAIM_ANSWER_DEADLINE_MS = 10_000

export const WARM_CLAIM_REQUEST_PREFIX = 'mercury-warm-claim-'

interface WarmRunnerEntry {
  short: string
  workspaceId: string
  pid?: number
  spawnedAt: number
  /** The ensure that found this runner already live refreshes the clock —
   *  the screen re-arming the pool means it is still wanted. */
  lastKeptAt: number
  /** The registry-default model the runner booted on (model-agnostic until
   *  claimed; the claim applies the admitted session's own). */
  bootModelKey: string
  /** Settings-parity guard: a claim only lands on a runner that booted the
   *  SAME effective settings the admitted session would resolve now. */
  snapshotId: string
  /** THE KIT THE RUNNER BOOTED WITH (ledger L24; the warm-claim kit gate):
   *  the spec-carried MERCURY_SESSION_KIT this process consumed at its
   *  boot — the ensure's carried kit, else the workspace's menu derivation
   *  at warm time. A claim only lands when the admitted session's kit
   *  equals this byte-for-byte (both sides normalized by the same
   *  narrowing/derivation), so a claimed record can never wear a kit its
   *  process did not boot. */
  kit: SessionKitV1
}

/** One pool per daemon process, keyed by canonical workspace id — one warm
 *  runner per workspace, never more. */
const pool = new Map<string, WarmRunnerEntry>()

/** Pending claim-control waiters keyed by request id (resolved by the
 *  roster drain's per-line hook). */
const claimWaiters = new Map<string, (outcome: { ok: boolean; error?: string }) => void>()

/** A request that landed while its workspace's warm-up was in the air. */
interface TrailingEnsure {
  /** The kit the trailing request asks for (undefined = derive now) — a
   *  request's kit, never a session record's stamp. */
  requestedKit: SessionKitV1 | undefined
  deps: WarmRunnerDeps
  waiters: Array<{ resolve: (outcome: WarmEnsureOutcome) => void; reject: (err: unknown) => void }>
}

/** One workspace's warm-up in the air, and the ONE request waiting behind
 *  it. Two overlapping ensures (the boot self-warm, the screen's RPC door and
 *  the post-claim re-warm all fire un-serialized) must never both pass the
 *  empty-pool check across the model-validation await — the loser's child
 *  was overwritten OUT of the pool: alive on the roster, invisible to the
 *  idle sweep, retired only by daemon death. So one runs at a time; an EQUAL
 *  request (the same carried kit, or both deriving) joins the run. A request
 *  for a DIFFERENT kit cannot join it — a runner booted for the older kit
 *  can never serve the newer one, and joining would hand the caller that
 *  runner while its own kit was dropped — so it waits as the trailing
 *  request, and ONE rerun after the run settles serves it. Exactly one: a
 *  later arrival REPLACES the trailing kit and inherits its waiters, so a
 *  stale kit is never queued and the newest is never dropped. */
interface EnsureFlight {
  /** The kit the running body was asked for (undefined = derive now) — a
   *  request's kit; a session record's kit is written only by the kit
   *  owner's stamp doors (sessionKit.ts). */
  requestedKit: SessionKitV1 | undefined
  run: Promise<WarmEnsureOutcome>
  trailing: TrailingEnsure | null
}

/** In-flight ensures keyed by canonical workspace id. */
const ensureFlights = new Map<string, EnsureFlight>()

/** Proofs drive the pool in-process; each scenario starts empty. */
export function resetWarmRunnersForTesting(): void {
  pool.clear()
  claimWaiters.clear()
  ensureFlights.clear()
}

/** The roster surface the pool needs (a structural subset of the daemon
 *  roster, so provers drive the real policy with a fake). */
export interface WarmRosterPort {
  has(short: string): { alive: boolean; present: boolean; ready: boolean }
  list(): ReadonlyArray<{ short: string; outcome?: unknown }>
  registerLongLived(short: string, spec: StreamJsonChildSpec): { ok: boolean; pid?: number; error?: string }
  control(short: string, frame: string): boolean
  kill(short: string): boolean
  /** Claim-time spec patch: model + effort + the respawn argv that resumes
   *  the claimed session (see roster.patchSeatClaim). */
  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[] },
  ): StreamJsonChildSpec | null
}

export interface WarmRunnerDeps {
  roster: () => WarmRosterPort | undefined
  /** Daemon record dir override (proofs pin scratch; absent ⇒ daemonDir()). */
  dir?: string
  /** Post-spawn log hook (main.ts's console line). */
  onWarmSpawned?: (short: string, workspaceId: string, pid: number | undefined) => void
}

export type WarmEnsureOutcome = { state: 'warmed' | 'kept' | 'refused'; detail?: string; short?: string }

/** The admit handler's live-worker derivation (records ∩ roster), reused so
 *  the seat-reading bound counts exactly what admission counts. */
function liveSeatCount(dir: string | undefined, roster: WarmRosterPort): number {
  const records = readSessionWorkers(dir)
  const liveShorts = new Set(roster.list().filter(j => !j.outcome).map(j => j.short))
  return Object.values(records).filter(
    r => r.endedAt === undefined && r.parkedAt === undefined && (liveShorts.has(r.runnerId) || r.attachedAt !== undefined),
  ).length
}

/** Live entries only — a dead runner leaves the pool the moment any verb
 *  looks at it (admission then spawns cold, exactly as if none existed). */
function livePoolEntries(roster: WarmRosterPort): WarmRunnerEntry[] {
  const out: WarmRunnerEntry[] = []
  for (const [ws, entry] of [...pool]) {
    const state = roster.has(entry.short)
    const alive = state.present && state.alive && (entry.pid === undefined || isProcessAlive(entry.pid))
    if (!alive) {
      pool.delete(ws)
      continue
    }
    out.push(entry)
  }
  return out
}

/** The lowest free concourse short — the admission mint's own rule, against
 *  the same records + roster truth (the warm runner occupies a real slot
 *  name so a later claim keeps a respawn-stable identity). */
function mintWarmShort(dir: string | undefined, roster: WarmRosterPort): string | null {
  const records = readSessionWorkers(dir)
  const used = new Set(Object.values(records).filter(r => r.endedAt === undefined).map(r => r.runnerId))
  for (let n = 1; n <= used.size + 4096; n++) {
    const candidate = `${CONCOURSE_SHORT_PREFIX}${n}`
    if (!used.has(candidate) && !roster.has(candidate).present) return candidate
  }
  return null
}

/** The settings-parity fingerprint (snapshotId excludes the session id, so
 *  a warm-time capture compares equal to a claim-time one byte-for-byte). */
function currentSnapshotId(): string {
  return resolveEffectiveSettingsSnapshot({ sessionId: 'warm-unclaimed' }).snapshotId
}

/** THE KIT-PARITY COMPARISON (the warm-claim kit gate's whole arithmetic):
 *  byte-equality of the JSON spelling. Sound because every kit that reaches
 *  the pool or the claim is normalized by ONE builder — the wire's
 *  validateSessionKit rebuilds a carried kit field-by-field in fixed order,
 *  and deriveSessionKitForWorkspace composes the derived one the same way
 *  each call — so equal memberships spell equal bytes. Conservative on
 *  purpose: a false negative (a carried resolved kit vs a derived
 *  unresolved one, list-order drift across store rewrites) only costs a
 *  cold spawn; it can never serve a wrong wear. */
function sameKit(a: SessionKitV1, b: SessionKitV1): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Pre-spawn (or keep) the ONE warm runner for a workspace. Fail-soft on
 * every arm: a refusal is a typed detail, never a thrown error — the next
 * dispatch simply cold-spawns.
 */
export async function ensureWarmRunner(
  args: {
    workspaceDir: string
    retiring?: string
    bootCarriesRunnerOptions?: boolean
    /** THE KIT THE POOL PRE-BOOTS (ledger L24; the warm-claim kit gate):
     *  the arming screen's next-session kit when it holds one (the L18
     *  carry — the same truth its births will admit with), else the
     *  workspace's menu derivation here. The warm runner exists to serve
     *  the NEXT birth, and by L18 that birth gets exactly this kit — so
     *  the pool boots wearing it, and the claim's equality gate makes the
     *  common case a hit while a menu edit in between declines honestly. */
    kit?: SessionKitV1
  },
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  if (!warmRunnerPoolEnabled()) {
    return { state: 'refused', detail: 'the warm pool is off (MERCURY_WARM_RUNNER=0)' }
  }
  // A boot that carries runner-side options (--strict-mcp-config, an
  // append prompt, …) admits its sessions WITH those options — a claim can
  // never serve them (the pool boots the plain worker shape), so warming
  // would only spawn a process the operator's own flags excluded. Honest
  // refusal; every dispatch there spawns cold with the flags.
  if (args.bootCarriesRunnerOptions === true) {
    return { state: 'refused', detail: 'this boot carries runner-side options the pool cannot serve — its sessions spawn cold with them' }
  }
  const roster = deps.roster()
  if (!roster) return { state: 'refused', detail: 'daemon roster not ready' }
  let workspaceId: string
  try {
    workspaceId = canonicalWorkspaceId(args.workspaceDir)
  } catch {
    return { state: 'refused', detail: `workspace does not resolve: ${args.workspaceDir}` }
  }
  // The workspace switch: the old workspace's warm runner retires first, so
  // the pool never grows past one per workspace and an abandoned workspace
  // never keeps a process past the switch. Runs PER CALL, before the flight
  // join below — a joiner's own retiring workspace must still retire.
  if (args.retiring !== undefined) {
    try {
      retireWarmRunner(canonicalWorkspaceId(args.retiring), 'workspace-switch', deps)
    } catch {
      /* an unresolvable retiring dir holds nothing to retire */
    }
  }
  // Single-flight per workspace with ONE trailing rerun (EnsureFlight): an
  // equal request joins the run, a different kit waits behind it as the
  // newest trailing request. The chain clears the slot only once nothing
  // trails, so a request landing mid-rerun trails that rerun instead of
  // minting a concurrent second flight.
  const inFlight = ensureFlights.get(workspaceId)
  if (inFlight !== undefined) return awaitBehindFlight(inFlight, args.kit, deps)
  const flight: EnsureFlight = { requestedKit: args.kit, run: ensureWarmRunnerFlight(workspaceId, args.kit, deps), trailing: null }
  ensureFlights.set(workspaceId, flight)
  settleEnsureFlight(workspaceId, flight)
  return flight.run
}

/** Equal requests: both derive now, or both carry the same kit. */
function sameRequestedKit(a: SessionKitV1 | undefined, b: SessionKitV1 | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return sameKit(a, b)
}

/** A request landing while its workspace's warm-up is in the air: an equal
 *  one (and nothing trailing yet) joins the run; any other becomes THE
 *  trailing request — the newest kit, replacing an earlier trailing one and
 *  inheriting its waiters, every one of them answered by the rerun. */
function awaitBehindFlight(
  flight: EnsureFlight,
  kit: SessionKitV1 | undefined,
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  if (flight.trailing === null && sameRequestedKit(flight.requestedKit, kit)) return flight.run
  return new Promise<WarmEnsureOutcome>((resolve, reject) => {
    const waiters = flight.trailing?.waiters ?? []
    waiters.push({ resolve, reject })
    flight.trailing = { requestedKit: kit, deps, waiters }
  })
}

/** The flight chain, wired as settlement reactions (registered BEFORE any
 *  caller's own await, so the slot is already re-decided when a caller
 *  continues): when the run settles, the trailing request — if one landed —
 *  becomes the next run and its waiters take that run's outcome; otherwise
 *  the slot clears. Only the chain clears the slot, and only its OWN flight
 *  — a stale clear must never wipe a newer flight back open. */
function settleEnsureFlight(workspaceId: string, flight: EnsureFlight): void {
  const onSettled = (): void => {
    const next = flight.trailing
    if (next === null) {
      if (ensureFlights.get(workspaceId) === flight) ensureFlights.delete(workspaceId)
      return
    }
    flight.trailing = null
    flight.requestedKit = next.requestedKit
    flight.run = ensureWarmRunnerFlight(workspaceId, next.requestedKit, next.deps)
    void flight.run.then(
      outcome => {
        for (const waiter of next.waiters) waiter.resolve(outcome)
      },
      (err: unknown) => {
        for (const waiter of next.waiters) waiter.reject(err)
      },
    )
    void flight.run.then(onSettled, onSettled)
  }
  void flight.run.then(onSettled, onSettled)
}

/** The ensure body, one per workspace at a time (the flight map above). */
async function ensureWarmRunnerFlight(
  workspaceId: string,
  carriedKit: SessionKitV1 | undefined,
  deps: WarmRunnerDeps,
): Promise<WarmEnsureOutcome> {
  const roster = deps.roster()
  if (!roster) return { state: 'refused', detail: 'daemon roster not ready' }
  // THE KIT this warm boot wears (carried by the arming screen, else the
  // menu derivation — fail-soft inside the derivation: an unreadable store
  // is the empty deltas, everything on). Computed BEFORE the keep-check so
  // a kept runner is kept only when it still wears the kit the next birth
  // would get.
  const kit = carriedKit ?? deriveSessionKitForWorkspace(workspaceId)
  const existing = pool.get(workspaceId)
  if (existing !== undefined) {
    const state = roster.has(existing.short)
    if (state.present && state.alive && (existing.pid === undefined || isProcessAlive(existing.pid))) {
      if (sameKit(existing.kit, kit)) {
        existing.lastKeptAt = Date.now()
        return { state: 'kept', detail: existing.short, short: existing.short }
      }
      // KIT DRIFT at the ensure: the pool's runner booted a kit the next
      // birth no longer gets (a menu edit, a fresh carried snapshot) — it
      // can never honestly serve again; retire it and warm the current one.
      retireWarmRunner(workspaceId, 'kit drift — the menu moved since the warm boot', deps)
    } else {
      pool.delete(workspaceId)
    }
  }
  let stat
  try {
    stat = statSync(workspaceId)
  } catch {
    return { state: 'refused', detail: `workspace does not exist: ${workspaceId}` }
  }
  if (!stat.isDirectory()) return { state: 'refused', detail: `workspace is not a directory: ${workspaceId}` }
  // THE SEAT READING BOUND: a warm runner never consumes a seat the board
  // would refuse — live seats (the admission count) plus live warm runners
  // stay under the ceiling, so admission is never squeezed by the pool.
  const ceiling = effectiveSeatCeiling()
  const seatsHeld = liveSeatCount(deps.dir, roster) + livePoolEntries(roster).length
  if (seatsHeld + 1 > ceiling) {
    return { state: 'refused', detail: `seat reading: ${seatsHeld} held of ${ceiling} — no headroom for a warm runner` }
  }
  // Model-agnostic until claimed: the runner boots the registry default;
  // the claim applies the admitted session's validated pick.
  const validated = await validateWorkerModelChoice(undefined, 'session')
  if (!validated.ok) {
    return { state: 'refused', detail: `registry default unavailable (${validated.reason}) — the next dispatch spawns cold` }
  }
  // Recheck across the await: the flight map keeps ensures out of each
  // other's way, but the pool has other writers (a claim deletes, proofs
  // reset) — a live same-kit entry that appeared while validation ran is
  // kept, never doubled.
  const appeared = pool.get(workspaceId)
  if (appeared !== undefined) {
    const state = roster.has(appeared.short)
    if (state.present && state.alive && (appeared.pid === undefined || isProcessAlive(appeared.pid)) && sameKit(appeared.kit, kit)) {
      appeared.lastKeptAt = Date.now()
      return { state: 'kept', detail: appeared.short, short: appeared.short }
    }
  }
  const short = mintWarmShort(deps.dir, roster)
  if (short === null) return { state: 'refused', detail: 'no free worker slot' }
  const snapshotId = currentSnapshotId()
  const spec = buildConcourseWorkerSpec({
    runnerId: short,
    workspaceId,
    modelKey: validated.entry.modelId,
    effort: 'high',
    warm: true,
    // The warm boot WEARS the kit (spec-carried MERCURY_SESSION_KIT,
    // consumed once at child boot): the process only ever connects the
    // kit's members — the absent-not-hidden law holds from the spawn, and
    // the claim's equality gate can hand it a record telling the truth.
    kit,
  })
  const reg = roster.registerLongLived(short, spec)
  if (!reg.ok) return { state: 'refused', detail: reg.error ?? 'registerLongLived refused' }
  pool.set(workspaceId, {
    short,
    workspaceId,
    ...(reg.pid !== undefined ? { pid: reg.pid } : {}),
    spawnedAt: Date.now(),
    lastKeptAt: Date.now(),
    bootModelKey: validated.entry.modelId,
    snapshotId,
    kit,
  })
  deps.onWarmSpawned?.(short, workspaceId, reg.pid)
  return { state: 'warmed', detail: short, short }
}

export type WarmClaimOutcome =
  | { claimed: true; short: string; pid?: number; spec: StreamJsonChildSpec }
  | { claimed: false; reason: string }

/**
 * Claim the workspace's warm runner for an admitted session: one
 * `claim_session` control carries the id, model, posture and effort; the
 * runner's acknowledgement is the moment the record may be minted. Every
 * decline retires nothing the cold path needs — admission spawns as today.
 */
export async function claimWarmRunner(
  args: {
    workspaceId: string
    sessionId: string
    modelKey: string
    effort: string
    permissionMode: string
    /** THE KIT the admission stamps on the record (carried ?? derived —
     *  the caller's ONE hoisted value): the claim lands only on a runner
     *  whose booted kit equals it byte-for-byte, so a claimed record can
     *  never wear a kit its process did not boot (the warm-claim kit
     *  gate — the kit estate's top open hole, closed here). */
    kit: SessionKitV1
    /** A REACTIVATE: the id names a parked session whose transcript the
     *  runner loads at the claim (the reactivate door's warm road). */
    resume?: true
    answerDeadlineMs?: number
  },
  deps: WarmRunnerDeps,
): Promise<WarmClaimOutcome> {
  const roster = deps.roster()
  if (!roster) return { claimed: false, reason: 'roster not ready' }
  const entry = pool.get(args.workspaceId)
  if (entry === undefined) return { claimed: false, reason: 'no warm runner for this workspace' }
  const state = roster.has(entry.short)
  if (!state.present || !state.alive || (entry.pid !== undefined && !isProcessAlive(entry.pid))) {
    pool.delete(args.workspaceId)
    return { claimed: false, reason: 'the warm runner died' }
  }
  // Settings drift: the runner booted an older effective-settings
  // resolution than a cold spawn would get now — retire it (it can never
  // honestly serve a session again) and let admission spawn fresh.
  if (currentSnapshotId() !== entry.snapshotId) {
    retireWarmRunner(args.workspaceId, 'settings-drift', deps)
    return { claimed: false, reason: 'effective settings changed since the warm boot' }
  }
  // THE KIT GATE (the settings-drift grammar, on the kit): a claim lands
  // only on a runner that BOOTED the admitted session's exact kit — the
  // record stamps args.kit, the process latched entry.kit at its boot, and
  // record.kit ≡ the process's effective kit is the law this gate holds.
  // Mismatch means the menu moved since the warm boot (or the screen
  // carries a fresh snapshot the pool never booted): this runner can never
  // honestly serve again — retire it; the cold path wears the kit and the
  // caller's decline-side rewarm re-arms the pool with it. Deliberately
  // NEVER a child-side reconcile: a narrowing reconcile would serve a
  // session from a process that already CONNECTED the excluded members
  // (the absent-not-hidden law's warm edge), a widening one pays the
  // connect cost a cold spawn pays anyway, and the live-apply machinery is
  // the dials' seam, not the claim's.
  if (!sameKit(args.kit, entry.kit)) {
    retireWarmRunner(args.workspaceId, 'kit drift — the warm runner booted a different kit than this admission carries', deps)
    return { claimed: false, reason: 'the menu kit changed since the warm boot' }
  }
  const requestId = `${WARM_CLAIM_REQUEST_PREFIX}${entry.short}-${Date.now().toString(36)}`
  const frame = JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'claim_session',
      session_id: args.sessionId,
      model: args.modelKey,
      permission_mode: args.permissionMode,
      effort: args.effort,
      ...(args.resume === true ? { resume: true } : {}),
    },
  })
  const answered = new Promise<{ ok: boolean; error?: string }>(resolve => {
    const timer = setTimeout(() => {
      claimWaiters.delete(requestId)
      resolve({ ok: false, error: `no claim answer in ${(args.answerDeadlineMs ?? CLAIM_ANSWER_DEADLINE_MS) / 1000}s` })
    }, args.answerDeadlineMs ?? CLAIM_ANSWER_DEADLINE_MS)
    timer.unref?.()
    claimWaiters.set(requestId, outcome => {
      clearTimeout(timer)
      claimWaiters.delete(requestId)
      resolve(outcome)
    })
  })
  if (!roster.control(entry.short, frame)) {
    claimWaiters.delete(requestId)
    retireWarmRunner(args.workspaceId, 'no control channel', deps)
    return { claimed: false, reason: 'the warm runner has no live control channel' }
  }
  const outcome = await answered
  if (!outcome.ok) {
    // An unanswered or refused claim leaves the runner in an unknown state:
    // it never receives words, and the cold path serves the session.
    retireWarmRunner(args.workspaceId, `claim failed (${outcome.error ?? 'error'})`, deps)
    return { claimed: false, reason: outcome.error ?? 'the claim was refused' }
  }
  pool.delete(args.workspaceId)
  const spec = roster.patchSeatClaim(entry.short, {
    model: args.modelKey,
    effort: args.effort,
    respawnExtraArgv: ['--resume', args.sessionId, '--permission-prompt-tool', 'stdio', '--include-partial-messages'],
  })
  if (spec === null) {
    // The seat vanished between the ack and the patch — the runner answered
    // the claim, so a record without a live child would lie; decline and
    // let the cold path own the session.
    roster.kill(entry.short)
    return { claimed: false, reason: 'the claimed seat vanished before the spec patch' }
  }
  return { claimed: true, short: entry.short, ...(entry.pid !== undefined ? { pid: entry.pid } : {}), spec }
}

/** The roster drain's per-line hook: resolve a pending claim waiter from
 *  the runner's control_response. Substring test first — the hot path costs
 *  one includes() per line. */
export function onWarmRunnerLine(line: string): void {
  if (claimWaiters.size === 0 || !line.includes(WARM_CLAIM_REQUEST_PREFIX) || !line.includes('"control_response"')) return
  try {
    const frame = JSON.parse(line) as {
      type?: string
      response?: { subtype?: string; request_id?: string; error?: string }
    }
    if (frame.type !== 'control_response' || typeof frame.response?.request_id !== 'string') return
    const waiter = claimWaiters.get(frame.response.request_id)
    if (waiter === undefined) return
    waiter(frame.response.subtype === 'success' ? { ok: true } : { ok: false, error: frame.response.error ?? 'claim refused' })
  } catch {
    /* torn frame — the deadline answers */
  }
}

/** Retire one workspace's warm runner (idle budget, workspace switch,
 *  settings drift, a failed claim). The roster kill is intentional — the
 *  crash supervisor stands down, nothing respawns. */
export function retireWarmRunner(workspaceId: string, reason: string, deps: WarmRunnerDeps): boolean {
  const entry = pool.get(workspaceId)
  if (entry === undefined) return false
  pool.delete(workspaceId)
  const roster = deps.roster()
  const killed = roster !== undefined ? roster.kill(entry.short) : false
  // eslint-disable-next-line no-console
  console.error(`[daemon] warm runner retired: ${entry.short} (${workspaceId}) — ${reason}${killed ? '' : ' (no live child to kill)'}`)
  return true
}

/** One sweep from the daemon's minute tick: dead entries leave quietly;
 *  live ones past the warm idle budget retire. */
export function sweepIdleWarmRunners(deps: WarmRunnerDeps, opts: { nowMs?: number; thresholdMs?: number } = {}): number {
  const thresholdMs = opts.thresholdMs ?? warmRunnerIdleRetireMs()
  if (!(thresholdMs > 0)) return 0
  const roster = deps.roster()
  if (!roster) return 0
  const nowMs = opts.nowMs ?? Date.now()
  let retired = 0
  for (const entry of livePoolEntries(roster)) {
    const idleMs = nowMs - Math.max(entry.spawnedAt, entry.lastKeptAt)
    if (idleMs < thresholdMs) continue
    retireWarmRunner(entry.workspaceId, `idle ${Math.round(idleMs / 1000)}s past the warm budget`, deps)
    retired++
  }
  return retired
}

/** The status wire's honest line: how many warm runners live right now.
 *  (Reads the pool as-is — liveness pruning belongs to the verbs above, so
 *  a status probe never kills anything.) */
export function warmRunnerCount(): number {
  return pool.size
}

/** The pool's roster shorts — cache, not work: the handshake's idleness and
 *  the restart's live count set them aside (a successor re-warms). */
export function warmRunnerShorts(): string[] {
  return Array.from(pool.values(), e => e.short)
}

/** The pool as admission sees it — exported for provers. */
export function warmRunnerFor(workspaceId: string): { short: string; workspaceId: string } | undefined {
  const entry = pool.get(workspaceId)
  return entry === undefined ? undefined : { short: entry.short, workspaceId: entry.workspaceId }
}
