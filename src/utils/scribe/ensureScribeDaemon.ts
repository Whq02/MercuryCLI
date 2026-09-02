// ============================================================================
//  ensureScribeDaemon — auto-start the scheduler daemon on scribe-engage (Gap 3).
// ----------------------------------------------------------------------------
//  The Implementer (the executor seat) lives INSIDE the scheduler daemon (daemon/main.ts
//  registerLongLived). A plain `mercury` session has no daemon, so the Implementer
//  the Scribe dispatches to isn't live. This makes engaging Scribe Mode an explicit
//  operator gesture that — like typing `mercury daemon` — brings the daemon (and
//  thus the Implementer) up.
//
//  ⚠️ CARVE-OUT: this is the FIRST genuine auto-start in the tree, which tensions
//  the load-bearing "Mercury must never auto-start a daemon" rule. It is narrowly
//  gated: scribe-engage AND scribeBusLiveEnabled (MERCURY_SCRIBE_BUS_LIVE,
//  DEFAULT-ON, opt-out =0). With =0 the engage auto-starts
//  nothing. A normal (non-scribe) session never auto-starts anything.
//  Idempotent (the daemonSnapshot probe no-ops when a daemon is already live) and
//  race-safe (the daemon's single-owner scheduler lock backstops a double-spawn).
//  A daemon WE auto-start self-reaps on owner-session exit (spawnOwnedDaemon stamps the
//  owner pid + arms the exit/SIGHUP reaper; ownerWatch.ts backstops a SIGKILL); opt out
//  MERCURY_SCRIBE_DAEMON_PERSIST=1. (We do NOT reap on a mere disengage — only on session
//  exit; an explicitly-run `mercury daemon`, which carries no owner pid, persists for cron.)
// ============================================================================
import { flagSpellings } from '../../substrate/flagRegistry.js'
import { daemonSnapshot } from '../cockpit/daemonSnapshot.js'
import { scribeBusLiveEnabled } from './scribeGates.js'
import { logForDebugging } from '../debug.js'
import { mintImmediateReceipt } from '../model/seatReceipts.js'
import type { DaemonRequest } from '../../daemon/protocol.js'
import { getImplementerWorkflowsPosture } from './workflowsPosture.js'
import {
  clearDeadSupervisorRecords,
  daemonControlRpc,
} from '../../daemon/controlSocket.js'
// The owned-daemon spawn seam (owner-pid stamp + parent-side exit/SIGHUP reaper).
// Shared with the router-party's ensureDungeonDaemon so neither auto-start can orphan.
import { spawnOwnedDaemon, shouldReapAutoStartedDaemon } from '../../daemon/ownedDaemon.js'
import { daemonHaltStanddownActive } from '../daemonStanddown.js'

// Re-exported for back-compat (its home is ownedDaemon.ts now that the spawn+reap is shared).
export { shouldReapAutoStartedDaemon }

/**
 * Pure decision: should engage spawn a daemon? Only when there is no LIVE daemon.
 * 'unavailable' (stale record, pid dead) and 'off' both mean "no live daemon" ⇒
 * spawn; 'live' ⇒ noop (idempotent). Unit-testable with no side effects.
 */
export function decideScribeDaemonAction(
  daemonState: 'live' | 'unavailable' | 'off' | string,
): 'noop' | 'spawn' {
  return daemonState === 'live' ? 'noop' : 'spawn'
}

/**
 * Ensure a scheduler daemon is live for `projectDir`, spawning a detached one if
 * not. No-op unless the live bus is on (scribeBusLiveEnabled, fork-default-ON).
 * Fire-and-forget; never throws. A daemon WE spawn here is reaped on this session's
 * exit (so it doesn't linger orphaned — the operator wart); opt into persistence
 * with MERCURY_SCRIBE_DAEMON_PERSIST=1. An already-live daemon is left untouched.
 */
/**
 * The env a scribe-engage-spawned daemon carries — PURE (unit-provable): the
 * scribe-engage marker and the workflows posture (the /model
 * "Scribe + workflows" row — the daemon stamps the Implementer child spec with
 * MERCURY_IMPLEMENTER_WORKFLOWS=1 off it). EXPLICIT (postures
 * on→'1' / off→absent) so the daemon never drifts from the foreground at
 * engage; runtime changes go via the RPC.
 */
export function buildScribeDaemonExtraEnv(): Record<string, string | undefined> {
  // Both spellings per flag (the alias transition): the daemon reads
  // through the registry alias where CANONICAL wins, so a single-spelling
  // stamp here would be masked by an inherited canonical value.
  const pair = (name: string, value: string | undefined): Record<string, string | undefined> =>
    Object.fromEntries(flagSpellings(name).map(sp => [sp, value]))
  return {
    // Mark this daemon as SCRIBE-ENGAGE-spawned — the
    // Implementer auto-spawn gate (isScribeEngageDaemon) keys on it, so a
    // plain `mercury daemon` scheduler run no longer hosts an opus@max child.
    ...pair('MERCURY_DAEMON_SCRIBE_ENGAGE', '1'),
    ...pair('MERCURY_DAEMON_SCRIBE_WORKFLOWS', getImplementerWorkflowsPosture() ? '1' : undefined),
  }
}

function spawnScribeDaemon(projectDir: string): void {
  // Spawn through the shared owned-daemon seam (stamps the owner pid for the daemon-side
  // self-reap + arms the parent-side exit/SIGHUP reaper).
  spawnOwnedDaemon(projectDir, {
    label: 'scribe',
    extraEnv: buildScribeDaemonExtraEnv(),
  })
}

export function ensureScribeDaemon(projectDir: string): void {
  if (!scribeBusLiveEnabled()) return
  // /halt stand-down: after the operator's hard stop, this liveness ensure
  // must not silently resurrect the daemon. Explicit engage gestures clear
  // the latch before calling here.
  if (daemonHaltStanddownActive()) {
    logForDebugging('[scribe] ensureScribeDaemon: standing down — /halt was the operator word; re-engage Scribe to bring the daemon back')
    return
  }
  let state: string
  try {
    state = daemonSnapshot().state
  } catch (e) {
    logForDebugging(`[scribe] ensureScribeDaemon: probe failed: ${e}`)
    return
  }
  // 'off' / 'unavailable' (no record, or pid dead) ⇒ spawn now (cheap sync path).
  if (decideScribeDaemonAction(state) === 'spawn') {
    spawnScribeDaemon(projectDir)
    return
  }
  // 'live' = the recorded pid is alive — but daemonSnapshot's pid-only probe reads
  // 'live' for a STALE record whose pid the OS reused, OR a live-but-WEDGED daemon
  // that isn't actually draining the dispatch inbox. Either leaves the Implementer
  // dead while we'd otherwise no-op — the "I dispatched but no reply ever came back"
  // bug. Confirm the daemon is actually SERVING via a bounded control-socket ping
  // (the authoritative liveness check, same as `mercury daemon status`); if it does
  // NOT answer, clear the dead records and spawn a fresh one. Fire-and-forget so the
  // engage path never blocks; never throws.
  void (async () => {
    try {
      const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })
      if (ping.ok) {
        // Live AND serving ⇒ noop — but only a daemon that booted with the
        // scribe-engage stamp (or an explicit MERCURY_AMANUENSIS=1) ever
        // registers an Implementer, and registration happens ONLY at daemon
        // boot. A leftover FOREIGN daemon (a bare scheduler, a crew host)
        // answers this ping and silently no-ops the engage while every
        // dispatch sits unread forever — the silent twin of the party
        // engage's 'already-live' honesty (composePartyDaemonTail). Verify
        // hosting once after a short grace (a just-booted scribe daemon
        // registers its child during boot) and surface the wedge as ONE
        // warning receipt with the remediation. `has.present` covers live
        // AND settled roster entries, so a crashed-but-supervised
        // Implementer never false-alarms; a transient RPC failure says
        // nothing (never alarm on a guess).
        const verify = setTimeout(() => {
          void (async () => {
            try {
              const has = await daemonControlRpc(
                { op: 'has', short: 'implementer' } as DaemonRequest,
                { timeoutMs: 2000 },
              )
              if (has.ok && has.op === 'has' && !has.present) {
                mintImmediateReceipt(
                  '▲ Scribe engaged, but the running daemon was started without Scribe Mode and will never host the Implementer — dispatches will wait unanswered. Run `mercury daemon stop`, then re-engage Scribe (pick it again in /model) to bring up the right daemon.',
                  'warning',
                )
              }
            } catch {
              /* transient RPC failure — never alarm on a guess */
            }
          })()
        }, 4000)
        verify.unref?.()
        return // idempotent — the running daemon is left untouched
      }
    } catch {
      /* unreachable — fall through to respawn */
    }
    logForDebugging(
      '[scribe] recorded daemon is pid-alive but not serving (stale/reused-pid/wedged) — clearing + respawning',
    )
    try {
      await clearDeadSupervisorRecords()
    } catch {
      /* best-effort */
    }
    spawnScribeDaemon(projectDir)
  })()
}
