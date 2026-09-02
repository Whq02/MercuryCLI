// Mercury daemon — the worker roster.
//
// A single map, short id → live worker, spanning the two kinds of work the
// daemon runs:
//
//   • ONE-SHOT dispatched runs: isolated headless `-p` children
//     (headlessRun.ts). Nothing hosts a PTY (runPtyHost.ts explains why), so
//     a row tracks pid + lifecycle, never a terminal.
//   • LONG-LIVED supervised seats (crew teammates and session
//     workers): stream-json children with bidirectional stdin that the
//     roster relaunches under capped backoff, retargets without teardown,
//     and watches for context exhaustion.
//
// Routing never leaves the machine. A usable local teammate backend from the
// existing registry wins; otherwise the isolated headless child runs it. A
// bare daemon process has no live teammate context, so there the headless
// child is always what actually executes and the probe degrades honestly.
//
// The guard rails are imported rather than rebuilt: the shared DaemonBreaker
// and the in-flight ceiling can refuse work, and that is ALL they can do.

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessGroup } from '../utils/processGroup.js'
import { logForDebugging } from '../utils/debug.js'
import { assertSpawnCwd, recordSpawn, recordSpawnExit } from '../utils/spawnLedger.js'
import { DaemonBreaker } from '../utils/daemonBreaker.js'
import type { EffortValue } from '../utils/effort.js'
import { validateSeatEffort, validateSeatModel } from '../utils/model/seatSlots.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  getTeammateExecutor,
  isInProcessEnabled,
} from '../utils/swarm/backends/registry.js'
import {
  runTaskHeadless,
  buildHeadlessPrompt,
  spawnStreamJsonChild,
  type StreamJsonChildSpec,
} from './headlessRun.js'
import { resolveWorkerReconAllow } from './workerRecon.js'
import {
  decideRespawn,
  parseStreamJsonFrame,
  usageOfStreamJsonFrame,
  normalizeStreamJsonFrame,
  isTurnResultParsedFrame,
  errorTextOfParsedResultFrame,
  decideWorkerBusy,
  deriveWireSpec,
  getMaxTurnMs,
  DEFAULT_LONG_LIVED_CONFIG,
  DEFAULT_HEALTHY_RESET_MS,
  type LongLivedSupervisorConfig,
} from './longLivedSupervisor.js'
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js'
import {
  buildCarryForwardNote,
  carryForwardEnabled,
  lastSeenDispatchId,
} from './carryForward.js'
import { writeToMailbox } from '../utils/teammateMailbox.js'

/** Context usage (%) at/above which the auto-clear governor respawns an
 *  idle long-lived worker with a fresh transcript. */
export const AUTO_CLEAR_CONTEXT_PCT = 85
import { currentVersion } from './controlSocket.js'
import type { DispatchBody, DispatchSource, WireRosterEntry } from './protocol.js'

/** Where a rostered worker is in its life. */
export type RosterState =
  | 'spawning'
  | 'running'
  | 'retiring'
  | 'settled'
  | 'crashed'

/** One rostered worker. */
export interface RosterEntry {
  short: string
  sessionId: string
  prompt: string
  source: DispatchSource
  state: RosterState
  pid?: number
  startedAt: number
  cliVersion: string
  /** Why the run ended ('ok' / 'failed' / 'crashed' / 'killed'); set only at settle. */
  outcome?: string
  /** The path that actually executed it ('headless' | 'in-process' | 'tmux' | 'iterm2'). */
  via?: string
}

/** Ceiling on each seat's delivered-dispatch dedup set — a memory bound, not
 *  a behavior knob. It sits far above any plausible backlog, so eviction can
 *  only ever discard ids too old to be redelivered anyway. */
const DELIVERED_ID_CAP = 500

/** Supervision state for one long-lived seat. */
interface LongLivedSeat {
  /** Target for the NEXT spawn. Retarget patches merge in here right away,
   *  even while the bounce is queued — which is exactly why display reads
   *  derive from `running` below instead of from this. */
  spec: StreamJsonChildSpec
  cfg: LongLivedSupervisorConfig
  /** Counts the CURRENT crash loop; a healthy stretch of uptime zeroes it,
   *  so the ceiling measures loops rather than a lifetime. */
  respawns: number
  /** All crashes ever, never zeroed — the backstop for the slow loop: a
   *  child that keeps limping past the healthy-uptime bar (resetting
   *  `respawns` each time) still degrades at cfg.maxLifetimeCrashes. */
  lifetimeCrashes: number
  /** When the most recent spawn happened; healthy uptime is measured from here. */
  lastSpawnAt: number
  /** Operator/shutdown kill marker — respawn logic stands down when set. */
  intentionalStop: boolean
  /** Truthy exactly while a relaunch is scheduled but has not fired: armed on
   *  child exit, cleared the instant the spawn runs. Readers rely on it as
   *  the precise "a respawn is pending" bit. */
  respawnTimer?: ReturnType<typeof setTimeout>
  /** Marks a DELIBERATE retarget bounce: the exit handler relaunches at once
   *  on the patched spec and books no crash (the ceiling is untouched).
   *  Cleared inside the exit handler. */
  reconfiguring?: boolean
  /** A retarget that arrived mid-task parks here; the first observation of
   *  an idle seat applies it (bounce-now-or-queue semantics). */
  pendingReconfigure?: boolean
  /** When a dispatch last reached this seat's stdin. `undefined` means
   *  nothing was ever delivered (or no drain feeds this seat), which reads
   *  as IDLE — immediately safe to bounce. */
  lastDeliveredAt?: number
  /** Newest context-window fill % (0-100), mined from usage frames while
   *  stdout drains; list() hands it to the boards. */
  contextPct?: number
  /** Exact turn phase: set true when a user frame is written (turn opens),
   *  false when the child's `result` frame arrives (turn closes). Back-
   *  pressure that trusted a fixed post-delivery window instead would let a
   *  second task land mid-turn whenever a turn outlived the window.
   *  `undefined` ⇒ no boundary seen yet ⇒ fall back to the delivery clock. */
  turnActive?: boolean
  /** When the open turn began (its delivery moment). Paired with the turn
   *  cap (getMaxTurnMs) so a lost `result` frame cannot pin back-pressure
   *  forever and starve the queue. */
  turnStartedAt?: number
  /** Request ids already delivered (bounded, insertion-ordered) — the
   *  exactly-once fence. Redeliveries are expected (retries, imprecise
   *  mark-read matching, seat relaunches); none of them may run a dispatch
   *  twice. Living on the daemon side, the set outlasts worker respawns; a
   *  daemon restart replays unread mail and is at-least-once by design. */
  seenDispatchIds?: Set<string>
  /** Latched the moment the auto-clear decides to fire; released when the
   *  respawn lands. The clear performs an async mailbox write before the
   *  bounce, and more than one code path invokes the governor — inside that
   *  gap a second invocation would satisfy the threshold test again and
   *  duplicate both the handoff note and the respawn. */
  clearInFlight?: boolean
  /** Spawn counter that only climbs (+1 per successful launch). `respawns`
   *  cannot serve as a fence because healthy uptime rewinds it; this one
   *  fences stale settles: a completion seen from generation N must never
   *  close out an attempt handed to generation M > N. */
  spawnGeneration: number
  /** Latest is_error result text off this seat's stdout (bounded) — it gives
   *  the storm note its "why". Dropped on a healthy-uptime reset, because it
   *  was evidence about a loop that has now ended. */
  lastErrorText?: string
  /** Ensures at most one loop-forming note per crash loop; rearmed together
   *  with the `respawns` reset. The degrade note is separate and
   *  unconditional. */
  stormNotified?: boolean
  /** What the LIVE child actually launched with, captured at spawn time.
   *  Since `spec` may already hold a queued retarget, wire/board reads pass
   *  THIS through deriveWireSpec and expose spec drift as
   *  pendingModel/pendingEffort. */
  running?: { model: string; effort: string }
}

/** In-memory handle behind one roster row. */
interface WorkerHandle {
  entry: RosterEntry
  /** Child process, present once a spawn succeeded (either worker kind). */
  child?: ChildProcess
  /** Settles when a one-shot run finishes. */
  done: Promise<void>
  /** Present iff this row is a long-lived seat (registerLongLived). */
  longLived?: LongLivedSeat
}

export interface RosterOptions {
  /** Scheduling dir — the default cwd for dispatched runs. */
  dir: string
  /** The shared circuit-breaker (same instance the cron path feeds). */
  breaker: DaemonBreaker
  /** Ceiling on concurrent dispatched runs. */
  maxInflight: number
  /** Fired once when a seat runs out of respawn budget, letting the daemon
   *  persist a loud degraded marker into supervisor state. */
  onDegraded?: (reason: string, short?: string) => void
  /** Busy→idle edge hook, invoked the moment a seat turns idle (its `result`
   *  frame arrives, or a fresh child comes up). Without it the daemon would
   *  learn about idleness at its next poll tick; with it, queued retargets
   *  apply, the auto-clear governor runs, and a held dispatch goes out
   *  immediately. */
  onIdle?: (short: string) => void
  /** Permission-ask hook: children launched with --permission-prompt-tool
   *  stdio print their asks as control_request frames on stdout, and the
   *  drain forwards each one here so the daemon's ask owner can create the
   *  needs-attention obligation and return the verdict. Failure-tolerant and
   *  never allowed to stall the drain. */
  onControlRequest?: (short: string, frame: Record<string, unknown>) => void
  /** Every newline-framed stdout line of a long-lived child, raw — the
   *  session seat's hook (its facts answers, its init frame, its ask
   *  cancels). Failure-tolerant; never stalls the drain. */
  onChildLine?: (short: string, line: string) => void
}

export interface DispatchOutcome {
  ok: boolean
  short: string
  pid?: number
  via?: string
  /** Machine-readable refusal (mapped onto a protocol error code) when ok is false. */
  code?: 'EALIVE' | 'ENOCONN'
  error?: string
}

/**
 * The worker roster. Indexes every run by its short id, backs the control
 * server's lifecycle ops (`list`/`has`/`kill`/`reply`/`dispatch`), supervises
 * the long-lived seats, and reports every one-shot settle to the shared
 * breaker.
 */
export class TaskRoster {
  private readonly handles = new Map<string, WorkerHandle>()
  private inFlight = 0
  /** Sticky, loud: set when some seat spends its whole respawn budget. */
  private degradedState: { degraded: boolean; reason: string } = {
    degraded: false,
    reason: '',
  }

  constructor(private readonly opts: RosterOptions) {}

  /** Long-lived supervision health, consumed by the status surfaces. */
  getSupervisorState(): { degraded: boolean; reason: string } {
    return { ...this.degradedState }
  }

  /** How many workers are currently live (not settled). */
  liveCount(): number {
    let n = 0
    for (const h of this.handles.values()) {
      if (!h.entry.outcome) n++
    }
    return n
  }

  /** All rostered workers, settled ones included until they are reaped. */
  totalCount(): number {
    return this.handles.size
  }

  /**
   * The REAPABLE roster: every live worker by name and purpose — what a
   * shutdown reap is about to kill, spelled so /halt can report it honestly
   * ("reaped 5 workers" told the operator nothing; this names each one).
   * 'retiring' entries are EXCLUDED: they were already reaped once (kill()
   * marks them) and counting them again is how one halt's workers were
   * re-reported by the next ("an immediate second /halt reaped 4 MORE").
   */
  liveWorkerFacts(): Array<{
    short: string
    kind: 'long-lived' | 'one-shot'
    purpose: string
    pid?: number
  }> {
    const facts: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }> = []
    for (const h of this.handles.values()) {
      if (h.entry.outcome) continue
      if (h.entry.state === 'retiring') continue
      const longLived = h.longLived !== undefined
      // spec.role is the role ENV VAR name ('MERCURY_CREW') — the
      // operator-facing word drops the prefix: 'crew seat'.
      const purpose = longLived
        ? `${h.longLived!.spec.role.replace(/^MERCURY_/, '').toLowerCase()} seat`
        : `${h.entry.source} run: ${h.entry.prompt.replace(/\s+/g, ' ').slice(0, 48)}`
      facts.push({
        short: h.entry.short,
        kind: longLived ? 'long-lived' : 'one-shot',
        purpose,
        ...(h.entry.pid !== undefined ? { pid: h.entry.pid } : {}),
      })
    }
    return facts
  }

  /** Roster snapshot in wire shape for the `list` op; long-lived rows also
   *  get their model/effort/respawns/contextPct telemetry. */
  list(): WireRosterEntry[] {
    return Array.from(this.handles.values()).map(h => {
      const e: WireRosterEntry = { ...h.entry }
      if (h.longLived) {
        // What the board shows must be what is actually dispatching: the
        // RUNNING child's model/effort fill the main cells, and a retarget
        // that has not landed yet shows up only as pendingModel/pendingEffort
        // — the "applies at turn end" annotation.
        const wire = deriveWireSpec({
          running: h.longLived.running,
          spec: { model: h.longLived.spec.model, effort: h.longLived.spec.effort },
          pendingReconfigure: h.longLived.pendingReconfigure,
          reconfiguring: h.longLived.reconfiguring,
        })
        e.model = wire.model
        e.effort = wire.effort
        if (wire.pendingModel !== undefined) e.pendingModel = wire.pendingModel
        if (wire.pendingEffort !== undefined) e.pendingEffort = wire.pendingEffort
        e.respawns = h.longLived.respawns
        if (h.longLived.contextPct !== undefined) e.contextPct = h.longLived.contextPct
        // Outcome wins: a seat that settled (degraded, killed) must not
        // derive activity clocks. turnActive only clears on respawn, so
        // skipping this guard would paint a seat that died mid-turn as
        // 'busy' until the turn cap expired — on a child that no longer
        // exists.
        if (!h.entry.outcome) {
          e.busy = !this.seatIsIdle(h.longLived)
          // The raw turn fact beside the capped decision: a verb that must
          // not land mid-turn (the model switch) reads this one.
          if (h.longLived.turnActive !== undefined) e.turnActive = h.longLived.turnActive
          // Time-on-turn (busy with a known start only): the signal that
          // separates a long task from a stalled one. Pure derivation from
          // the clock the turn cap already maintains.
          if (e.busy && h.longLived.turnStartedAt !== undefined) {
            e.turnElapsedMs = Math.max(0, Date.now() - h.longLived.turnStartedAt)
          }
        }
      }
      return e
    })
  }

  /** Liveness triple for the `has` op. */
  has(short: string): { alive: boolean; present: boolean; ready: boolean } {
    const h = this.handles.get(short)
    if (!h) return { alive: false, present: false, ready: false }
    const alive = !h.entry.outcome
    return { alive, present: true, ready: h.entry.state === 'running' }
  }

  /**
   * Deliver a reply to a worker. Long-lived seats accept it as a
   * newline-terminated user frame on stdin — genuinely bidirectional. A
   * headless `-p` child has no interactive stdin at all, so for one this
   * returns false and the server answers ENOREPLY; pretending a reply was
   * accepted is never an option.
   */
  async reply(short: string, text: string): Promise<boolean> {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome) return false
    if (h.longLived && h.child?.stdin?.writable) {
      try {
        h.child.stdin.write(normalizeStreamJsonFrame(text))
        // A turn opens here and stays open until the child's stream-json
        // `result` arrives (the drain closes it) — back-pressure therefore
        // holds for the full duration of the task, whatever that turns out
        // to be.
        h.longLived.turnActive = true
        h.longLived.turnStartedAt = Date.now()
        // Session workers persist the delivery moment durably: the board's
        // working vs ready-to-review split is computed from the record.
        if (short.startsWith('concourse-w')) {
          void import('./concourseSupervisor.js')
            .then(sup => sup.markConcourseWorkerDelivery(short))
            .catch(() => {})
        }
        return true
      } catch (e) {
        logForDebugging(`[daemon] reply(${short}) stdin write failed: ${e}`)
        return false
      }
    }
    // One-shot headless runs cannot take input — there is nothing to write to.
    return false
  }

  /**
   * Write a CONTROL frame to a long-lived seat's stdin (how an attached
   * surface interrupts the current turn). Distinct from reply() on purpose:
   * a control frame opens no turn. Flagging turnActive on an interrupt would
   * poison the busy signal precisely when an operator is intervening.
   */
  control(short: string, frame: string): boolean {
    const h = this.handles.get(short)
    if (!h || h.entry.outcome) return false
    if (h.longLived && h.child?.stdin?.writable) {
      try {
        h.child.stdin.write(normalizeStreamJsonFrame(frame))
        return true
      } catch (e) {
        logForDebugging(`[daemon] control(${short}) stdin write failed: ${e}`)
        return false
      }
    }
    return false
  }

  /**
   * Kill a worker: SIGTERM (or the caller's signal) to the child when one
   * exists, and the entry is marked killed. Unknown short id ⇒ false. On an
   * entry that already settled, kill degenerates to reaping the handle.
   */
  kill(short: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const h = this.handles.get(short)
    if (!h) return false
    // Killing a seat through the roster is by definition INTENTIONAL — the
    // crash supervisor stands down (a crash from outside still respawns).
    if (h.longLived) {
      h.longLived.intentionalStop = true
      if (h.longLived.respawnTimer) clearTimeout(h.longLived.respawnTimer)
    }
    if (h.entry.outcome) {
      this.handles.delete(short)
      return true
    }
    h.entry.state = 'retiring'
    try {
      // The WHOLE TREE (FN-015 rank 11): a seat's own children — a build, a
      // test run, a dev server, an MCP stdio server — outlived a root-only
      // kill with no owner at all. killProcessGroup is the fire-and-forget
      // door onto the estate's one cross-platform tree owner.
      if (h.child) killProcessGroup(h.child, signal)
    } catch (e) {
      logForDebugging(`[daemon] kill(${short}) error: ${e}`)
    }
    return true
  }

  /** Drop settled rows past a recent tail. Invoked from dispatch() at every
   *  settle, which is what stops a long-running daemon from holding one
   *  handle — and one full prompt string — per run, forever. The kept tail
   *  gives status/boards a little history; live seats never carry an outcome
   *  and so are structurally out of reach. */
  reapSettled(keepRecent = 0): void {
    if (keepRecent > 0) {
      const settled = [...this.handles.entries()].filter(([, h]) => h.entry.outcome)
      if (settled.length <= keepRecent) return
      settled.sort((a, b) => (a[1].entry.startedAt ?? 0) - (b[1].entry.startedAt ?? 0))
      for (const [short] of settled.slice(0, settled.length - keepRecent)) {
        this.handles.delete(short)
      }
      return
    }
    for (const [short, h] of this.handles) {
      if (h.entry.outcome) this.handles.delete(short)
    }
  }

  /**
   * Register, launch, and supervise a LONG-LIVED stream-json seat. Compared
   * with dispatch(), this path
   *   - launches via spawnStreamJsonChild (writable stdin, no kill timer),
   *   - relaunches after an EXTERNAL crash with capped exponential backoff,
   *   - never feeds the shared per-fire breaker (its crash loop must not
   *     brake the cron path), and
   *   - raises the sticky `degraded` flag + onDegraded once the respawn
   *     budget is absent.
   * Yields the first pid, or ok:false when a live worker already owns the id.
   */
  registerLongLived(
    short: string,
    spec: StreamJsonChildSpec,
    opts?: Partial<LongLivedSupervisorConfig>,
  ): { ok: boolean; pid?: number; error?: string } {
    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, error: 'a live worker already holds this id' }
    }
    const ll: LongLivedSeat = {
      spec,
      cfg: { ...DEFAULT_LONG_LIVED_CONFIG, ...opts },
      respawns: 0,
      lifetimeCrashes: 0,
      lastSpawnAt: 0,
      intentionalStop: false,
      spawnGeneration: 0,
    }
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: `[long-lived ${spec.role}]`,
      source: 'dispatch',
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
      via: 'stream-json',
    }
    this.handles.set(short, { entry, done: Promise.resolve(), longLived: ll })
    const pid = this.spawnLongLived(short)
    // A synchronous spawn failure must not leave this handle stranded at
    // 'spawning' with no outcome: heartbeats would repaint an honest
    // dead-seat row as forever-spawning, and any re-registration would bounce
    // off 'a live worker already holds this id'. No child ⇒ no handle.
    if (pid === undefined) {
      // Stand the supervisor down BEFORE deleting the handle — the failed
      // attempt may have armed a respawn timer against this generation, and
      // intentionalStop neuters it, so no zombie respawn can race a future
      // fresh registration.
      ll.intentionalStop = true
      this.handles.delete(short)
      return { ok: false, error: 'spawn failed (no pid)' }
    }
    return { ok: true, pid }
  }

  /**
   * Width of the delivery-clock idle window, in ms. Mailbox replies are
   * invisible to the daemon, so before any turn boundary exists, "idle" is
   * an honest approximation over delivery activity. MERCURY_IMPLEMENTER_IDLE_MS
   * tunes it (the knob keeps its historical spelling; it applies to every
   * long-lived seat); 15s otherwise.
   */
  private idleWindowMs(): number {
    const n = Number(flagEnv('MERCURY_IMPLEMENTER_IDLE_MS'))
    return Number.isFinite(n) && n > 0 ? n : 15_000
  }

  /** May this seat be bounced / handed its next dispatch right now? Exact
   *  where possible: the moment the turn's `result` frame lands the seat is
   *  idle — no post-delivery waiting period — so a retarget or clear never
   *  cuts a child down mid-task. With no turn boundary observed yet, the
   *  delivery clock decides; the turn cap frees a seat whose turn wedged. */
  private seatIsIdle(ll: LongLivedSeat): boolean {
    return !decideWorkerBusy({
      turnActive: ll.turnActive,
      turnStartedAt: ll.turnStartedAt,
      now: Date.now(),
      lastDeliveredAt: ll.lastDeliveredAt,
      idleMs: this.idleWindowMs(),
      maxTurnMs: getMaxTurnMs(flagEnv('MERCURY_IMPLEMENTER_MAX_TURN_MS')),
    }).busy
  }

  /** Public busy probe for dispatch back-pressure. Busy spans the entire
   *  turn, delivery through `result` frame — a task that outlives the idle
   *  window can never be mistaken for idle and handed a second task
   *  mid-flight. Unknown or non-long-lived ids read as not busy. */
  isWorkerBusy(short: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    return !this.seatIsIdle(h.longLived)
  }

  /** Seat's present effort floor (live spec) — routing consults it before
   *  deciding a retarget is worth a bounce. Unknown ⇒ undefined. */
  currentLongLivedEffort(short: string): string | undefined {
    return this.handles.get(short)?.longLived?.spec.effort
  }

  /** Seat's present model (live spec) — the routing seam's comparison input.
   *  Unknown ⇒ undefined. */
  currentLongLivedModel(short: string): string | undefined {
    return this.handles.get(short)?.longLived?.spec.model
  }

  /** Seat's monotonic spawn generation (input to the stale-settle fence).
   *  Unknown or non-long-lived ⇒ undefined. */
  currentLongLivedGeneration(short: string): number | undefined {
    return this.handles.get(short)?.longLived?.spawnGeneration
  }

  /** Was this request id already delivered to `short`? Unknown or
   *  non-long-lived ⇒ false. */
  hasSeenDispatch(short: string, requestId: string): boolean {
    return this.handles.get(short)?.longLived?.seenDispatchIds?.has(requestId) ?? false
  }

  /** Daemon-owned auto-clear: when `short`'s fill has reached the regulation
   *  threshold AND the seat is idle (a genuine turn boundary — never in the
   *  middle of output), bounce it onto a fresh transcript before it chokes.
   *  True ⇒ a clear fired. The respawn wipes contextPct, so re-firing waits
   *  until the new child climbs back to the threshold — thrash-proof by
   *  construction. Whether to CALL this at all is the daemon's own gate. */
  autoClearIfContextFull(short: string): boolean {
    const ll = this.handles.get(short)?.longLived
    if (!ll) return false
    // Once per fill: between the async note write and the respawn's
    // telemetry reset, the threshold test still passes — and this governor
    // has multiple callers. The latch is what stops call #2 in that gap from
    // duplicating the note and the respawn.
    if (ll.clearInFlight) return false
    if (!this.seatIsIdle(ll)) return false
    if ((ll.contextPct ?? 0) < AUTO_CLEAR_CONTEXT_PCT) return false
    ll.clearInFlight = true
    logForDebugging(
      `[daemon] auto-clear: ${short} ctx ${ll.contextPct}% >= ${AUTO_CLEAR_CONTEXT_PCT}% + idle — respawning (fresh transcript)`,
    )
    // Continuity handoff: one note goes into the worker's inbox BEFORE the
    // bounce. The fresh child drains it as its first input (the mailbox
    // replays at-least-once, so no respawn race can lose it) and the same
    // line appears in the room — the operator watches the continuity happen
    // rather than inferring a silent reset. Awaited for ordering; a write
    // failure still clears, only noteless.
    //
    // The handoff follows the carry-forward flag (`=0` opts out). The note
    // goes to the seat's OWN team inbox — pinning a team name here would
    // misfile a seat's note into an inbox nothing drains.
    const team = ll.spec.teamName ?? 'default'
    if (carryForwardEnabled()) {
      const note = buildCarryForwardNote(ll.contextPct, lastSeenDispatchId(ll.seenDispatchIds))
      void writeToMailbox(
        short,
        { from: 'daemon', text: JSON.stringify(note), timestamp: new Date().toISOString() },
        team,
      )
        .catch(() => {})
        // Bounce only after the note is durably queued; this method's
        // boolean was already decided, so staying sync is fine.
        .finally(() => this.reconfigureLongLived(short, {}))
      return true
    }
    this.reconfigureLongLived(short, {}) // identical bounce-if-idle path a manual clear takes
    return true
  }

  /** Note a request id as delivered to `short` (bounded set, oldest out first). */
  markSeenDispatch(short: string, requestId: string): void {
    const ll = this.handles.get(short)?.longLived
    if (!ll) return
    const set = (ll.seenDispatchIds ??= new Set<string>())
    set.add(requestId)
    if (set.size > DELIVERED_ID_CAP) {
      // Insertion order is iteration order for a Set — shed the oldest few.
      const overflow = set.size - DELIVERED_ID_CAP
      let i = 0
      for (const v of set) {
        if (i++ >= overflow) break
        set.delete(v)
      }
    }
  }

  /** Bounce the live child so its exit handler relaunches on the patched
   *  spec; a seat that already settled (degraded/killed) is revived directly. */
  private respawnForReconfigure(short: string): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    if (h.entry.outcome) {
      // Nothing alive to bounce — launch fresh on the patched spec.
      this.spawnLongLived(short)
      return
    }
    if (h.longLived.respawnTimer) {
      // A relaunch is already pending — i.e. the child has ALREADY exited
      // and there is no process to SIGTERM. Signalling a dead child is a
      // silent false, not a throw, so the catch below would leave
      // `reconfiguring` stuck true and freeze the seat. Since the pending
      // relaunch reads ll.spec when it fires, the patch is already on board:
      // let it fire. (The timer is truthy only while genuinely scheduled;
      // a live recovered child has cleared it, so no real retarget is ever
      // skipped here.)
      return
    }
    h.longLived.reconfiguring = true
    try {
      h.child?.kill('SIGTERM')
    } catch (e) {
      logForDebugging(`[daemon] reconfigure(${short}) kill failed: ${e}`)
      h.longLived.reconfiguring = false
    }
  }

  /**
   * Swap a seat's model/effort in place. The patch merges into ll.spec
   * (model/effort only — persona material rides the child's role env), then
   * lands as bounce-now-or-queue:
   *   - idle ⇒ bounce immediately (reconfiguring set, SIGTERM, instant
   *     relaunch that skips the ceiling).
   *   - busy ⇒ park it (pendingReconfigure); the first idle observation
   *     applies it.
   * ok:false when `short` is not a long-lived seat (→ ENOJOB at the server).
   */
  reconfigureLongLived(
    short: string,
    patch: { model?: string; effort?: string },
  ): { ok: boolean; respawned: boolean; pending: boolean; error?: string; note?: string } {
    const h = this.handles.get(short)
    if (!h?.longLived) {
      return { ok: false, respawned: false, pending: false, error: 'unknown long-lived worker' }
    }
    const ll = h.longLived
    // Validation fails CLOSED: a junk or disallowed value collapses to the
    // seat's current one (that field of the patch becomes a no-op) and the
    // reason travels back on `note`. This is the courteous tier — the spawn
    // seam applies its own hard floor underneath.
    const notes: string[] = []
    const prevModel = ll.spec.model
    const prevEffort = ll.spec.effort
    const next = { ...ll.spec }
    if (patch.model) {
      const v = validateSeatModel(patch.model, prevModel)
      next.model = v.model
      if (v.note) notes.push(v.note)
    }
    if (patch.effort) {
      const v = validateSeatEffort(patch.effort, prevEffort as EffortValue)
      next.effort = String(v.effort)
      if (v.note) notes.push(v.note)
    }
    ll.spec = next
    const note = notes.length ? notes.join(' · ') : undefined
    // Wholly-refused patch ⇒ no bounce at all, honestly reported. (A clean
    // patch to the same values DOES still bounce — retargeting doubles as
    // an intentional restart.)
    if (note && next.model === prevModel && next.effort === prevEffort) {
      logForDebugging(`[daemon] reconfigure(${short}) refused: ${note}`)
      return { ok: true, respawned: false, pending: false, note }
    }
    // Bounce-vs-park is decided by the turn-aware idle check, never the raw
    // delivery clock — the clock would greenlight a SIGTERM mid-task on any
    // turn longer than its window, destroying the in-progress result. The
    // parked-patch drain applies the same check, so both share one meaning
    // of idle.
    if (this.seatIsIdle(ll)) {
      this.respawnForReconfigure(short)
      return { ok: true, respawned: true, pending: false, note }
    }
    ll.pendingReconfigure = true
    logForDebugging(`[daemon] reconfigure(${short}) queued — worker busy, will apply when idle`)
    return { ok: true, respawned: false, pending: true, note }
  }

  /**
   * Patch a seat's spec model WITHOUT a bounce: the live child already
   * switched through its own control channel (the session seat's model
   * verb), so the spec — what the next respawn launches with — follows it.
   * The running snapshot follows too, so the wire never reports a
   * retarget it does not owe. Unknown / non-long-lived ids ⇒ false.
   */
  patchSeatModel(short: string, model: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    h.longLived.spec = { ...h.longLived.spec, model }
    if (h.longLived.running) h.longLived.running = { ...h.longLived.running, model }
    return true
  }

  /** The effort sibling of patchSeatModel — same no-bounce contract: the
   *  live child already switched through its own set_effort control, so the
   *  spec (and the running snapshot the wire reports) follow it. */
  patchSeatEffort(short: string, effort: string): boolean {
    const h = this.handles.get(short)
    if (!h?.longLived) return false
    h.longLived.spec = { ...h.longLived.spec, effort }
    if (h.longLived.running) h.longLived.running = { ...h.longLived.running, effort }
    return true
  }

  /**
   * Claim-time spec patch for a WARM seat (the warm-runner pool): the live
   * child already took the session's model, posture and effort through its
   * own claim control, so the spec — what the next respawn launches with —
   * follows it, and the respawn argv flips from the identityless warm shape
   * to `--resume <id>` (the claimed session continues, never a fresh warm
   * boot). Returns the patched spec for the admission record's log hook;
   * unknown / non-long-lived ids ⇒ null.
   */
  patchSeatClaim(
    short: string,
    patch: { model: string; effort: string; respawnExtraArgv: readonly string[] },
  ): StreamJsonChildSpec | null {
    const h = this.handles.get(short)
    if (!h?.longLived) return null
    h.longLived.spec = {
      ...h.longLived.spec,
      model: patch.model,
      effort: patch.effort,
      respawnExtraArgv: [...patch.respawnExtraArgv],
    }
    if (h.longLived.running) h.longLived.running = { model: patch.model, effort: patch.effort }
    return h.longLived.spec
  }

  /**
   * Post-drain hook from the daemon's dispatch loop for one seat: records
   * delivery (feeding the idle approximation) and lands any parked retarget
   * the moment the seat shows idle. Unknown / non-long-lived ids no-op.
   */
  onDispatchTick(short: string, delivered: number): void {
    const h = this.handles.get(short)
    if (!h?.longLived) return
    const ll = h.longLived
    if (delivered > 0) ll.lastDeliveredAt = Date.now()
    this.applyQueuedRetargetIfIdle(short, ll)
  }

  private applyQueuedRetargetIfIdle(short: string, ll: LongLivedSeat): void {
    if (ll.pendingReconfigure && this.seatIsIdle(ll)) {
      ll.pendingReconfigure = false
      logForDebugging(`[daemon] reconfigure(${short}) applying queued retarget — worker now idle`)
      this.respawnForReconfigure(short)
    }
  }

  /** The busy→idle edge: land parked retargets, then tell the daemon's
   *  onIdle hook. Exceptions stop here. */
  private noteWorkerIdle(short: string): void {
    const ll = this.handles.get(short)?.longLived
    if (ll) this.applyQueuedRetargetIfIdle(short, ll)
    try {
      this.opts.onIdle?.(short)
    } catch (e) {
      logForDebugging(`[daemon] onIdle(${short}) hook threw (ignored): ${e}`)
    }
  }

  /** Launch (or relaunch) the child for `short` and wire its supervision. */
  private spawnLongLived(short: string): number | undefined {
    const h = this.handles.get(short)
    if (!h || !h.longLived) return undefined
    const ll = h.longLived
    // The timer that brought us here has fired — null it so `respawnTimer`
    // keeps meaning "a relaunch is still owed"; left truthy, it would make
    // respawnForReconfigure skip a real retarget against the now-live child.
    // clearTimeout on a fired timer does nothing; the assignment is the part
    // that matters.
    if (ll.respawnTimer) {
      clearTimeout(ll.respawnTimer)
      ll.respawnTimer = undefined
    }
    // A seat whose cwd is absent DEGRADES loudly instead of looping: every
    // relaunch would die on the same missing directory, backoff or not. No
    // child is created, so nothing re-arms the cycle.
    const cwdGate = assertSpawnCwd(ll.spec.cwd)
    if (!cwdGate.ok) {
      logForDebugging(`[daemon] long-lived ${short} REFUSED — ${cwdGate.reason}`)
      h.entry.outcome = 'degraded'
      this.degradedState = { degraded: true, reason: `${short}: ${cwdGate.reason}` }
      recordSpawn({
        kind: 'long-lived-refused',
        id: ll.spec.agentId,
        cwd: ll.spec.cwd ?? '',
        reason: cwdGate.reason,
        role: ll.spec.role,
      })
      return undefined
    }
    let spawned: { child: ChildProcess }
    try {
      // spawnGeneration is consulted before its increment: 0 means this
      // registration's very first launch, anything higher a relaunch — the
      // spec's respawnExtraArgv (fresh-session flag vs resume flag) branches
      // on exactly that.
      spawned = spawnStreamJsonChild(ll.spec, { respawn: ll.spawnGeneration > 0 })
    } catch (e) {
      logForDebugging(`[daemon] long-lived spawn failed for ${short}: ${e}`)
      return undefined
    }
    const child = spawned.child
    h.child = child
    h.entry.pid = child.pid
    // Liveness consumers read the pid off the durable session record. If a
    // relaunch updated only this in-memory row, the record would keep naming
    // the dead pid and every reader would call the live session dead. Same
    // fire-and-forget pattern as the delivery stamp.
    if (short.startsWith('concourse-w') && typeof child.pid === 'number') {
      const livePid = child.pid
      void import('./concourseSupervisor.js')
        .then(sup => sup.markConcourseWorkerRespawn(short, livePid))
        .catch(() => {})
    }
    h.entry.state = 'running'
    h.entry.outcome = undefined // a relaunch makes the row live again
    ll.lastSpawnAt = Date.now()
    ll.spawnGeneration += 1 // climbs only — the stale-settle fence depends on it
    // Capture launch truth: list() reports what this child actually runs,
    // and any later spec patch shows as pending rather than as fact.
    ll.running = { model: ll.spec.model, effort: ll.spec.effort }
    // A new child has no open turn. Without this reset, dying mid-turn would
    // strand turnActive=true on the successor and every following dispatch
    // would be held against a turn that does not exist.
    ll.turnActive = false
    ll.turnStartedAt = undefined
    // The old fill % and delivery clock describe a transcript that is absent.
    // Clearing them keeps the boards from showing the pre-clear ~85-100%
    // fill against the new child until its first usage frame — "did the
    // clear work" has to be answerable truthfully.
    ll.contextPct = undefined
    ll.lastDeliveredAt = undefined
    // New fill cycle ⇒ the auto-clear governor re-arms.
    ll.clearInFlight = false

    this.drainChildStdout(short, child, ll)
    this.superviseChildLife(short, h, ll, child)
    // A brand-new child is idle: fire the edge so a held dispatch reaches it
    // immediately instead of at the next event. (On first registration the
    // daemon's hook is not wired yet — the drain's own first pass covers
    // that window.)
    this.noteWorkerIdle(short)
    return child.pid
  }

  /**
   * Consume (and mine) the child's stdout. The pipe MUST be drained: left
   * unread, the ~64KB kernel buffer fills with stream-json events and the
   * child blocks inside a write — alive by every pid probe, doing nothing.
   * Replies travel over the mailbox rather than stdout, so consuming the
   * pipe suffices; since we are reading anyway, each newline-framed line is
   * mined for:
   *   - usage frames → live context-fill telemetry,
   *   - is_error result text → crash-loop evidence,
   *   - control_request frames → the permission-ask hook,
   *   - the `result` frame → the exact turn-end edge.
   */
  private drainChildStdout(short: string, child: ChildProcess, ll: LongLivedSeat): void {
    let firstChunkSeen = false
    let tail = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!firstChunkSeen) {
        firstChunkSeen = true
        logForDebugging(
          `[daemon] long-lived ${short} stdout flowing (first chunk ${chunk.length}b) — pipe drained`,
        )
      }
      tail += chunk.toString('utf8')
      let nl: number
      while ((nl = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, nl)
        tail = tail.slice(nl + 1)
        // ONE parse per line: every classifier below reads this frame (the
        // same line was parsed three times — usage, error, result — before).
        const frame = parseStreamJsonFrame(line)
        const usage = usageOfStreamJsonFrame(frame)
        if (usage) {
          const pct = calculateContextPercentages(
            usage,
            getContextWindowForModel(ll.spec.model),
          ).used
          if (pct !== null) ll.contextPct = pct
        }
        // The is_error text is what lets a storm note say WHY — a crash loop
        // with no captured error reads as anonymous noise.
        const errText = errorTextOfParsedResultFrame(frame)
        if (errText) ll.lastErrorText = errText
        // Permission asks may not disappear into the drain: forward each
        // control_request to the ask owner; a torn or foreign line parsed to
        // null above and is skipped. The handler stays guarded — its throw
        // must not take the drain down (the old shape swallowed it too).
        if (this.opts.onControlRequest && frame !== null && frame.type === 'control_request') {
          try {
            this.opts.onControlRequest(short, frame)
          } catch {
            /* the ask owner's failure never breaks the result handling below */
          }
        }
        if (this.opts.onChildLine) {
          try {
            this.opts.onChildLine(short, line)
          } catch (e) {
            logForDebugging(`[daemon] onChildLine(${short}) hook threw (ignored): ${e}`)
          }
        }
        if (isTurnResultParsedFrame(frame)) {
          // The `result` frame closes the turn: back-pressure releases the
          // very moment the task ends — never early, never on a delay.
          ll.turnActive = false
          ll.turnStartedAt = undefined
          // Turn settlement is a durable record fact: a live session worker
          // whose latest turn settled paints as ready-to-review.
          if (short.startsWith('concourse-w')) {
            void import('./concourseSupervisor.js')
              .then(sup => sup.markConcourseWorkerTurnSettled(short))
              .catch(() => {})
          }
          // Idle edge: parked retargets land and a held dispatch goes out
          // now, not at the next poll.
          this.noteWorkerIdle(short)
        }
      }
      // If no newline ever comes, cap the buffer and keep only its tail.
      if (tail.length > 1_000_000) tail = tail.slice(-100_000)
    })
  }

  /**
   * Wire end-of-life supervision for the child. 'exit' (process ended) and
   * 'error' (spawn failure, or async runtime errors like ENOENT/EACCES) feed
   * ONE shared path: node emits 'error' with no 'exit' after it for spawn
   * failures, so an exit-only handler would never relaunch an ENOENT — and,
   * absent any uncaughtException handler, the error would take the
   * supervisor down with it. A per-life latch collapses an error+exit pair
   * into a single crash.
   */
  private superviseChildLife(
    short: string,
    h: WorkerHandle,
    ll: LongLivedSeat,
    child: ChildProcess,
  ): void {
    let lifeSettled = false
    const handleCrash = (code: number | null, signal: NodeJS.Signals | null) => {
      if (lifeSettled) return
      lifeSettled = true
      // Dying mid-turn means no result frame ever came, leaving the
      // delivery stamp with nothing to close it — the board would show
      // 'working' forever against the relaunched child. Any end-of-life
      // with a turn still open settles the record; the turn did not survive
      // the child, it merely failed to settle cleanly.
      if (ll.turnActive && short.startsWith('concourse-w')) {
        void import('./concourseSupervisor.js')
          .then(sup => sup.markConcourseWorkerTurnSettled(short))
          .catch(() => {})
      }
      // Each observed child-life end writes an exit row — deaths become
      // ledger lookups instead of process archaeology.
      const ledgerExit = (outcome: string, reason?: string): void =>
        recordSpawnExit({
          kind: 'long-lived',
          event: 'exit',
          id: ll.spec.agentId,
          pid: h.entry.pid,
          code,
          signal,
          outcome,
          ...(reason ? { reason } : {}),
        })
      if (ll.intentionalStop) {
        h.entry.state = 'settled'
        h.entry.outcome = 'killed'
        ledgerExit('killed')
        return
      }
      // Deliberate retarget bounce — not a crash. Relaunch at once on the
      // patched spec and book nothing against the ceiling: an operator
      // asking for a retarget must never spend crash budget. Drop the flag.
      if (ll.reconfiguring) {
        ll.reconfiguring = false
        logForDebugging(
          `[daemon] long-lived ${short} reconfiguring → immediate respawn (${ll.spec.model}@${ll.spec.effort}, no ceiling increment)`,
        )
        ledgerExit('reconfigure-respawn')
        h.entry.state = 'spawning'
        ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), 0)
        ll.respawnTimer.unref?.()
        return
      }
      // Genuine crash. The shared per-fire breaker is deliberately NOT fed:
      // seat respawns have their own budget, and a looping seat must never
      // pull the brake on scheduled fires.
      //
      // Healthy uptime rewinds the loop counter, making `respawns` measure
      // the CURRENT loop. The bar sits minutes high — well above the
      // backoff cap — because a bar at the cap would let a child that
      // survives one beat past it reset forever without ever degrading (the
      // slow crash-loop). lifetimeCrashes never rewinds and catches exactly
      // that chronic case.
      if (
        Date.now() - ll.lastSpawnAt >
        (ll.cfg.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS)
      ) {
        ll.respawns = 0
        // The loop this evidence and this notification belonged to is over.
        ll.stormNotified = false
        ll.lastErrorText = undefined
      }
      ll.respawns++
      ll.lifetimeCrashes++
      const decision = decideRespawn(ll.respawns, ll.cfg, ll.lifetimeCrashes)
      logForDebugging(
        `[daemon] long-lived ${short} crashed (code=${code} sig=${signal}); ${decision.action} (${ll.respawns}/${ll.cfg.maxRespawns})`,
      )
      // Storm visibility: a child rejected for a PERMANENT reason
      // (auth/backend/model) can otherwise loop in silence — respawn rows
      // pile up in the ledger while the room hears nothing. So: one loud
      // line when the loop takes shape (second fast crash), one at degrade,
      // both naming spec + exit + the last captured error.
      const composeStormNote = (phase: 'forming' | 'degraded'): string =>
        `⚠ ${short} ${phase === 'degraded' ? 'DEGRADED — respawn ceiling hit' : 'respawn loop forming'}: ` +
        `${ll.respawns} fast exit(s) on ${ll.spec.model}@${ll.spec.effort} (exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}). ` +
        (ll.lastErrorText ? `Last error: ${ll.lastErrorText}` : 'No output before exit.') +
        (phase === 'degraded'
          ? ' No further respawns — fix the cause, then re-engage.'
          : ' Still retrying with backoff.')
      const postStormNote = (phase: 'forming' | 'degraded'): void => {
        void writeToMailbox(
          'team-lead',
          { from: 'daemon', text: composeStormNote(phase), timestamp: new Date().toISOString() },
          ll.spec.teamName ?? 'default',
        ).catch(() => {})
      }
      // The session-end visibility law: a concourse worker's crash is a
      // DURABLE record fact the board paints (NEEDS YOU + the reason line) —
      // never a silent respawn that reads as finished. Stamped on BOTH arms
      // (still-respawning and degraded); the operator's own next act on the
      // session clears it.
      const stampCrash = (respawning: boolean, detail?: string): void => {
        if (!short.startsWith('concourse-w')) return
        const exitWords = `exit ${code ?? 'none'}${signal ? ` · signal ${signal}` : ''}`
        const reason =
          detail ??
          `crashed mid-run (${exitWords})${ll.lastErrorText ? ` — ${ll.lastErrorText}` : ''}${respawning ? ' · resumed — the interrupted ask needs a re-send' : ''}`
        void import('./concourseSupervisor.js')
          .then(sup => sup.markConcourseWorkerCrash(short, { reason, respawning }))
          .catch(() => {})
      }
      if (decision.action === 'degrade') {
        this.degradedState = { degraded: true, reason: `${short}: ${decision.reason}` }
        h.entry.state = 'crashed'
        h.entry.outcome = 'degraded'
        ledgerExit('degraded', decision.reason)
        stampCrash(false, `crashed — respawns exhausted (${decision.reason})`)
        logForDebugging(`[daemon] ⚠️  DEGRADED — ${this.degradedState.reason}`)
        postStormNote('degraded')
        try {
          this.opts.onDegraded?.(this.degradedState.reason, short)
        } catch {
          /* best-effort */
        }
        return
      }
      if (ll.respawns === 2 && !ll.stormNotified) {
        ll.stormNotified = true
        postStormNote('forming')
      }
      ledgerExit('crash-respawn')
      stampCrash(true)
      h.entry.state = 'spawning'
      ll.respawnTimer = setTimeout(() => this.spawnLongLived(short), decision.delayMs)
      ll.respawnTimer.unref?.()
    }
    child.on('exit', (code, signal) => handleCrash(code, signal))
    child.on('error', e => {
      logForDebugging(`[daemon] long-lived ${short} spawn/runtime error: ${e}`)
      handleCrash(null, null)
    })
  }

  /**
   * Run one dispatch. Live-id dedup (EALIVE), then the breaker (OPEN ⇒
   * refuse) and the in-flight ceiling. Execution goes to a usable LOCAL
   * backend when one exists, otherwise the isolated headless child. The
   * returned promise resolves at admit+spawn — the run keeps going in the
   * background and reports to the breaker when it settles.
   */
  async dispatch(d: DispatchBody): Promise<DispatchOutcome> {
    const short = d.short || `w-${randomUUID().slice(0, 8)}`

    // A live worker under this id ⇒ the dispatch is a duplicate.
    const existing = this.handles.get(short)
    if (existing && !existing.entry.outcome) {
      return { ok: false, short, code: 'EALIVE', error: 'a live worker already holds this id' }
    }

    // Refusal-only gates: breaker, then the concurrency ceiling.
    if (this.opts.breaker.shouldSuppressFire()) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: 'circuit-breaker OPEN — dispatch suppressed (cooling down)',
      }
    }
    if (this.inFlight >= this.opts.maxInflight) {
      return {
        ok: false,
        short,
        code: 'ENOCONN',
        error: `at max in-flight (${this.opts.maxInflight}) — retry shortly`,
      }
    }

    const cwd = d.cwd || this.opts.dir
    const source: DispatchSource = d.source ?? 'dispatch'
    const entry: RosterEntry = {
      short,
      sessionId: randomUUID(),
      prompt: d.prompt,
      source,
      state: 'spawning',
      startedAt: Date.now(),
      cliVersion: currentVersion(),
    }

    // Pick the route. The registry is asked whether a teammate backend is
    // truly usable; a bare daemon has no live teammate context, so the
    // answer falls back to the headless child — the path that has always
    // actually carried this work.
    const via = await this.resolveVia()
    entry.via = via

    this.inFlight++
    let settleChild: ChildProcess | undefined
    // Named workflow ⇒ its deterministic slash form; free text passes as-is.
    const headlessPrompt = buildHeadlessPrompt({
      prompt: d.prompt,
      workflow: d.workflow,
    })
    // The read-only recon allowlist rides every daemon worker — the
    // permission floor that no classifier fault can take away.
    const run = runTaskHeadless(
      { id: short, prompt: headlessPrompt, allowedTools: resolveWorkerReconAllow() },
      cwd,
      child => {
        settleChild = child
        entry.pid = child.pid
        entry.state = 'running'
      },
    )
      .then(res => {
        const failed = DaemonBreaker.isFailureExit(res.code)
        entry.outcome = res.code === null ? 'killed' : failed ? 'failed' : 'ok'
        entry.state = failed ? (res.code === null ? 'retiring' : 'crashed') : 'settled'
        // Settles feed the SHARED breaker — dispatch failures and cron
        // failures pull on one brake. A wall-clock timeout is a long task,
        // not a crash: with the opt-in carve-out armed
        // (timeoutIsFleetFailure() === false) it feeds only the window-rate
        // path (recordTimeout) and never the consecutive counter. Unarmed,
        // it stays a hard failure via recordResult(false).
        if (res.timedOut === true && !DaemonBreaker.timeoutIsFleetFailure()) {
          this.opts.breaker.recordTimeout()
        } else {
          this.opts.breaker.recordResult(!failed)
        }
      })
      .catch(e => {
        logForDebugging(`[daemon] dispatch ${short} run error: ${e}`)
        entry.outcome = 'crashed'
        entry.state = 'crashed'
        this.opts.breaker.recordResult(false)
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1)
        // Trim the settled tail at every settle — enough history for the
        // boards, no per-run prompt pinned for the daemon's lifetime.
        this.reapSettled(32)
      })

    // The runner surrenders the child synchronously (onChild runs before its
    // first await), so on a successful spawn settleChild is populated here.
    this.handles.set(short, { entry, child: settleChild, done: run })

    logForDebugging(`[daemon] dispatched ${short} via ${via} (source=${source})`)
    return { ok: true, short, pid: entry.pid, via }
  }

  /**
   * Determine the route a dispatch would take. The local backend registry is
   * probed (imported, never modified); even with an in-process backend
   * enabled, actually driving it needs a teammate context a bare daemon does
   * not have — so execution is headless either way. Probing anyway keeps
   * this seam warm: should the daemon ever gain a teammate context, the
   * executor is already reachable from here with zero protocol change.
   */
  private async resolveVia(): Promise<string> {
    try {
      if (isInProcessEnabled()) {
        await getTeammateExecutor(true).catch(() => null)
        return 'headless'
      }
      await getTeammateExecutor(false).catch(() => null)
      return 'headless'
    } catch {
      return 'headless'
    }
  }
}
