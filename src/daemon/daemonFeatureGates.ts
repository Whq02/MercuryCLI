/* ============================================================================
   daemonFeatureGates — the daemon-posture provenance gates, read LIVE.

   The daemon ITSELF stays an explicit `mercury daemon` opt-in (it must never
   auto-start). What the engage seams stamp on the daemon they spawn is
   PROVENANCE: which operator gesture stood this daemon up, so the boot posture
   log and a dead-worker investigation can tell one host from another.

   Lives in its OWN module (not daemon/main.ts) so UI snapshots can read
   daemon gates without pulling the daemon's server internals into the UI
   path.
   ============================================================================ */
import { flagEnv } from '../substrate/flagRegistry.js'

/**
 * Was THIS daemon spawned to host crew teammates (/teammates)? ensureCrewDaemon
 * (crewClient) stamps MERCURY_DAEMON_CREW=1 on the daemon it spawns — provenance
 * for the boot posture log + daemon.log forensics (a run must leave
 * recoverable evidence). Deliberately NOT a crewSpawn gate: the RPC is
 * explicit + authed and serves on ANY daemon, because the board ATTACHES to an
 * already-running daemon (one supervisor per repo socket) instead of racing a
 * second one — gating on provenance would refuse crew whenever another engage
 * got there first.
 */
export function isCrewDaemon(): boolean {
  return flagEnv('MERCURY_DAEMON_CREW') === '1'
}
