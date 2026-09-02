// ============================================================================
//  ide/unityBridgeSession — ONE typed projection over the Unity surfaces
//  (the godotSession sibling, the same fusion doctrine: this module owns NO
//  protocol, NO transport, NO op — every fact is read through the surface
//  that already owns it):
//
//    · project identity — buildUnityProjectProfile (the landed
//      services/ide/unityProject.ts truth: root markers, m_EditorVersion,
//      located editors — never run);
//    · lane arming — mercuryUnityEnabled(), re-read LIVE; an OFF flag reads
//      as `disarmed` NAMING the arm surface (boot-menu row + env), never as
//      an error;
//    · BRIDGE — install status (services/unity/bridgeInstaller.ts) + the
//      SAME bounded reachability the unity_status op runs (the live
//      client's ready state, else the 400ms probe made safe by the
//      hello-time accept-newest law) — probed BEFORE any wire op, so an
//      absent editor degrades to an honest 'unreachable' in under half a
//      second, never a hang;
//    · editor truth (play state · scenes · console head) — ONLY when the
//      bridge is reachable, through the existing client op path (8s per-op
//      ceilings under the client's own connect/hello/heartbeat guards);
//      otherwise an honest 'unavailable (bridge disarmed/unreachable)';
//    · test results — the DURABLE results door (the landed
//      readUnityTestResults over .mercury/unity-test-results/), never a
//      second parser: file truth, readable whether or not an editor is up.
//
//  READINESS (unityBridgeReadinessRecords, consumed by utils/readiness.ts):
//  armed-only (off ⇒ no row exists), and NEVER a connect — the readiness
//  render-safety law means the row reports arming + install truth and
//  points at op:"unity_status" for the live probe.
//
//  Consumers: the mercury://ide/unity/session resource + /doctor readiness.
//  Proof: scripts/unity-bridge/prove-unity-bridge-session.ts (fake-bridge
//  driven, including the connection-count-zero readiness pin).
// ============================================================================

import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { unityBridgeEnabled, unityBridgePort } from '../../utils/unity/bridgeGates.js'
import {
  getUnityBridgeClient,
  probeUnityBridgeReachable,
  unityBridgeHint,
  type UnityBridgeResult,
} from '../unity/bridgeClient.js'
import {
  unityBridgeInstallStatus,
  type UnityBridgeInstallStatus,
} from '../unity/bridgeInstaller.js'
import { readUnityBridgeToken } from '../unity/bridgeToken.js'
import {
  buildUnityProjectProfile,
  findUnityProjectRoot,
  mercuryUnityEnabled,
  type UnityProjectResult,
} from './unityProject.js'
import { readUnityTestResults } from './unityTests.js'

// The exact arm surface (the startupMenu.ts row) — every disarmed string
// names it so "how do I turn this on?" is never a second question.
export const UNITY_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Unity dev lanes") or MERCURY_UNITY=1'

/** Per-op ceiling for the editor-truth reads (the godotSession value: under
 *  the client's own 30s default, tolerant of a busy editor, still bounded). */
const BRIDGE_OP_TIMEOUT_MS = 8_000

// ── typed shape ──────────────────────────────────────────────────────────────

export type UnityLaneArming =
  | { state: 'armed' }
  | { state: 'disarmed'; armSurface: string }

export type UnityBridgeState =
  | { state: 'disarmed'; port: number; detail: string }
  | { state: 'no-project'; port: number; detail: string }
  | {
      state: 'unreachable'
      port: number
      detail: string
      install: UnityBridgeInstallStatus
      tokenPresent: boolean
    }
  | {
      state: 'reachable'
      port: number
      detail: string
      install: UnityBridgeInstallStatus
      tokenPresent: boolean
      clientStatus: 'disconnected' | 'connecting' | 'ready'
    }

/** Editor truth rides the EXISTING client op path — each field is either the
 *  op's result (bounded JSON) or that op's honest failure text. */
export type UnityEditorTruth =
  | { state: 'ok'; playState: string; scenes: string; consoleHead: string }
  | { state: 'unavailable'; detail: string }

/** The durable results door, per mode: counts when the file parses, the
 *  honest reason otherwise. */
export interface UnityTestResultsTruth {
  editMode: string
  playMode: string
}

export interface UnityBridgeIdeSession {
  project: UnityProjectResult
  /** MERCURY_UNITY — the one Unity switch (lanes + bridge, the ruling). */
  unityLane: UnityLaneArming
  bridge: UnityBridgeState
  editor: UnityEditorTruth
  tests: UnityTestResultsTruth
  collectedAt: number
}

// ── collectors ───────────────────────────────────────────────────────────────

function laneArming(armed: boolean): UnityLaneArming {
  return armed ? { state: 'armed' } : { state: 'disarmed', armSurface: UNITY_LANES_ARM_SURFACE }
}

async function probeBridgeState(root: string | undefined): Promise<UnityBridgeState> {
  const port = unityBridgePort()
  if (!unityBridgeEnabled()) {
    return { state: 'disarmed', port, detail: `disarmed — ${UNITY_LANES_ARM_SURFACE}` }
  }
  if (!root) {
    return {
      state: 'no-project',
      port,
      detail:
        'armed, but no Unity project here (Assets/ + ProjectSettings/) — the bridge activates only inside one',
    }
  }
  const install = unityBridgeInstallStatus(root)
  const tokenPresent = readUnityBridgeToken(root) !== undefined
  const client = getUnityBridgeClient()
  const reachable = client?.status() === 'ready' ? true : await probeUnityBridgeReachable(port)
  if (!reachable) {
    return {
      state: 'unreachable',
      port,
      install,
      tokenPresent,
      detail:
        `bridge not answering on 127.0.0.1:${port} — ${unityBridgeHint(port)}` +
        (install.installed ? '' : '; package not installed (op:"unity_bridge_install")'),
    }
  }
  return {
    state: 'reachable',
    port,
    install,
    tokenPresent,
    clientStatus: client?.status() ?? 'disconnected',
    detail: `bridge answering on 127.0.0.1:${port}`,
  }
}

async function collectEditorTruth(
  root: string | undefined,
  bridge: UnityBridgeState,
): Promise<UnityEditorTruth> {
  if (bridge.state !== 'reachable') {
    const why =
      bridge.state === 'disarmed'
        ? 'bridge disarmed'
        : bridge.state === 'no-project'
          ? 'armed, no project'
          : 'bridge unreachable'
    return { state: 'unavailable', detail: `unavailable (${why}) — ${bridge.detail}` }
  }
  // The session client is scoped to the boot-cwd project — answer honestly
  // when the caller's root is a different project rather than reporting the
  // wrong editor's truth (the godotSession scope guard).
  const client = getUnityBridgeClient()
  if (!client || findUnityProjectRoot() !== root) {
    return {
      state: 'unavailable',
      detail:
        'unavailable (the bridge client is scoped to the working-directory project, which is not this root)',
    }
  }
  const fmt = (op: string, r: UnityBridgeResult): string =>
    r.ok
      ? (JSON.stringify(r.result) ?? String(r.result)).slice(0, 800)
      : `${op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ''}`
  const playState = fmt(
    'play_state',
    await client.request('play_state', undefined, BRIDGE_OP_TIMEOUT_MS),
  )
  const scenes = fmt(
    'scene_list',
    await client.request('scene_list', undefined, BRIDGE_OP_TIMEOUT_MS),
  )
  const consoleHead = fmt(
    'console_tail',
    await client.request('console_tail', { limit: 8 }, BRIDGE_OP_TIMEOUT_MS),
  )
  return { state: 'ok', playState, scenes, consoleHead }
}

function testResultsLine(root: string | undefined, mode: 'EditMode' | 'PlayMode'): string {
  if (!root) return 'no project'
  const outcome = readUnityTestResults(root, mode)
  if (outcome.state === 'absent') return outcome.detail
  if (outcome.state === 'rejected') return `results file rejected: ${outcome.reason}`
  const c = outcome.counts
  return (
    `${outcome.result}: ${c.passed} passed · ${c.failed} failed · ${c.skipped} skipped · ` +
    `${c.errored} errored${outcome.inconclusive ? ` · ${outcome.inconclusive} inconclusive` : ''}` +
    (outcome.failures.length ? ` — failures: ${outcome.failures.slice(0, 5).join('; ')}` : '')
  )
}

// ── the session projection ───────────────────────────────────────────────────

/**
 * Build the fused Unity IDE session record: project identity + lane arming +
 * bridge truth + editor state + the durable test-results door, every fact
 * through the surface that owns it. Bounded (worst case: one 400ms
 * reachability probe + three 8s-capped editor reads on the reachable path);
 * never throws for a disarmed flag or an absent editor — those are STATES,
 * not errors.
 */
export async function buildUnityBridgeIdeSession(
  from: string = getCwd(),
): Promise<UnityBridgeIdeSession> {
  const root = findUnityProjectRoot(from)
  const project = buildUnityProjectProfile(from)
  const bridge = await probeBridgeState(root)
  return {
    project,
    unityLane: laneArming(mercuryUnityEnabled()),
    bridge,
    editor: await collectEditorTruth(root, bridge),
    tests: {
      editMode: testResultsLine(root, 'EditMode'),
      playMode: testResultsLine(root, 'PlayMode'),
    },
    collectedAt: Date.now(),
  }
}

// ── readiness (armed-only; NEVER a connect — the render-safety law) ──────────

export function unityBridgeReadinessRecords(): Array<{
  id: string
  kind: 'lane'
  label: string
  state: 'configured' | 'unavailable'
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}> {
  if (!mercuryUnityEnabled()) return []
  const at = Date.now()
  const base = {
    id: 'unity:bridge',
    kind: 'lane' as const,
    label: 'Unity editor bridge',
    source: 'bridge install census (file reads only; op:"unity_status" runs the live probe)',
    lastCheckedAt: at,
  }
  const root = findUnityProjectRoot(getCwd())
  if (!root) {
    return [
      {
        ...base,
        state: 'configured',
        detail:
          'armed — activates in a Unity project (Assets/ + ProjectSettings/); none found from the working directory',
      },
    ]
  }
  const install = unityBridgeInstallStatus(root)
  if (!install.installed) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: `Unity project at ${root} — the bridge package is not installed`,
        remedy:
          'op:"unity_bridge_install" materializes com.mercury.unity-bridge into Packages/ (the editor compiles it on focus)',
      },
    ]
  }
  const tokenPresent = readUnityBridgeToken(root) !== undefined
  return [
    {
      ...base,
      state: 'configured',
      detail:
        `package installed under ${path.join('Packages', 'com.mercury.unity-bridge')}` +
        `${install.digestMatch ? ' (matches the bundle)' : ' (DRIFTED from the bundle — unity_bridge_install refreshes)'}` +
        `; token ${tokenPresent ? 'present' : 'ABSENT (unity_bridge_install writes it)'}` +
        `; reachability is probed by op:"unity_status", never here`,
    },
  ]
}
