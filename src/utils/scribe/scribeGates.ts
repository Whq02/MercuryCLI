/**
 * Scribe Mode — "Amanuensis" — feature gates + role discriminator.
 *
 * Scribe Mode is a two-process operating mode: the operator talks to a
 * `claude-fable-5[1m]@xhigh` **Scribe** (foreground REPL) that refines/queues/
 * dispatches tasks to a long-lived `claude-opus-5@max` **Implementer**
 * (daemon-spawned child) over the existing file teammate-mailbox bus, with a
 * third `scribe` memory scope, self-regulation, the persistent deck pane, and a
 * glowing-red accent.
 *
 * GATING INVARIANT (mirrors experienceCardsEnabled / Mercury's default-on
 * opt-out shape): every gate = `flag !== '0'` — default-ON, `=0` the only
 * off-switch. With the flag set to '0' the feature is off (explicit opt-out).
 * Every live call-site degrades to a no-op / identity when its gate is off, so
 * OFF ⇒ byte-identical.
 *
 * The implementer-SPAWN gate (MERCURY_AMANUENSIS) lives in
 * src/daemon/daemonFeatureGates.ts (isImplementerSpawnEnabled), co-located with
 * the other daemon-only gates because the daemon is its sole consumer (it spawns
 * the Implementer off this gate). The /substrate + /deck snapshot reads only the
 * artifact/handoff gates from that module, not this one.
 */
import { flagEnabled, flagEnv, setFlagEnv } from '../../substrate/flagRegistry.js'

/** The RETIRED party-seat markers (the multiplayer estate). Nothing in the
 *  tree sets them, but assertSingleRole keeps sweeping the spellings so a
 *  stale operator-shell stamp beside a live role still fails LOUDLY instead
 *  of half-running a retired persona (headlessRun's strip list mirrors this). */
const RETIRED_SEAT_ENV_VARS: readonly string[] = [
  'MERCURY_TANK',
  'MERCURY_HEALER',
  'MERCURY_DPS1',
  'MERCURY_DPS2',
  'MERCURY_DPS3',
]

// ── Feature gates (stamp-gated, default-ON, '0' opts out) ────────────────────

/** Scribe persona/hooks/view/accent active (the foreground intermediary). */
export function scribeModeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_MODE')
}

/** Implementer persona/hooks + inbound-authority framing active (the back process). */
export function implementerModeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_IMPLEMENTER')
}

/** The third `scribe` memory scope (unratified candidate staging) is excluded from recall. */
export function scribeScopeEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_SCOPE')
}

/** Scribe↔Implementer protocol envelopes ride the existing teammate mailbox. */
export function scribeBusEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BUS')
}

/**
 * The LIVE bus wiring (foreground team identity + Implementer inbox drain +
 * daemon auto-start) — **default-ON for Mercury since, opt-out
 * `MERCURY_SCRIBE_BUS_LIVE=0`** (the Scribe↔Implementer round-trip is proven live;
 * see the body comment). The envelope format
 * (scribeBusEnabled) is a separate, also-default-on gate. When OFF (
 * `=0`) a scribe session stays verified-honest — the Scribe says "the Implementer
 * isn't running" rather than dispatching into a void or faking a team.
 */
export function scribeBusLiveEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BUS_LIVE')
}

/**
 * Dispatch back-pressure / batching "stagger" gate (TaskList #29/#30). When ON
 * (default, opt-out MERCURY_SCRIBE_BACKPRESSURE=0): the Scribe is advised to HOLD a
 * new dispatch while an earlier one is still in flight (the awareness reminder), and
 * the daemon dispatch bridge requeues a normal dispatch that lands on a busy
 * Implementer (procedural stagger; a priority:'high' / operator-queued dispatch
 * bypasses). OFF ⇒ the advisory clause is never appended + the bridge
 * delivers immediately ⇒ byte-identical.
 */
export function scribeBackPressureEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_BACKPRESSURE')
}

/**
 * Daemon-authoritative auto-clear (#43 R2): when the Implementer's context fill reaches the
 * regulation threshold AND it is idle (between turns), the daemon respawns it for a fresh
 * transcript before it degrades. This wires ONLY the context-clear remediation (via the
 * shared REGULATION_CONTEXT_CLEAR_PCT constant); assessRegulation's pause / escalate-human
 * verdicts remain unwired. Default-ON, opt out MERCURY_SCRIBE_AUTOCLEAR=0. Safe-by-construction: it acts ONLY at a real
 * turn boundary (never mid-write), the child re-orients from disk + its inbox (a respawn is
 * normal for it), and ctx resets on respawn so it can't thrash. A health governor like
 * autocompact, not a risky behavior change. OFF ⇒ the daemon never auto-clears.
 */
export function scribeAutoClearEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_AUTOCLEAR')
}

/**
 * The open-router-like per-task router (#42 R3): match the Implementer's effort to each
 * task's hardness (max only where it pays). Applying effort is a RESPAWN, so this is
 * **opt-in / default-OFF even for Mercury** (MERCURY_SCRIBE_TASK_ROUTER=1) until it is
 * A/B-benchmarked (fixed-max vs routed) on the replay corpus — behavior-changing
 * pieces stay opt-in and never flip on without a number (the off-distribution
 * caution; scripts/substrate/prove-flag-registry.ts §3b makes a default-ON
 * behavioral gate name its evidence). OFF (the default) ⇒ the fixed pin, byte-identical.
 */
export function scribeTaskRouterEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_TASK_ROUTER')
}

/**
 * The unified CHATROOM surface (#47): scribe mode renders the REAL messages of BOTH agents
 * (Scribe + Implementer) as nameplated + timestamped chat lines ([Mercury-Amanuensis] /
 * [Mercury-Implement] / [operator]), the operator observing, replacing the "single transparent
 * Scribe surface". **Default-ON, opt out MERCURY_SCRIBE_CHATROOM=0**: this IS the
 * operator-facing surface scribe mode exists to show — engaging the router and seeing the two
 * agents converse with nameplates is the point — and it is render-verified (scripts/scribe/
 * render-chatroom.ts, 4-cell @80/120: ON ⇒ both nameplates + the operator's; OFF ⇒ the protocol
 * envelope dropped) + suite-proven, so the "until render-verified" hold is discharged. Mirrors the
 * live bus (scribeBusLiveEnabled) + autoclear it rides on. OFF (=0) ⇒ the existing
 * single-surface rendering + pack, byte-identical.
 */
export function scribeChatroomEnabled(): boolean {
  return flagEnabled('MERCURY_SCRIBE_CHATROOM')
}

// ── Role discriminator ──────────────────────────────────────────────────────
// A process is the Scribe XOR the Implementer XOR neither — never both. The
// daemon spawns each child with exactly one of these set (cloned env, never the
// supervisor's); the foreground REPL the operator launches is the Scribe.

/** True only in a process spawned as the Scribe (MERCURY_SCRIBE=1). */
export function isScribeRole(): boolean {
  return flagEnv('MERCURY_SCRIBE') === '1'
}

/** True only in a process spawned as the Implementer (MERCURY_IMPLEMENTER=1). */
export function isImplementerRole(): boolean {
  return flagEnv('MERCURY_IMPLEMENTER') === '1'
}


/** True only in a daemon-spawned CREW TEAMMATE (/teammates — role env
 *  MERCURY_CREW='1', the teammate's NAME in MERCURY_CREW_AGENT). Crew children
 *  ride the same bus + mailbox kernel as every other daemon worker, so they
 *  get the same bus-role guards (e.g. the SendMessage hand-serialized-envelope
 *  refusal) and the team-lead reply default. LITERAL dot reads. */
export function isCrewRole(): boolean {
  return flagEnv('MERCURY_CREW') === '1'
}

/**
 * Fail loud if a process is somehow tagged BOTH roles — that would cross the
 * persona/authority wiring (a Scribe must never carry Implementer authority and
 * vice-versa). Called at role-engage time so a mis-spawn aborts instead of
 * silently mixing two personas in one process.
 */
export function assertSingleRole(): void {
  // Every role env (Scribe/Implementer + crew + the 5 RETIRED seat markers) —
  // a process carries AT MOST one. Two would cross the persona/authority
  // wiring. The ==='1' predicate keeps MERCURY_CREW's dual polarity safe
  // here: an operator's ='0' kill is a gate value, not a role. The LIVE
  // roles read through the registry (flagEnv); the RETIRED spellings read
  // RAW — their registry rows died with the estate and flagEnv THROWS on an
  // unregistered name (the every-turn outage class: this
  // guard ran at every QueryEngine construct and erred every turn).
  const liveSet = ['MERCURY_SCRIBE', 'MERCURY_IMPLEMENTER', 'MERCURY_CREW'].filter(v => flagEnv(v) === '1')
  const retiredSet = RETIRED_SEAT_ENV_VARS.filter(v => process.env[v] === '1')
  const set = [...liveSet, ...retiredSet]
  if (set.length > 1) {
    throw new Error(
      `Amanuensis: a process must carry exactly ONE role env, but ${set.length} are set ` +
        `(${set.join(', ')}). Each spawned worker (Scribe/Implementer/Crew) is a single role.`,
    )
  }
}
