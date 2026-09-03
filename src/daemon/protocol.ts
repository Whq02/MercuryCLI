// Mercury daemon control protocol — the wire contract, and nothing else.
//
// Deliberately I/O-free: only the versioned request/reply unions, the
// error-code vocabulary, and the newline-frame codecs live here. Both ends of
// the wire — the supervisor's server (controlServer.ts) and the CLI client
// (controlSocket.ts → daemonControlRpc) — import from this module, which is
// how they stay in lock-step. Transport is a same-uid unix socket; each
// connection carries a single JSON request terminated by '\n' and gets a
// single JSON reply terminated by '\n', after which the connection ends.
//
// Scope notes:
//   • There is no terminal-attach tier: the runtime hosts no PTYs (see
//     runPtyHost.ts), so no attach/resize/subscribe ops exist. A client that
//     sends an attach anyway is answered ENOTSUP instead of being ignored.
//   • Dispatch never leaves the machine — runs execute on local teammate
//     backends or as isolated headless children.

import type { SDKControlSetEffortRequest } from '../entrypoints/sdk/controlTypes.js'
import type { SessionKitEditV1, SessionKitV1 } from './sessionKit.js'

/**
 * The protocol version this build speaks. Any incompatible change to the
 * request/reply schema bumps it. A client whose `proto` lies beyond the
 * [MIN_PROTO, MERCURY_DAEMON_PROTO] window gets EPROTO back, which turns
 * "CLI and daemon were built at different versions" into a loud, typed
 * failure rather than a quiet mis-parse.
 *
 * THE VERSION FACT (the handshake): every verb added to the wire bumps this
 * constant — DAEMON_PROTO_SHAPE below is registered against it, and
 * scripts/daemon/prove-protocol-shape.ts refuses a new verb without a bump.
 * The daemon publishes the constant in supervisor.json and in its `hello`
 * reply; the client compares at connect (daemon/handshake.ts) and heals or
 * speaks the honest line. A daemon at a LOWER version is spoken to in its
 * own dialect — the RPC client stamps the negotiated proto — so the verbs it
 * knows keep working while the gap is on screen, never silently dead.
 *
 *   v1  the pre-handshake wire (no `hello`; a v2 client gets EPROTO from it
 *       — that refusal IS the detection for the first migration)
 *   v2  `hello` + `restart-when-idle`
 *   v3  the session-op rename, phase 1 (Law 9: the daemon hosts SESSIONS):
 *       sessionAdmit / sessionDispatch / sessionList / sessionRelease /
 *       sessionControl appended as the canonical spellings of the five
 *       concourse-era session ops; the old spellings route onto the same
 *       handlers through the router's alias table until proto 4. Also new
 *       at v3: the sessionControl action set-effort (a NEW verb — no alias),
 *       and the sessionControl action contract (a NEW verb — no alias): the
 *       advisory contract record's one door, op set|ack|amend|close
 *       (sessionContract.ts; nothing ever gates on a contract).
 *   v4  the steer-removal ruling: queue-edit REMOVED from
 *       the wire with the operator-facing pen (and the restage/remove/clear
 *       queue actions with it) — a v3 client's queue-edit now gets the
 *       unknown-verb refusal, which is the loud, typed detection.
 *   v5  sessionRewind (the /rewind safety net, FN-015 rank 8): the cockpit
 *       asks the runner that owns a session to restore its files to a
 *       checkpoint, wind its conversation back to a turn boundary, or both
 *       — the daemon awaits the child's own typed answer and relays it. A
 *       v4 daemon answers the unknown-verb refusal, which the client speaks
 *       as the typed 'daemon-older' outcome.
 *   v6  the sessionControl action set-spawn-switch (a NEW verb — no alias):
 *       the session's sub-agents / workflows switch, landed on the record and
 *       forwarded to the live child at a turn boundary (sessionSeat.ts —
 *       services/switchboard/spawnSwitches.ts). A v5 daemon answers the
 *       unknown-action refusal, which the connector speaks as a typed
 *       'refused' receipt.
 */
export const MERCURY_DAEMON_PROTO = 6

/** The floor: clients older than this are refused. */
export const MIN_PROTO = 1

/**
 * The registered shape of the verb set at MERCURY_DAEMON_PROTO: sha256 over
 * the DaemonOp members and the concourseControl actions in source order
 * (scripts/daemon/prove-protocol-shape.ts computes it the same way and
 * prints the value to paste). Poison: a verb added or renamed without a
 * proto bump.
 */
export const DAEMON_PROTO_SHAPE = 'sha256:24e4456f6195d853497e746fc89136503c3a0d49f113d9768538a8ae084b9d5e'

/**
 * Byte ceiling for one newline-framed request (1 MiB). Prompts that would
 * exceed it have to be trimmed or split by the sender. Server-side, a
 * connection that accumulates past this without producing a newline is
 * answered ETOOLARGE; the reader below enforces the identical bound so the
 * two ends can never disagree about what fits.
 */
export const CONTROL_FRAME_CAP = 1 << 20

/**
 * Error-code vocabulary. Each `ok:false` reply names exactly one.
 *   - ENOCONN   nothing listening / connection refused (synthesized client-side)
 *   - ETIMEOUT  connected, but the deadline passed with no reply
 *   - ESTARTING the daemon is up but still adopting / acquiring its lock
 *   - ENOJOB    the given short id names no rostered worker
 *   - EALIVE    refused because the target is still running
 *   - ESTALE    cleanup from an earlier op with this id is still in progress
 *   - EAUTH     authed op arrived without the correct control key
 *   - EPROTO    client version window mismatch (see MERCURY_DAEMON_PROTO)
 *   - ETOOLARGE the request frame blew past CONTROL_FRAME_CAP
 *   - EPEERUID  the connecting uid is not the daemon owner's uid
 *   - ENOREPLY  the worker cannot take a reply (headless — no interactive stdin)
 *   - ENOTSUP   this runtime does not serve the op (attach without a PTY host)
 *   - EUNKNOWN  unparseable JSON or an unclassified server-side error
 */
export type DaemonErrorCode =
  | 'ENOCONN'
  | 'ETIMEOUT'
  | 'ESTARTING'
  | 'ENOJOB'
  | 'EALIVE'
  | 'ESTALE'
  | 'EAUTH'
  | 'EPROTO'
  | 'ETOOLARGE'
  | 'EPEERUID'
  | 'ENOREPLY'
  | 'ENOTSUP'
  | 'EUNKNOWN'

/**
 * Every op the daemon serves.
 *   without a key : ping | nudge | shutdown | leases | hello
 *   key-gated     : all the rest
 * New verbs are APPENDED (the shape hash reads source order).
 */
export type DaemonOp =
  | 'ping'
  | 'nudge'
  | 'shutdown'
  | 'leases'
  | 'list'
  | 'has'
  | 'status'
  | 'dispatch'
  | 'reply'
  | 'kill'
  | 'reconfigure'
  | 'envelope'
  | 'crewSpawn'
  | 'concourseAdmit'
  | 'concourseDispatch'
  | 'concourseList'
  | 'concourseRelease'
  | 'concourseControl'
  | 'concourseWithdraw'
  | 'concourseWarm'
  | 'hello'
  | 'restart-when-idle'
  // v3 — the session-family spellings of the five concourse-era session ops
  // (Law 9: the daemon hosts SESSIONS; the concourse is a view). One handler
  // each: the router aliases the old spelling onto the new until proto 4.
  | 'sessionAdmit'
  | 'sessionDispatch'
  | 'sessionList'
  | 'sessionRelease'
  | 'sessionControl'
  // v5 — the /rewind verb: its answer comes from the session's own runner,
  // so it is an op of its own (awaited) rather than a sessionControl action
  // (whose host dependency answers synchronously).
  | 'sessionRewind'

/** Who asked for a run. All origins are local — a remote origin does not exist. */
export type DispatchSource = 'user' | 'cron' | 'dispatch'

/** Payload of a `dispatch` request. */
export interface DispatchBody {
  /** Stable short worker id; the client mints one when absent. */
  short?: string
  /** Text the spawned run executes. */
  prompt: string
  /** cwd for the run; falls back to the daemon's scheduling dir. */
  cwd?: string
  /** Origin tag (grouping + telemetry). */
  source?: DispatchSource
  /** Model override handed to the backend, when given. */
  model?: string
  /**
   * Dynamic-workflow name. When present, the run executes AS that workflow —
   * the deterministic `/<workflow> <prompt>` slash form — rather than
   * treating `prompt` as free text.
   */
  workflow?: string
}

// ── the /rewind verb's vocabulary (v5) ──────────────────────────────────────

/** What a rewind restores: the files, the conversation, or both. */
export type SessionRewindMode = 'code' | 'conversation' | 'both'

/**
 * Every typed reason a rewind does not land — the cockpit paints the
 * sentence for each; no arm is a generic failure.
 *   turn-active        a turn is running in the session (esc first)
 *   not-found          no user message with that id in the conversation
 *   capture-off        the runner captures no checkpoints (Settings off)
 *   no-checkpoint      the point carries no saved files
 *   drift              a tracked file changed by hand since the session
 *                      last touched it — refused BY NAME, nothing written
 *   backup-missing     a checkpoint blob is gone from the store
 *   before-compaction  the point lies before the last compaction fold
 *   restore-failed     the commit walk refused or compensated (typed detail)
 *   runner-older       the session's runner predates the verb
 *   daemon-older       the daemon predates the verb (restart it)
 *   unknown-session    no live worker record owns the session
 *   no-channel         the session has no live control channel
 *   no-answer          the runner did not answer inside the deadline
 *   no-chat            no chat is open on the cockpit
 */
export type RewindRefusalKind =
  | 'turn-active'
  | 'not-found'
  | 'capture-off'
  | 'no-checkpoint'
  | 'drift'
  | 'backup-missing'
  | 'before-compaction'
  | 'restore-failed'
  | 'runner-older'
  | 'daemon-older'
  | 'unknown-session'
  | 'no-channel'
  | 'no-answer'
  | 'no-chat'

/** The runner's own answer, relayed by the daemon and painted by the
 *  cockpit: one receipt for whatever the mode covered. */
export interface SessionRewindOutcomeV1 {
  outcome: 'applied' | 'refused' | 'noop'
  mode: SessionRewindMode
  /** Present on 'refused' — the typed reason. */
  refusal?: RewindRefusalKind
  /** The human sentence (a drift refusal names the file here). */
  detail?: string
  /** True when the request was a dry run (nothing written or appended). */
  dryRun?: boolean
  /** The files half: what a restore wrote (or, dry run, would write). */
  code?: {
    filesChanged: string[]
    insertions: number
    deletions: number
  }
  /** The conversation half: the turn boundary and how many rows left the
   *  model's view (the transcript keeps them). */
  conversation?: {
    turnUuid: string
    removed: number
  }
}

/**
 * The request union. Key-gated ops carry `proto` (checked server-side) plus
 * `auth` (the control key); the keyless ops may leave both out.
 */
export type DaemonRequest =
  | { op: 'ping'; proto?: number }
  | { op: 'nudge'; proto?: number }
  | { op: 'shutdown'; proto?: number; reapWorkers?: boolean }
  | { op: 'leases'; proto?: number }
  | { op: 'list'; proto: number; auth?: string }
  | { op: 'has'; proto: number; auth?: string; short: string }
  | { op: 'status'; proto: number; auth?: string }
  | { op: 'dispatch'; proto: number; auth?: string; d: DispatchBody }
  | { op: 'reply'; proto: number; auth?: string; short: string; text: string }
  | {
      op: 'kill'
      proto: number
      auth?: string
      short: string
      signal?: NodeJS.Signals
    }
  | {
      // Agent-bus envelope carried over the keyed socket — the primary
      // coordination transport. Holding the 0600 control key is what makes a
      // caller a dispatcher: the daemon checks the key, refuses work frames
      // signed by their own recipient (the role invariant), writes the
      // envelope into the recipient's mailbox — which stays the durability
      // journal, so a crash between journal and delivery replays from disk —
      // and then pokes the recipient's drain so delivery lands in
      // microseconds rather than at watcher cadence. A sender seeing ENOCONN
      // writes the journal itself; the daemon's startup sweep collects it.
      op: 'envelope'
      proto: number
      auth?: string
      /** Recipient agent (its inbox is the journal). */
      to: string
      /** Which team's inbox namespace; the mailbox default when omitted. */
      team?: string
      /** The bus envelope payload, validated by the server. */
      env: unknown
      /** Display color for the sender, mirrored onto the mailbox write. */
      color?: string
    }
  | {
      // Swap a long-lived worker's model/effort without tearing the seat
      // down. Nothing else travels — persona material is spliced from the
      // child's role env at spawn. The supervisor bounces the child now if
      // idle, or queues the swap for its next idle moment (see roster.ts).
      op: 'reconfigure'
      proto: number
      auth?: string
      short: string
      model?: string
      effort?: string
    }
  | {
      // Boot a named long-lived crew teammate. Only INTENT crosses the wire:
      // the daemon composes the entire spec itself (model table with the
      // floor enforced, posture, recon allowlist, capability env), so no
      // key-holding caller can hand a teammate more power than the host
      // would.
      op: 'crewSpawn'
      proto: number
      auth?: string
      /** Teammate name; the host checks it against [a-z][a-z0-9-]{1,15} and its reserved list. */
      name: string
      /** Model CHOICE key ('opus' | 'sonnet' | 'fable' | 'fable51') — a named pick, never a raw id. */
      model: string
    }
  | {
      // Seat a session worker under the daemon-enforced runtime lease.
      // Intent-only for the same reason as crewSpawn: workspace
      // canonicalization, lease accounting, the durable record, and the
      // env-scrubbed worker spec are all composed host-side, out of the
      // caller's reach.
      op: 'sessionAdmit'
      proto: number
      auth?: string
      workspaceDir: string
      /** 'shared' = the solo in-place claim (L19): the operator's own chat
       *  doors coexist on the ground; only dispatches and explicit opt-ins
       *  reach the worktree estate. */
      isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
      /** Model CHOICE key ('opus' | 'sonnet' | 'fable' | 'fable51'); 'fable' when omitted. */
      model?: string
      /** Session effort (validated); omitted ⇒ 'high', the worker default. */
      effort?: string
      title?: string
      /** Re-seat a durable session that already exists (child boots with --resume). */
      resumeSessionId?: string
      /** A BIRTH (the one-door law): the session is born blank through New
       *  Session — no words follow the admission. The record carries
       *  bornBlankAt; the idle reaper's birth grace and the reconcile's
       *  dead-newborn release read it. */
      bornBlank?: true
      /** THE KIT the birth carries (daemon/sessionKit.ts — the menu's next-
       *  session truth composed screen-side, the L18 road). Validated at
       *  the server: MALFORMED REFUSES TYPED (a dropped kit would birth
       *  whole-config — a leak of scope); absent ⇒ the daemon derives from
       *  the workspace's menu store. On a resume it RE-STAMPS the standing
       *  record. Additive on proto 3 (an older daemon simply never reads it). */
      kit?: SessionKitV1
      /** A SAVED PRESET's name: the daemon
       *  derives the kit from the PRESET's deltas instead of the menu's.
       *  Unknown/damaged REFUSES TYPED, no session born (the closed-roster
       *  law); beside `kit` refuses — one door. Additive on proto 3. */
      kitPreset?: string
    }
  | { op: 'sessionList'; proto: number; auth?: string }
  | { op: 'concourseWithdraw'; proto: number; auth?: string; clientMessageId: string }
  // `runnerId` is R2's spelling of the runner short (Law 9); the server
  // reads the legacy `workerId` off the raw frame from proto≤2 clients
  // until the alias table retires (proto 4), and the RPC client re-spells
  // the field for an old daemon the same way it re-spells the op.
  | { op: 'sessionRelease'; proto: number; auth?: string; runnerId: string }
  | {
      // Pre-spawn (or keep) the ONE warm session runner for a workspace —
      // the screen's arming door (the same mount hook that pre-warms the
      // daemon). `retiring` names the previous workspace on a switch so its
      // warm runner retires first. Idempotent: a live warm runner for the
      // workspace answers 'kept'.
      op: 'concourseWarm'
      proto: number
      auth?: string
      workspaceDir: string
      retiring?: string
      /** True when the calling boot carries runner-side options (the one
       *  table) — the pool refuses honestly: a claim can never serve them. */
      runnerOptionsPresent?: boolean
      /** THE KIT the pool pre-boots (the L18 carry at the arming door —
       *  the same next-session truth the screen's births admit with, so
       *  the claim's equality gate hits). Validated at the server exactly
       *  like sessionAdmit's; absent ⇒ the daemon derives at the ensure.
       *  Additive (an older daemon simply never reads it). */
      kit?: SessionKitV1
    }
  | {
      // Session-control verbs, decided at the supervisor; its typed outcome
      // comes back untouched. pause shuts the delivery valve (any running
      // turn completes; nothing is signalled or torn down) and resume
      // reopens it. interrupt cancels the worker's current turn through the
      // child's own control channel — no kill, no valve change. attach hands
      // the daemon's child over for a single-terminal takeover (a mid-turn
      // worker reports draining until the turn settles); detach boots the
      // SAME durable session again via resume. The grant/revoke pair manages
      // the one standing workflows permission. answer-permission settles a
      // parked permission ask from a background session with the consent
      // card's FULL answer. stop kills the child yet leaves the row visible
      // as stopped until released. The seat verbs — set-model (the
      // session's model, in place, from its next message: idle applies now,
      // busy parks it for the turn's end), set-permission-mode and
      // session-facts (a forced facts refresh) — give a hopped-into session
      // the doors the focused chat needs; set-effort is set-model's effort
      // sibling (same in-place idle/busy grammar; the value grammar is the
      // child's set_effort control — one source of truth, no second enum).
      // (queue-edit died with the operator-facing holding pen — the
      // steer-removal ruling.)
      // focus/blur write THE FOCUS FACT
      // (the record's focusedAt/focusedBy — one focused chat per terminal;
      // the hop says focus on landing and blur on leaving, a birth says
      // focus): the fact the launch-authority valve reads inside the runner.
      // park writes THE CLOSE STATE (the record's parkedAt — the operator
      // closed the chat: its runner retires after its own turn, the row
      // reads "parked · <age>", ↵ reactivates it); park-all is the quit
      // path's one call (every active session parks; sessionId is ignored).
      // contract is the ADVISORY contract record's one door (op
      // set|ack|amend|close — sessionContract.ts): author/revise the draft,
      // take the worker's acknowledgment, amend under ack (re-ack owed),
      // close with text and history kept. Advisory always: no reader may
      // gate a tool, a dispatch or an admission on contract state.
      // set-kit is THE SESSION'S KIT's one writer (daemon/sessionKitOp.ts —
      // ledger L24(3): /mcp + /skills inside a session are that session's
      // private dials, both directions; the menu never hears about it):
      // a pre-kit record materializes before it edits; the seat forwards
      // the post-edit kit whole to the live child, and a
      // mid-turn dial parks for the turn's end — the caller hears 'queued'.
      // set-schedule is SATURN's one door (daemon/saturn.ts): a schedule is
      // a SESSION FACT on the record — daemon-fired, reactivation-
      // surviving, receipted, and MULTIAUTH-NATIVE (the daemon derives the
      // account from the session's own resolution at add time; the wire
      // never writes it). op add|remove|pause|resume via `scheduleEdit`.
      op: 'sessionControl'
      proto: number
      auth?: string
      action:
        | 'pause'
        | 'resume'
        | 'interrupt'
        | 'attach'
        | 'detach'
        | 'grant-workflows'
        | 'revoke-workflows'
        | 'answer-permission'
        | 'stop'
        | 'set-model'
        | 'set-permission-mode'
          | 'session-facts'
        | 'set-title'
        | 'focus'
        | 'blur'
        | 'park'
        | 'park-all'
        | 'set-effort'
        | 'contract'
        | 'set-kit'
        | 'set-schedule'
        | 'set-spawn-switch'
      sessionId: string
      by: string
      reason?: string
      /** interrupt: the HARD stop (the second esc) — the interrupt is
       *  delivered again and the runner is cut if its turn is still open a
       *  second later; the session survives and revives on its next words. */
      hard?: boolean
      /** answer-permission: which parked ask is being settled. */
      requestId?: string
      /** answer-permission: allow (with the card's input and offered rules) or deny (with its reason). */
      allow?: boolean
      /** answer-permission: the consent card's full answer. */
      answer?: {
        updatedInput?: Record<string, unknown>
        permissionUpdates?: unknown[]
        feedback?: string
        interrupt?: boolean
      }
      /** set-model: the canonical model id the session switches to. */
      model?: string
      /** set-effort: the session's new effort — the value grammar IS the
       *  child-side SDKControlSetEffortRequest's (one source of truth, no
       *  second enum). */
      effort?: SDKControlSetEffortRequest['effort']
      /** set-permission-mode: the session's new permission mode. */
      mode?: string
      /** set-title (session-aware naming, L16): the session's new title —
       *  'operator' always lands; 'minted' fills an empty title only, once. */
      title?: string
      titleSource?: 'operator' | 'minted'
      /** contract: the advisory contract op (text rides set/amend only). */
      contract?: { op: 'set' | 'ack' | 'amend' | 'close'; text?: string }
      /** set-kit: the dial edits (daemon/sessionKit.ts's grammar — MCP and
       *  extension dials on/off, skill dials on|invocable|off); validated at
       *  the server, a malformed edit refuses typed. Rides OUTSIDE the action
       *  window like `contract`; additive on proto 3. */
      kitEdit?: SessionKitEditV1
      /** set-schedule: SATURN's one door (daemon/saturn.ts — a schedule is
       *  a SESSION FACT with its first-class multiauth account, daemon-
       *  derived; the wire submits when/action only and can never write the
       *  daemon's stamps). op add|remove|pause|resume; an 'add' submission
       *  is validated at the server and refuses typed. Rides OUTSIDE the
       *  action window like `contract`/`kitEdit`; additive on proto 3. */
      scheduleEdit?: import('./saturn.js').ScheduleOpRequestV1
      /** set-spawn-switch: the session's sub-agents or workflows switch and
       *  its new state (services/switchboard/spawnSwitches.ts) — landed on
       *  the record and forwarded to the live child at a turn boundary.
       *  Rides OUTSIDE the action window like `kitEdit`; additive. */
      spawnSwitch?: { kind: 'subagents' | 'workflows'; on: boolean }
      /** Durable op identity: replaying an id yields the stored receipt
       *  instead of running again — interrupt mutates state, so surviving a
       *  lost response depends on this. */
      clientOpId?: string
    }
  | {
      // Idempotent prompt→session dispatch. A reservation keyed on
      // clientMessageId lands first; the prompt itself travels only into the
      // seated worker's stdin (the ledger stores a digest, not the text).
      op: 'sessionDispatch'
      proto: number
      auth?: string
      clientMessageId: string
      prompt: string
      workspaceDir: string
      /** Redirect into a session that is already live — no admit runs; a
       *  paused target holds the message, typed (the valve). */
      targetSessionId?: string
      isolation?: 'exclusive' | 'worktree-isolated' | 'read-only'
      model?: string
      title?: string
      /** Agent handle + how many seats this session may hold. */
      agentName?: string
      seatsMax?: 1 | 2
      resumeSessionId?: string
      /** Attribution stamped onto the dispatch record — 'operator' for the
       *  operator's own submissions, a coordinator seat id for lane-minted
       *  ones; attached surfaces display it. */
      by?: string
      /** The composer mode the words were typed in: a bash line runs as a
       *  shell command in the session's own process. */
      mode?: 'prompt' | 'bash'
      /** The queue band the words take in the session's own queue when it
       *  is busy (the composer's queued-priority grammar). */
      priority?: 'now' | 'next' | 'later'
      /** Rich content riding the words (pastes expanded, images as blocks):
       *  the user frame carries these instead of the plain prompt text. */
      content?: unknown[]
      /** A SAVED PRESET's name: forwarded to the
       *  admit — the born session derives from the PRESET's deltas instead
       *  of the menu's; unknown/damaged refuses typed BEFORE any birth or
       *  queue hold replays it. Additive on proto 3. */
      kitPreset?: string
    }
  | {
      // THE HANDSHAKE — the first verb every client sends on connect
      // (daemon/handshake.ts). Keyless and exempt from the readiness and
      // version gates: a daemon answers it in any state, so a client can
      // compare versions BEFORE speaking any other verb. The client names
      // its own version for the daemon's log; the reply carries the
      // daemon's version fact (proto, semver, the buildTree captured at ITS
      // boot) and its idleness (live workers, sessions, warm runners).
      op: 'hello'
      proto?: number
      clientVersion?: string
      clientBuildTree?: string | null
    }
  | {
      // THE HEAL — ask the daemon to re-execute itself as the deployed
      // build: now when no live worker would die, otherwise armed for its
      // next idle moment (the reply says which). Keyed: it ends a process.
      // The successor inherits this daemon's argv, env (the owner-pid stamp
      // included) and cwd, so an owned daemon stays owned and a persistent
      // one stays persistent. A daemon on a foreground terminal refuses,
      // typed — restarting it is its terminal's job.
      op: 'restart-when-idle'
      proto: number
      auth?: string
      /** Attribution for the daemon's log ('operator', a screen pid, …). */
      by?: string
    }
  | {
      // THE /rewind VERB (v5): the cockpit names a session, a user message
      // (the restore point — file snapshots are taken at user messages) and
      // a mode; the daemon forwards a `rewind_session` control to the
      // session's own runner and AWAITS its typed answer. A dry run reports
      // what a code restore would touch and writes nothing.
      op: 'sessionRewind'
      proto: number
      auth?: string
      sessionId: string
      by: string
      mode: SessionRewindMode
      userMessageId: string
      dryRun?: boolean
    }

/** The host's half of a `hello` reply — everything but the wire constants. */
export interface DaemonHelloFacts {
  version: string
  /** The build tree the daemon BOOTED from (null outside a manifest'd
   *  bundle), read once at boot and never again: a redeploy swaps the
   *  manifest beside a still-running daemon. */
  buildTree: string | null
  pid: number
  startedAt: number
  /** The owner-pid stamp of an owned daemon; null for a persistent one. */
  ownerPid: number | null
  /** Running on a terminal (stdout or stderr is a TTY). */
  foreground: boolean
  /** Live rostered workers with the warm runners set aside; `liveSessions`
   *  is the concourse-w subset — the sessions a restart would kill. */
  live: number
  liveSessions: number
  warm: number
  /** A restart is armed for the next idle moment. */
  restartArmed: boolean
}

/** One roster row as `list` puts it on the wire. */
export interface WireRosterEntry {
  short: string
  sessionId: string
  prompt: string
  source: DispatchSource
  state: string
  pid?: number
  startedAt: number
  cliVersion: string
  /** Filled in once the run settled; missing means it is still live. */
  outcome?: string
  via?: string
  // Long-lived-seat telemetry. Everything optional: an old client still
  // parses the row, and a one-shot run simply has none of it.
  /** Model id the RUNNING child was launched with (spawn-time capture). */
  model?: string
  /** Effort floor the RUNNING child was launched with. */
  effort?: string
  /** Model a queued or in-flight retarget WANTS, present only while that
   *  bounce is still owed and differs from the running value — the
   *  "applies at turn end" annotation. Optional for older clients. */
  pendingModel?: string
  /** The effort counterpart of pendingModel. */
  pendingEffort?: string
  /** Times the supervisor has relaunched this seat (crashes and retargets). */
  respawns?: number
  /** Freshest context-window fill % (0-100), mined from the child's usage
   *  frames; missing until the first usage-bearing frame arrives. */
  contextPct?: number
  /** Activity bit: `true` while mid-task (delivery inside the idle window or
   *  an open turn), `false` when truly idle. Missing on one-shot rows. */
  busy?: boolean
  /** The RAW turn fact: `true` while a turn is open, whatever the turn
   *  cap says — the cap's release keeps dispatch from starving and is not
   *  a statement that the turn ended (FN-015 rank 69). Missing until the
   *  seat observed a turn boundary. */
  turnActive?: boolean
  /** Milliseconds the CURRENT turn has been running (now − turn start).
   *  Present only while busy inside a turn; an observer uses it to tell a
   *  long task from a stalled one. Optional for older clients. */
  turnElapsedMs?: number
}

/** One lease holder — a foreground window whose presence keeps the daemon warm. */
export interface LeaseClient {
  label?: string
  cwd?: string
}

/**
 * The reply union. Success replies echo their `op`; failures carry a `code`
 * from {@link DaemonErrorCode} — that pair is the entire discriminator a
 * client needs.
 */
export type DaemonReply =
  | { ok: true; op: 'ping'; version: string; proto: number }
  | { ok: true; op: 'nudge'; restarting: boolean; version: string }
  | {
      ok: true
      op: 'shutdown'
      reaped: number
      /** WHO was reaped — name + purpose (absent from pre-fix daemons). */
      workers?: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }>
    }
  | { ok: true; op: 'leases'; clients: LeaseClient[] }
  | { ok: true; op: 'list'; jobs: WireRosterEntry[] }
  | { ok: true; op: 'has'; alive: boolean; present: boolean; ready: boolean }
  | { ok: true; op: 'status'; status: WireStatus }
  | { ok: true; op: 'dispatch'; short: string; pid?: number; via?: string }
  | { ok: true; op: 'reply' }
  | { ok: true; op: 'envelope'; journaled: boolean }
  | { ok: true; op: 'kill' }
  // `note` is optional-additive: when the seat validator refused or adjusted
  // part of the patch, the honest reason rides here; clean patches omit it.
  | { ok: true; op: 'reconfigure'; respawned: boolean; pending: boolean; note?: string }
  | { ok: true; op: 'crewSpawn'; pid?: number }
  // The five session-family replies (v3) echo the ASKER's spelling: a
  // proto≤2 client asked with the concourse* names and reads them back in
  // its own dialect; the old literals retire with the router's alias table
  // (proto 4).
  // `runnerId` is the canonical R2 spelling; `workerId` is its legacy
  // mirror, written beside it for proto≤2 readers (the list rows carry the
  // same mirror) and dropped with the alias table at proto 4.
  // `kitSource` and `liveHop` are optional-
  // additive TWINS under ONE truth, never both: kitSource present ⟺ a kit
  // stamp ran ('carried' — the door's snapshot | 'derived' — the daemon's
  // menu composition); liveHop present ⟺ the resume converged on a LIVE
  // record — a pure hop, nothing spawned, nothing re-stamped (the client's
  // worn one-shot preset must not be spent).
  | {
      ok: true
      op: 'sessionAdmit' | 'concourseAdmit'
      runnerId: string
      workerId: string
      sessionId: string
      workspaceId: string
      pid?: number
      /** The launch receipt's facts (the dispatch door's answer carries the
       *  same set): the carved fork, the model and the effort the session
       *  runs on — and, on a resume admitted without the model it ran on,
       *  the dropped model's note. Additive on proto 3. */
      branchName?: string
      mainHolderTitle?: string
      modelId?: string
      modelDisplayName?: string
      effort?: string
      note?: string
      kitSource?: 'carried' | 'derived' | 'preset'
      liveHop?: true
      /** The preset the admission wore + the derivation's honesty note
       *  (present only with kitSource 'preset') — the launch receipts name
       *  them. Additive on proto 3. */
      presetName?: string
      presetNote?: string
    }
  | { ok: true; op: 'sessionList' | 'concourseList'; workers: ReadonlyArray<Record<string, unknown>> }
  | {
      ok: true
      op: 'sessionDispatch' | 'concourseDispatch'
      clientMessageId: string
      state: string
      stateRevision: number
      runnerId?: string
      /** Legacy mirror of runnerId (proto≤2 readers) — gone at proto 4. */
      workerId?: string
      sessionId?: string
      replay?: string
      /** Optional-additive: the admit-new road names where the
       *  born session's kit came from ('carried' | 'derived' | 'preset' —
       *  the last when the dispatch named a saved preset). */
      kitSource?: 'carried' | 'derived' | 'preset'
      /** The preset the born session wore + the derivation's honesty note
       *  (present only with kitSource 'preset'). */
      presetName?: string
      presetNote?: string
    }
  | { ok: true; op: 'sessionRelease' | 'concourseRelease'; settled: boolean; killed: boolean }
  // `queued` is optional-additive (the seat's set-model parks a mid-turn
  // switch for the turn's end — applied later, honestly not yet).
  | { ok: true; op: 'sessionControl' | 'concourseControl'; outcome: 'applied' | 'noop' | 'refused' | 'draining' | 'queued'; detail?: string }
  // The /rewind verb's answer (v5): the runner's own receipt, relayed —
  // 'refused' always carries its typed `refusal`; the daemon's own arms
  // (no record, no channel, no answer, mid-turn) speak the same vocabulary.
  | ({ ok: true; op: 'sessionRewind' } & SessionRewindOutcomeV1)
  | { ok: true; op: 'concourseWithdraw'; withdrawn: boolean }
  // The warm door's typed outcome: 'warmed' (a runner pre-spawned), 'kept'
  // (one already lives for this workspace), 'refused' (typed detail — seat
  // reading, no registry default, no free slot; the next dispatch simply
  // spawns cold).
  | { ok: true; op: 'concourseWarm'; state: 'warmed' | 'kept' | 'refused'; detail?: string }
  // The handshake's answer: the wire constants plus the host's version fact
  // and idleness (DaemonHelloFacts). `ready` is false while adoption / lock
  // work is still in progress — every keyed op would answer ESTARTING.
  | ({ ok: true; op: 'hello'; proto: number; minProto: number; ready: boolean } & DaemonHelloFacts)
  // The heal's typed outcome: 'restarting' — idle, the daemon re-executes
  // itself once this reply flushes; 'armed' — live workers, it restarts at
  // its next idle moment; 'refused' — it cannot (a foreground terminal, a
  // successor that just came back unchanged), `detail` says why.
  | { ok: true; op: 'restart-when-idle'; state: 'restarting' | 'armed' | 'refused'; live: number; detail?: string }
  // `state`/`stateRevision` are optional-additive: even a refused
  // concourseDispatch reports its ledger row's durable truth — a held
  // dispatch is a STATE ('queued' + held), not a failure, and the receipt
  // alone must say so, with no trip to the ledger file required. `refusal`
  // is optional-additive as well: the typed admission-refusal code
  // ('runtime-ceiling' | 'workspace-collision' | …) next to the prose reason.
  // `heldReason` / `heldByTitle` / `moves` are optional-additive too: a held
  // dispatch's typed hold and its executable moves ride the refusal receipt.
  | {
      ok: false
      code: DaemonErrorCode
      error: string
      refusal?: string
      state?: string
      stateRevision?: number
      heldReason?: string
      heldByTitle?: string
      moves?: Array<{ verb: string; label: string }>
      serverProto?: number
      serverVersion?: string
    }

/** Flat snapshot the `status` op returns (assembled in status.ts). */
export interface WireStatus {
  pid: number
  version: string
  startedAt: number
  uptimeSec: number
  dir: string
  workersLive: number
  workersTotal: number
  maxInflight: number
  breakerOpen: boolean
  leaseCount: number
  proto: number
  /** Supervision gave up on some long-lived worker (respawn budget spent).
   *  This is the escalation bit a human reads to learn the worker will stay
   *  down until someone intervenes. Optional for older clients. */
  degraded?: boolean
  degradedReason?: string
  /** Warm session runners alive right now (the warm-runner pool —
   *  pre-booted, unclaimed, no record; `mercury daemon status` names them
   *  on their own honest line). Optional for older clients. */
  warmRunners?: number
}

// ---------------------------------------------------------------------------
// CODECS — newline-framed JSON. Writing is `JSON.stringify(obj) + '\n'`;
// reading buffers socket bytes until the first '\n', bounded by
// CONTROL_FRAME_CAP, then hands the line over.
// ---------------------------------------------------------------------------

/** Serialize one frame: compact JSON plus a trailing newline. */
export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

/**
 * Streaming reader for exactly one newline-delimited request frame. Buffers
 * the socket's `data` events until a '\n' shows up, then detaches itself and
 * passes the preceding bytes (utf8-decoded) to `onFrame`. Should the buffer
 * outgrow CONTROL_FRAME_CAP with no newline seen, it detaches and calls
 * `onTooLarge()` instead — the cap only applies pre-newline, so a chunk that
 * completes a frame always gets through. One request per connection means
 * nothing after the first frame is consumed or passed on.
 */
export function readControlFrame(
  sock: import('net').Socket,
  onFrame: (line: string) => void,
  onTooLarge: () => void,
): void {
  const pending: Buffer[] = []
  let byteCount = 0
  const onData = (chunk: Buffer) => {
    pending.push(chunk)
    byteCount += chunk.length
    const whole = Buffer.concat(pending, byteCount)
    const cut = whole.indexOf(10)
    if (cut < 0) {
      if (byteCount > CONTROL_FRAME_CAP) {
        sock.off('data', onData)
        onTooLarge()
      }
      return
    }
    sock.off('data', onData)
    onFrame(whole.subarray(0, cut).toString('utf8'))
  }
  sock.on('data', onData)
}
