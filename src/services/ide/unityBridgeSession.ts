
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

export const UNITY_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Unity dev lanes") or MERCURY_UNITY=1'

const BRIDGE_OP_TIMEOUT_MS = 8_000


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

export type UnityEditorTruth =
  | { state: 'ok'; playState: string; scenes: string; consoleHead: string }
  | { state: 'unavailable'; detail: string }

export interface UnityTestResultsTruth {
  editMode: string
  playMode: string
}

export interface UnityBridgeIdeSession {
  project: UnityProjectResult
  unityLane: UnityLaneArming
  bridge: UnityBridgeState
  editor: UnityEditorTruth
  tests: UnityTestResultsTruth
  collectedAt: number
}


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
