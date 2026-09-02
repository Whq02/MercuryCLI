// ============================================================================
//  ide/blenderBridgeSession — ONE typed projection over the Blender surfaces
//  (the unityBridgeSession sibling, the same fusion doctrine: this module
//  owns NO protocol, NO transport, NO op — every fact is read through the
//  surface that already owns it):
//
//    · context — buildBlenderContextProfile (the landed
//      services/ide/blenderProject.ts truth: .blend awareness, the located
//      app, the probed version — never run beyond the probe);
//    · lane arming — mercuryBlenderEnabled(), re-read LIVE; an OFF flag
//      reads as `disarmed` NAMING the arm surface (boot-menu row + env),
//      never as an error;
//    · BRIDGE — the addon-home census (services/blender/addonHome.ts) +
//      install status (services/blender/bridgeInstaller.ts) + the SAME
//      bounded reachability the blender_status op runs (the live client's
//      ready state, else the 400ms probe made safe by the hello-time
//      accept-newest law) — probed BEFORE any wire op, so an absent Blender
//      degrades to an honest 'unreachable' in under half a second, never a
//      hang; NO home resolves to the honest 'no-home' state carrying the
//      every-road reason;
//    · editor truth (scene info · render state · report head) — ONLY when
//      the bridge is reachable, through the existing client op path (8s
//      per-op ceilings under the client's own connect/hello/heartbeat
//      guards); otherwise an honest 'unavailable (bridge …)'.
//
//  DELIBERATE differences from the unity sibling, recorded: NO scope guard
//  (the bridge is per-INSTALL/user-scoped — there is no per-project client
//  to mis-scope; a session built from any cwd reads the ONE user bridge)
//  and NO durable tests door (the named-absence ruling: Blender
//  has no test framework; render_still's durable artifact is an image at
//  its outputPath, not a store record).
//
//  READINESS (blenderBridgeReadinessRecords, consumed by utils/readiness.ts):
//  armed-only (off ⇒ no row exists), and NEVER a connect — the readiness
//  render-safety law means the row reports home + install truth and points
//  at op:"blender_status" for the live probe; enablement is reported
//  unknowable-from-disk (binary userpref.blend), the probe being the proof.
//
//  Consumers: the mercury://ide/blender/session resource + /doctor readiness.
//  Proof: scripts/blender-bridge/prove-blender-bridge-session.ts
//  (fake-bridge driven, including the connection-count-zero readiness pin
//  and the no-scope-guard pin).
// ============================================================================

import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { blenderBridgeEnabled, blenderBridgePort } from '../../utils/blender/bridgeGates.js'
import {
  getBlenderBridgeClient,
  probeBlenderBridgeReachable,
  blenderBridgeHint,
  type BlenderBridgeResult,
} from '../blender/bridgeClient.js'
import {
  blenderBridgeInstallStatus,
  type BlenderBridgeInstallStatus,
} from '../blender/bridgeInstaller.js'
import { readBlenderBridgeToken } from '../blender/bridgeToken.js'
import { BLENDER_ADDON_MODULE, resolveBlenderAddonHome } from '../blender/addonHome.js'
import {
  buildBlenderContextProfile,
  mercuryBlenderEnabled,
  type BlenderContextProfile,
} from './blenderProject.js'

// The exact arm surface (the startupMenu.ts row) — every disarmed string
// names it so "how do I turn this on?" is never a second question.
export const BLENDER_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Blender dev lanes") or MERCURY_BLENDER=1'

/** Per-op ceiling for the editor-truth reads (the godotSession value: under
 *  the client's own 30s default, tolerant of a busy Blender, still bounded). */
const BRIDGE_OP_TIMEOUT_MS = 8_000

// ── typed shape ──────────────────────────────────────────────────────────────

export type BlenderLaneArming =
  | { state: 'armed' }
  | { state: 'disarmed'; armSurface: string }

export type BlenderBridgeState =
  | { state: 'disarmed'; port: number; detail: string }
  | { state: 'no-home'; port: number; detail: string }
  | {
      state: 'unreachable'
      port: number
      detail: string
      addonHome: string
      install: BlenderBridgeInstallStatus
      tokenPresent: boolean
    }
  | {
      state: 'reachable'
      port: number
      detail: string
      addonHome: string
      install: BlenderBridgeInstallStatus
      tokenPresent: boolean
      clientStatus: 'disconnected' | 'connecting' | 'ready'
    }

/** Editor truth rides the EXISTING client op path — each field is either the
 *  op's result (bounded JSON) or that op's honest failure text. */
export type BlenderEditorTruth =
  | { state: 'ok'; sceneInfo: string; renderState: string; reportHead: string }
  | { state: 'unavailable'; detail: string }

export interface BlenderBridgeIdeSession {
  context: BlenderContextProfile
  /** MERCURY_BLENDER — the one Blender switch (lanes + bridge, the ruling). */
  blenderLane: BlenderLaneArming
  bridge: BlenderBridgeState
  editor: BlenderEditorTruth
  collectedAt: number
}

// ── collectors ───────────────────────────────────────────────────────────────

function laneArming(armed: boolean): BlenderLaneArming {
  return armed ? { state: 'armed' } : { state: 'disarmed', armSurface: BLENDER_LANES_ARM_SURFACE }
}

async function probeBridgeState(): Promise<BlenderBridgeState> {
  const port = blenderBridgePort()
  if (!blenderBridgeEnabled()) {
    return { state: 'disarmed', port, detail: `disarmed — ${BLENDER_LANES_ARM_SURFACE}` }
  }
  const census = resolveBlenderAddonHome()
  if (!census.home) {
    return {
      state: 'no-home',
      port,
      detail: `armed, but no addon home resolves — ${census.reason ?? 'unresolvable'}`,
    }
  }
  const addonHome = census.home.path
  const install = blenderBridgeInstallStatus(addonHome)
  const tokenPresent = readBlenderBridgeToken(addonHome) !== undefined
  const client = getBlenderBridgeClient()
  const reachable = client?.status() === 'ready' ? true : await probeBlenderBridgeReachable(port)
  if (!reachable) {
    return {
      state: 'unreachable',
      port,
      addonHome,
      install,
      tokenPresent,
      detail:
        `bridge not answering on 127.0.0.1:${port} — ${blenderBridgeHint(port)}` +
        (install.installed ? '' : '; add-on not installed (op:"blender_bridge_install")'),
    }
  }
  return {
    state: 'reachable',
    port,
    addonHome,
    install,
    tokenPresent,
    clientStatus: client?.status() ?? 'disconnected',
    detail: `bridge answering on 127.0.0.1:${port}`,
  }
}

async function collectEditorTruth(bridge: BlenderBridgeState): Promise<BlenderEditorTruth> {
  if (bridge.state !== 'reachable') {
    const why =
      bridge.state === 'disarmed'
        ? 'bridge disarmed'
        : bridge.state === 'no-home'
          ? 'armed, no addon home'
          : 'bridge unreachable'
    return { state: 'unavailable', detail: `unavailable (${why}) — ${bridge.detail}` }
  }
  // No scope guard by design: the bridge is user-scoped (per-install token),
  // so the ONE client serves any cwd — the recorded inverse of the unity
  // sibling's per-project guard.
  const client = getBlenderBridgeClient()
  if (!client) {
    return { state: 'unavailable', detail: 'unavailable (no client — token address unresolved)' }
  }
  const fmt = (op: string, r: BlenderBridgeResult): string =>
    r.ok
      ? (JSON.stringify(r.result) ?? String(r.result)).slice(0, 800)
      : `${op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ''}`
  const sceneInfo = fmt('scene_info', await client.request('scene_info', undefined, BRIDGE_OP_TIMEOUT_MS))
  const renderState = fmt(
    'render_state',
    await client.request('render_state', undefined, BRIDGE_OP_TIMEOUT_MS),
  )
  const reportHead = fmt(
    'report_tail',
    await client.request('report_tail', { limit: 8 }, BRIDGE_OP_TIMEOUT_MS),
  )
  return { state: 'ok', sceneInfo, renderState, reportHead }
}

// ── the session projection ───────────────────────────────────────────────────

/**
 * Build the fused Blender IDE session record: context truth + lane arming +
 * bridge truth + editor state, every fact through the surface that owns it.
 * Bounded (worst case: one 400ms reachability probe + three 8s-capped
 * editor reads on the reachable path); never throws for a disarmed flag or
 * an absent Blender — those are STATES, not errors.
 */
export async function buildBlenderBridgeIdeSession(
  from: string = getCwd(),
): Promise<BlenderBridgeIdeSession> {
  const context = buildBlenderContextProfile(from)
  const bridge = await probeBridgeState()
  return {
    context,
    blenderLane: laneArming(mercuryBlenderEnabled()),
    bridge,
    editor: await collectEditorTruth(bridge),
    collectedAt: Date.now(),
  }
}

// ── readiness (armed-only; NEVER a connect — the render-safety law) ──────────

export function blenderBridgeReadinessRecords(): Array<{
  id: string
  kind: 'lane'
  label: string
  state: 'configured' | 'unavailable'
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}> {
  if (!mercuryBlenderEnabled()) return []
  const at = Date.now()
  const base = {
    id: 'blender:bridge',
    kind: 'lane' as const,
    label: 'Blender bridge',
    source: 'addon-home + install census (file reads only; op:"blender_status" runs the live probe)',
    lastCheckedAt: at,
  }
  const census = resolveBlenderAddonHome()
  if (!census.home) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: `no addon home resolves — ${census.reason ?? 'unresolvable'}`,
        remedy:
          'install Blender (the version probe names the home), or pin MERCURY_BLENDER_BRIDGE_ADDON_DIR (or Blender\'s own BLENDER_USER_SCRIPTS)',
      },
    ]
  }
  const install = blenderBridgeInstallStatus(census.home.path)
  if (!install.installed) {
    return [
      {
        ...base,
        state: 'unavailable',
        detail: `addon home ${census.home.path} — the bridge add-on is not installed`,
        remedy:
          `op:"blender_bridge_install" materializes ${BLENDER_ADDON_MODULE} there (enabling it in Blender's Preferences stays your act)`,
      },
    ]
  }
  const tokenPresent = readBlenderBridgeToken(census.home.path) !== undefined
  return [
    {
      ...base,
      state: 'configured',
      detail:
        `add-on installed under ${path.join(census.home.path, BLENDER_ADDON_MODULE)}` +
        `${install.digestMatch ? ' (matches the bundle)' : ' (DRIFTED from the bundle — blender_bridge_install refreshes)'}` +
        `; token ${tokenPresent ? 'present' : 'ABSENT (blender_bridge_install writes it)'}` +
        `; enablement is unknowable from disk (binary userpref.blend) and reachability is probed by op:"blender_status", never here`,
    },
  ]
}
