/* ============================================================================
   daemonFeatureGates — the daemon-autonomy feature gates, WIRED
   LIVE.

   Both features run ONLY inside the daemon's tick loop. The daemon ITSELF stays
   an explicit `mercury daemon` opt-in (it must never auto-start) — but once it
   IS running on a Mercury build, these ship ON by default, each with a per-feature
   `=0` opt-out (mirrors the experienceCardsEnabled / MERCURY_SUBSTRATE opt-out
   shape: `=== '0'` is the only off-switch). Outside the daemon they are never
   consulted, so a normal interactive session is byte-identical. The explicit
   `=0` opt-out is byte-identical to the prior OFF-by-default
   behavior.

   Lives in its OWN module (not daemon/main.ts) so UI snapshots can read
   daemon gates without pulling the daemon's server internals into the UI
   path. (The old fire path's rider gates — artifacts capture, the handoff
   summary, the fire-outcome ledger — died with their engine; SATURN's
   per-session receipts are the fire record.)
   ============================================================================ */
import { flagEnabled, flagEnv } from '../substrate/flagRegistry.js'

/**
 * Scribe Mode "Amanuensis": on daemon boot, spawn + supervise the long-lived
 * `claude-opus-5@max` Implementer child (a stream-json process the Scribe
 * dispatches to over the mailbox bus). Daemon-only; LIVE for Mercury — opt out
 * `MERCURY_AMANUENSIS=0`. Co-located here (rather than utils/scribe/scribeGates)
 * because the daemon is its sole consumer (main.ts spawns the child off this gate).
 * Unlike the artifact/handoff gates, the /substrate + /deck snapshot does NOT read
 * this one — the Implementer's LIVE state surfaces to those surfaces via the daemon
 * control list/status (the roster `workers` rows in status.ts). Same gate shape as
 * the other daemon gates: OFF ('0') ⇒ no spawn ⇒ byte-identical daemon behavior.
 */
export function isImplementerSpawnEnabled(): boolean {
  return flagEnabled('MERCURY_AMANUENSIS')
}

/**
 * Was THIS daemon started for Scribe Mode? —
 * MERCURY_AMANUENSIS is default-ON, so gating the Implementer auto-spawn on
 * it alone made EVERY `mercury daemon` start (incl. a plain cron/scheduler run)
 * eagerly spawn a long-lived opus@max child. The scribe-engage path
 * (ensureScribeDaemon -> spawnOwnedDaemon extraEnv) stamps
 * MERCURY_DAEMON_SCRIBE_ENGAGE=1 on the daemon it spawns; an operator can still
 * force the spawn on a manual daemon with an EXPLICIT MERCURY_AMANUENSIS=1
 * (explicit '1' is not the same as the unset flag's default-ON — the
 * DEFAULT-CONFLATION lesson: distinguish "explicitly requested" from
 * "defaulted"). Neither present => a plain scheduler daemon hosts no Implementer.
 */
export function isScribeEngageDaemon(): boolean {
  return (
    flagEnv('MERCURY_DAEMON_SCRIBE_ENGAGE') === '1' ||
    flagEnv('MERCURY_AMANUENSIS') === '1'
  )
}

/**
 * This daemon was spawned by a WORKFLOWS-posture scribe engage (the /model
 * "Scribe + workflows" row, MERCURY_SCRIBE_WORKFLOWS): the engage stamped
 * MERCURY_DAEMON_SCRIBE_WORKFLOWS=1 (buildScribeDaemonExtraEnv), and main.ts
 * then stamps the Implementer child SPEC with MERCURY_IMPLEMENTER_WORKFLOWS=1
 * so its pack compiles the workflow-capable variant (spec-carried — respawns
 * keep it). Unset ⇒ the base Implementer, byte-identical.
 */
export function isScribeWorkflowsDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_SCRIBE_WORKFLOWS') === '1'
}

/**
 * Was THIS daemon spawned to host crew teammates (/teammates)? ensureCrewDaemon
 * (crewClient) stamps MERCURY_DAEMON_CREW=1 on the daemon it spawns — provenance
 * for the boot posture log + daemon.log forensics (the party run-#1 lesson: a
 * run must leave recoverable evidence). Deliberately NOT a crewSpawn gate: the
 * RPC is explicit + authed and serves on ANY fork daemon, because the board
 * ATTACHES to an already-running scribe/party daemon (one supervisor per repo
 * socket) instead of racing a second one — gating on provenance would refuse
 * crew whenever another engage got there first.
 */
export function isCrewDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_CREW') === '1'
}
