// ============================================================================
//  buddyState — per-agent BuddyState (mood) derivation for critter surfaces.
//  LIVE: the DeckCompanion row derives
//  the MAIN session's mood from REPL-published signals (companionSignals.ts)
//  through buddyStateFor below; toCritterState (critterVariant.ts) maps the
//  result onto critterData's pose union. (The upstream src/buddy companion
//  pet this once name-collided with was deleted in the same merge.)
//
//  Maps ONE roster
//  agent — its task ownership / running-or-done status / event recency, plus
//  (main only) the active session's streaming + permission signals, plus the
//  shared bridge heartbeat — to exactly ONE of EIGHT frozen buddy moods that
//  drive the critter's animation + colour. PURE: a function of already-mirrored
//  data, no fetch, no side effect, render-cheap and trivially testable.
//
//  HONESTY CONSTRAINT (the primary source). Mercury's per-session status /
//  streaming / permission signals key on the SESSION (the MAIN agent), never on
//  a sub-agent id — sub-agents are tracked through the EVENT STREAM only (their
//  roster row + last-event recency). So:
//    - the MAIN agent reads the RICH signal (permission / streaming / live turn /
//      settle / fail / idle), and
//    - a SUB-agent reads a COARSE but honest working / idle / done / sleeping —
//      NEVER a fabricated `thinking` or `blocked`, because no per-sub-agent
//      thinking-or-permission signal exists. If a future signal keyed by
//      sub-agent id appears, this mapping extends; today it does not.
//
//  The eight moods + their priority match the frozen contract exactly:
//    MAIN : blocked > sad > thinking > focused/working > done > sleeping > idle
//    SUB  : done (stopped) / working (running+fresh) / sleeping (deep-quiet) /
//           idle (running+stale)
//
//  GHOST-LIVE FIX. A crashed bridge can leave a stale `live:true` status or a
//  half-written streaming row on disk, and a SubagentStop that never landed
//  leaves a sub-agent's last-event looking fresh. So the main path's streaming /
//  live branches AND the sub path's `working` branch are SUPPRESSED when the
//  shared heartbeat (`signals.bridgeLive`) is EXPLICITLY false — the same dead
//  bridge the rest of the rail reads as idle. `bridgeLive` undefined (legacy /
//  no-heartbeat callers) ⇒ NOT suppressed ⇒ byte-identical prior behavior.
//
//  ZERO deps. No React, no DOM, no I/O. Lives in the data layer so any surface
//  can import it; the `BuddyState` string union is handed straight to a critter
//  component's `state`/mood prop.
// ============================================================================

/** The eight buddy moods. A critter component maps each to an animation + hue. */
export type BuddyState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'focused'
  | 'blocked'
  | 'sad'
  | 'done'
  | 'sleeping'

/** Recency window for a sub-agent's last event. A sub-agent that is still alive
 *  (no stop event) but silent past this window reads as `idle` (quiet), not
 *  `working`. Same ~45s liveness threshold the roster uses for "fresh vs stale". */
export const BUDDY_FRESH_MS = 45_000

/** Sustained-work threshold: a live turn older than this reads as `focused`
 *  (heads-down) rather than just `working`. */
export const BUDDY_FOCUS_MS = 5 * 60 * 1000

/** Deep-idle threshold for SUB-agent rows: a quiet sub past this `sleeps`
 *  rather than idling. (The MAIN word no longer rides a timer — operator
 *  ruling: it derives from `signals.asleep`, the ONE critterSleep
 *  agent-activity verdict, so the mood word and the art can never disagree.) */
export const BUDDY_DEEP_IDLE_MS = 5 * 60 * 1000

/**
 * One roster agent, framework-agnostic. Mercury's live roster row is
 * `AgentHealth` (utils/swarm/roomHealth.ts) and the lower-level `AgentStatus`
 * (utils/tasks.ts); neither carries `isMain` / an event timestamp directly, so
 * this is the HONEST minimal shape the deriver needs. Use `buddyRowFromHealth`
 * to build one from an `AgentHealth` row.
 */
export interface BuddyAgentRow {
  /** True for the main (lead) agent — reads the rich `signals`. Sub-agents are
   *  coarse/event-stream only. */
  isMain: boolean
  /** Coarse lifecycle from the event stream: a stopped sub-agent is `done`;
   *  anything else is treated as still running. (Ignored for the main agent —
   *  the main agent's mood comes entirely from `signals`.) */
  status: 'running' | 'done' | 'idle'
  /** ISO instant of the agent's last observed event (tool / turn). Drives a
   *  sub-agent's fresh / stale / deep-quiet split. Null/absent ⇒ unknown ⇒ idle. */
  lastTs?: string | null
}

/**
 * The already-mirrored signals the MAIN agent's mood is read from. Every field
 * is optional / nullable so a session with no bridge degrades cleanly to `idle`
 * — activity is NEVER invented. Typed structurally (no web/session imports) so
 * this stays framework-agnostic; callers pass whatever they have honestly.
 */
export interface BuddySignals {
  /** The active session's live turn marker, if any. `live` true = a turn is in
   *  flight; `turnStartTs` (ISO) lets a long turn promote working → focused. */
  activeStatus?: { live?: boolean; turnStartTs?: string | null } | null
  /** Token-level streaming for the active session. A truthy `text` is the
   *  `thinking` signal. */
  activeStreaming?: { text?: string | null } | null
  /** A DURABLE pending tool-permission request awaiting the operator. Non-null =
   *  the main agent is blocked on you. */
  perm?: unknown | null
  /** The latest notification for the active session. A `permission_prompt` kind
   *  is the second `blocked` trigger (the hook-side permission signal). */
  latestNotification?: { notificationKind?: string | null } | null
  /** True for ~one render just after a turn ended — lets the main buddy play its
   *  `done` settle once before decaying to `idle`. Default false ⇒ idle. */
  justSettled?: boolean
  /** A tool result for the active session FAILED within the freshness window →
   *  a brief `sad` beat before returning to idle/working. */
  recentFail?: boolean
  /** THE one sleep truth (critterSleep.ts: zero running agents past the
   *  grace). True ⇒ the main word is `sleeping`. Operator ruling:
   *  this REPLACED the 5-minute idleMs timer as the sleeping source, so the
   *  mood word and the art's sleep state derive from the SAME verdict and
   *  can never disagree. Absent/false ⇒ never sleeping. */
  asleep?: boolean
  /** Heartbeat-gated liveness of the shared bridge. EXPLICITLY false suppresses
   *  the main path's streaming / live branches AND a sub-agent's `working`, so a
   *  crashed bridge no longer animates a "working" mascot while every sibling
   *  rail surface reads idle (the ghost-LIVE fix). Undefined ⇒ not suppressed. */
  bridgeLive?: boolean
}

/** MAIN-agent mood — RICH signal. Priority blocked > sad > thinking >
 *  focused/working > done > sleeping > idle (frozen contract). `now` is the
 *  caller-injected clock (buddyStateFor) — the focus-threshold compare must
 *  use it, not Date.now(), or a pinned-clock caller/test reads the wall
 *  clock. */
function mainBuddyState(s: BuddySignals, now: number): BuddyState {
  // blocked — a pending permission request, OR the latest notification is a
  // permission prompt. Highest priority: "waiting on you" trumps any activity.
  const blockedByPerm = s.perm != null
  const blockedByNote = s.latestNotification?.notificationKind === 'permission_prompt'
  if (blockedByPerm || blockedByNote) return 'blocked'

  // sad — a tool just FAILED (recently). Shown before activity so the stumble
  // reads for a beat; it decays as soon as the next turn streams / the window passes.
  if (s.recentFail) return 'sad'

  // thinking — token-level streaming is in flight. Suppressed when the bridge
  // heartbeat is explicitly dead: a half-written streaming row persists on disk
  // after a crash, so without this gate the buddy would "think" forever.
  if (s.activeStreaming?.text && s.bridgeLive !== false) return 'thinking'

  // focused vs working — a turn is live: `focused` (heads-down) once it has run
  // past BUDDY_FOCUS_MS, else plain `working`. Elapsed comes from turnStartTs.
  // Gated on the heartbeat so a stale on-disk live:true from a crashed bridge no
  // longer animates a working mascot while the sibling chrome reads idle.
  if (s.activeStatus?.live && s.bridgeLive !== false) {
    const start =
      typeof s.activeStatus.turnStartTs === 'string'
        ? Date.parse(s.activeStatus.turnStartTs)
        : NaN
    if (Number.isFinite(start) && now - start >= BUDDY_FOCUS_MS) return 'focused'
    return 'working'
  }

  // done — a turn just ended this render; a brief settle.
  if (s.justSettled) return 'done'

  // sleeping — THE one critterSleep verdict (agent activity + grace); else
  // idle. The word rides the same derivation as the art, never its own timer.
  if (s.asleep) return 'sleeping'
  return 'idle'
}

/** SUB-agent mood — COARSE but honest, event-stream only. stopped→done,
 *  running+fresh→working, running+deep-quiet→sleeping, running+stale→idle.
 *  NEVER blocked / thinking (no per-sub-agent permission or thinking signal
 *  exists — that would be fabricated). `working` is suppressed when the heartbeat
 *  is EXPLICITLY dead (bridgeLive === false): a SubagentStop never recorded after
 *  a bridge crash leaves the row fresh-looking, and without this gate the critter
 *  animated `working` while the rail dot honestly read idle. Undefined ⇒ prior
 *  behavior. */
function subBuddyState(a: BuddyAgentRow, now: number, bridgeLive?: boolean): BuddyState {
  if (a.status === 'done') return 'done'
  // running: fresh → working; quiet → idle; quiet past deep-idle → sleeping.
  const last = a.lastTs ? Date.parse(a.lastTs) : NaN
  if (!Number.isFinite(last)) return 'idle'
  const quietMs = now - last
  if (quietMs < BUDDY_FRESH_MS) return bridgeLive === false ? 'idle' : 'working'
  if (quietMs >= BUDDY_DEEP_IDLE_MS) return 'sleeping'
  return 'idle'
}

/**
 * Derive the buddy mood for a roster agent. The MAIN agent (`a.isMain`) reads
 * the full `signals`; a sub-agent reads its own roster row + recency PLUS the
 * one shared heartbeat signal (`signals.bridgeLive`) so its critter can't
 * animate on a dead bridge. `now` is injected (default `Date.now()`) so callers
 * / tests can pin the clock. Pure.
 */
export function buddyStateFor(
  a: BuddyAgentRow,
  signals: BuddySignals,
  now: number = Date.now(),
): BuddyState {
  return a.isMain ? mainBuddyState(signals, now) : subBuddyState(a, now, signals.bridgeLive)
}

/**
 * Adapt Mercury's live roster row (`AgentHealth` from utils/swarm/roomHealth)
 * into a `BuddyAgentRow`, HONESTLY. Mercury's roster carries no per-agent event
 * timestamp, so liveness is inferred from the SAME lease-age signal the roster
 * already derives:
 *   - `idle` (owns no open tasks) → idle, no recency.
 *   - `busy` (owns open work, fresh lease) → running + a synthesized recent
 *     `lastTs` (now − leaseAgeMs, or `now` when no lease is held) so a busy
 *     agent reads `working`.
 *   - `drifting` (busy but its lease has gone stale past the drift window) →
 *     running + the stale `lastTs` so it reads `idle`/`sleeping`, never a fake
 *     `working`.
 * Typed structurally (no roomHealth import) to keep this file dependency-free;
 * pass any object with the listed fields.
 */
export function buddyRowFromHealth(
  h: {
    name?: string
    state: 'idle' | 'busy' | 'drifting' | string
    leaseAgeMs?: number | null
    currentTasks?: string[]
  },
  opts: { isMain?: boolean; nowMs?: number } = {},
): BuddyAgentRow {
  const now = opts.nowMs ?? Date.now()
  const isMain = opts.isMain ?? false

  if (h.state === 'idle') {
    return { isMain, status: 'idle', lastTs: null }
  }

  // busy / drifting are both "running"; recency comes from the freshest lease age
  // (older lease ⇒ staler ⇒ idle/sleeping). No lease held while busy ⇒ treat as
  // just-now fresh (the task ownership is the live signal).
  const ageMs =
    typeof h.leaseAgeMs === 'number' && Number.isFinite(h.leaseAgeMs) && h.leaseAgeMs >= 0
      ? h.leaseAgeMs
      : 0
  const lastTs = new Date(now - ageMs).toISOString()
  return { isMain, status: 'running', lastTs }
}

/** Map a buddy mood to its tone KEY in the warm-ink palette. Returns a token
 *  NAME (not a hex) so the render site imports the actual token from
 *  components/mercuryPalette.js — zero new hex literals. `blocked` is the only
 *  status-spine colour (CRIMSON); the rest stay on identity / meta hues.
 *
 *  thinking/working/focused → TEAL (active)   done     → SECOND (settled)
 *  blocked                  → CRIMSON (spine)  sad      → AMBER (stumble)
 *  sleeping/idle            → FAINT (quiet)
 */
export type BuddyToneKey =
  | 'TERRA'
  | 'IVORY'
  | 'SECOND'
  | 'FAINT'
  | 'TEAL'
  | 'AMBER'
  | 'CRIMSON'

export function buddyTone(state: BuddyState): BuddyToneKey {
  switch (state) {
    case 'blocked':
      return 'CRIMSON'
    case 'sad':
      return 'AMBER'
    case 'thinking':
    case 'working':
    case 'focused':
      return 'TEAL'
    case 'done':
      return 'SECOND'
    case 'sleeping':
    case 'idle':
    default:
      return 'FAINT'
  }
}
