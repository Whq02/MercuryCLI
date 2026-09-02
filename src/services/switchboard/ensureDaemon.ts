// ============================================================================
//  switchboard/ensureDaemon — the coordinator-path daemon auto-heal
// the manager must bring up
//  its own daemon and retry, never report ENOENT at the operator.
//
//  The composer's y/n offer stays the OPERATOR-facing choice on the direct
//  path; this helper is the tool/enter path's silent heal — one
//  spawn attempt per process at a time, the route's own readiness idiom
//  (spawnOwnedDaemon + bounded handshake polls), fail-soft false.
//
//  THE VERSION HANDSHAKE rides this same door (daemon/handshake.ts): `hello`
//  first. A daemon of another version is healed — it re-executes itself as
//  the deployed build when idle, and this door waits for the successor
//  instead of spawning beside it — or painted honestly while it keeps
//  serving the verbs it knows. A client never spawns beside a live daemon.
// ============================================================================
import { daemonLastUnreachableAt } from '../../daemon/controlSocket.js'
import type { DaemonHandshakeVerdict } from '../../daemon/handshake.js'
import { getCwd } from '../../utils/cwd.js'
import { daemonHaltStanddownActive } from '../../utils/daemonStanddown.js'
import { runnerArgvFromBoot } from './runnerArgv.js'

type Handshake = typeof import('../../daemon/handshake.js')

let healing: Promise<boolean> | null = null

/** A daemon that answers and can be used: matched, or a version gap that is
 *  healed or on screen (the old daemon still serves its own verbs). */
function usable(v: DaemonHandshakeVerdict): boolean {
  return v.state === 'matched' || v.state === 'rebuilt' || v.state === 'older' || v.state === 'newer'
}

// FN-020 row 10: a daemon that answered usable moments ago is usable now.
// Every send from the focused chat ran a fresh hello handshake RPC (a
// connect, a frame, a reply) ahead of its dispatch, even mid-conversation.
// The verdict is memoized for USABLE_MEMO_TTL_MS and stands only while no
// control RPC has come back ENOCONN since it was taken — the transport's
// own stamp (controlSocket.ts) clears it the moment the daemon is gone.
const USABLE_MEMO_TTL_MS = 5_000
let usableMemo: { at: number } | null = null
function usableMemoActive(now = Date.now()): boolean {
  return usableMemo !== null && now - usableMemo.at < USABLE_MEMO_TTL_MS && daemonLastUnreachableAt() < usableMemo.at
}
function rememberUsable(): true {
  usableMemo = { at: Date.now() }
  return true
}
/** PROOF seams: the memo's live state, and a reset between scenarios. */
export function _daemonUsableMemoActiveForProofs(): boolean {
  return usableMemoActive()
}
export function _resetDaemonUsableMemoForProofs(): void {
  usableMemo = null
}

/** A daemon this process owns but did not spawn (a restart's successor)
 *  gets the parent-side reaper back. */
function adoptIfOurs(v: DaemonHandshakeVerdict): void {
  const d = v.daemon
  if (d === null || d.ownerPid !== process.pid || d.pid === null) return
  const pid = d.pid
  void import('../../daemon/ownedDaemon.js')
    .then(m => m.adoptOwnedDaemonPid(pid))
    .catch(() => {})
}

/** Poll the handshake until a usable daemon answers — BOUNDED at 40 rounds
 *  of a 500ms handshake + 250ms sleep: ≈10s when the pipe is absent (the
 *  connect fails at once), ≈30s against a pipe that is BOUND but never
 *  answers — a wedged daemon reads as 'starting' every round and this
 *  ladder never spawns a replacement (TASK-017 S2,
 *  wedged-daemon-reads-as-starting; spawn-on-wedge is the filed daemons
 *  lead). The old '~10s' named only the absent-pipe shape. */
async function awaitUsable(hs: Handshake, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const v = await hs.handshakeDaemon({ timeoutMs: 500 })
    if (usable(v)) {
      adoptIfOurs(v)
      return rememberUsable()
    }
    await new Promise(res => setTimeout(res, 250))
  }
  return false
}

/** After 'restarting': the old daemon may still answer for a beat, then
 *  nothing, then the successor — usable once it is a DIFFERENT process (a
 *  successor that came back unchanged is still the daemon to use; its
 *  storm guard refuses a second ask and the line says so). */
async function awaitSuccessor(hs: Handshake, oldPid: number | null, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const v = await hs.handshakeDaemon({ timeoutMs: 500 })
    if (usable(v) && (v.daemon?.pid ?? null) !== oldPid) {
      adoptIfOurs(v)
      return rememberUsable()
    }
    await new Promise(res => setTimeout(res, 250))
  }
  return false
}

/**
 * Arm the warm-runner pool for a workspace (the screen's door, fired from
 * the same mount hook that pre-warms the daemon): the daemon pre-spawns ONE
 * idle session runner there, so the first message claims a booted process
 * instead of paying the spawn. Idempotent ('kept' when one already lives);
 * fail-soft false — a workspace without a warm runner simply spawns cold.
 */
export async function warmSessionRunner(workspaceDir: string, retiring?: string): Promise<boolean> {
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const { bootBirthFacts, carriedKitOf } = await import('./bootBirthFacts.js')
    const reply = (await daemonControlRpc(
      {
        op: 'concourseWarm',
        workspaceDir,
        ...(retiring !== undefined ? { retiring } : {}),
        // A boot that carries runner-side options admits its sessions WITH
        // them; the pool cannot serve those, so it refuses honestly rather
        // than hold a process the operator's own flags excluded. Computed
        // at the seam from this process's own argv so every caller is
        // covered without knowing.
        ...(bootCarriesRunnerOptions() ? { runnerOptionsPresent: true } : {}),
        // THE KIT (the L18 carry at the arming door): the screen's
        // next-session kit when it holds one — the warm runner boots
        // wearing exactly what this screen's births will admit with, so
        // the claim's equality gate hits. Absent otherwise (the daemon
        // derives at the ensure); never `kit: null`.
        ...carriedKitOf(bootBirthFacts()),
      } as never,
      { timeoutMs: 5_000 },
    )) as { ok?: boolean; state?: string }
    return reply.ok === true && (reply.state === 'warmed' || reply.state === 'kept')
  } catch {
    return false
  }
}

/** Does THIS boot carry runner-side options (the one table)? Memoised —
 *  process.argv never changes after boot. */
let bootRunnerOptionsMemo: boolean | null = null
function bootCarriesRunnerOptions(): boolean {
  if (bootRunnerOptionsMemo !== null) return bootRunnerOptionsMemo
  try {
    bootRunnerOptionsMemo = runnerArgvFromBoot(process.argv.slice(2)).length > 0
  } catch {
    bootRunnerOptionsMemo = false
  }
  return bootRunnerOptionsMemo
}

/**
 * True when a daemon answers and can be used — spawning one first if none
 * does. The handshake decides: matched proceeds; a version gap is healed
 * (the daemon's own restart, awaited) or left serving with the honest line
 * on screen; only an absent daemon is spawned.
 */
/** The one in-flight 'starting' ladder (see ensureOwnedDaemon). */
let waiting: Promise<boolean> | null = null

export async function ensureOwnedDaemon(): Promise<boolean> {
  // The memo answers first — except under the /halt stand-down, whose
  // road below must keep refusing to resurrect the daemon.
  if (usableMemoActive() && !daemonHaltStanddownActive()) return true
  const hs = await import('../../daemon/handshake.js')
  const first = await hs.handshakeDaemon({ timeoutMs: 500 })
  // SINGLE-FLIGHT the 'starting' ladder: the healing memo below guards only
  // the spawn branch, so N gestures against a wedged daemon each ran their
  // own 40-poll ladder concurrently (TASK-017 S2).
  if (first.state === 'starting') {
    waiting ??= awaitUsable(hs).finally(() => {
      waiting = null
    })
    return waiting
  }
  if (usable(first)) {
    adoptIfOurs(first)
    if (first.state === 'matched') return rememberUsable()
    const heal = await hs.healDaemonVersion(first, { by: `screen ${process.pid}` })
    if (heal.state !== 'restarting') return rememberUsable()
    if (await awaitSuccessor(hs, first.daemon?.pid ?? null)) return rememberUsable()
    // The successor never came back — the spawn path below stands one up.
  }
  // /halt stand-down: THIS is the silent tool/enter heal — after the
  // operator's hard stop it must not resurrect the daemon (the "second
  // /halt reaped 4 MORE workers" class). The composer's explicit y/n offer
  // and the boards' explicit engages are different paths and stay live.
  if (daemonHaltStanddownActive()) return false
  if (healing === null) {
    healing = (async () => {
      try {
        const { spawnOwnedDaemon } = await import('../../daemon/ownedDaemon.js')
        // A boot carrying runner-side options stamps its owned daemon so
        // the boot self-warm stands down — the pool could never serve this
        // boot's sessions (they spawn cold with the flags).
        const pid = spawnOwnedDaemon(getCwd(), {
          label: 'switchboard',
          ...(bootCarriesRunnerOptions() ? { extraEnv: { MERCURY_DAEMON_NO_SELF_WARM: '1' } } : {}),
        })
        if (pid === undefined) return false
        return await awaitUsable(hs)
      } catch {
        return false
      } finally {
        healing = null
      }
    })()
  }
  return healing
}
