// ============================================================================
//  ide/godotSession — ONE typed projection over the THREE existing Godot
//  surfaces. Before this, the Godot truth lived in three
//  places an agent had to interrogate separately: the language lanes
//  (services/lsp/godotLane.ts — the mercury-godot LSP lane + the `godot` DAP
//  adapter, opt-in MERCURY_GODOT), the Debug tool's owner-addressed sessions
//  (services/dap/dapClient.ts), and VULCAN editor control
//  (services/vulcan/** behind MERCURY_GODOT_TOOLS). This module FUSES them —
//  it owns NO protocol, NO transport, NO op: every fact is read through the
//  surface that already owns it (the frozen slice-6 doctrine: "Godot fuses,
//  never duplicates").
//
//    · project identity — findGodotProjectRoot (the lane's walk-up) + a
//      parse of project.godot [application] (config/name, run/main_scene);
//    · lane arming — mercuryGodotEnabled()/vulcanEnabled(), re-read LIVE; an
//      OFF flag reads as `disarmed` NAMING the arm surface (boot-menu row +
//      env), never as an error;
//    · LSP — the lane's own registration truth (builtinGodotServer) plus the
//      live manager row when a mercury-godot server is actually running;
//    · DAP — resolveAdapter('godot') for the adapter row + listDapSessions
//      scoped to the CALLER's OwnerKey (a conversation never sees another's
//      fleet), with last-stop truth per session;
//    · VULCAN — the SAME probes vulcan_status runs (vulcanInstallStatus +
//      probeGodotEditorReachable, 400ms bounded) — reachability is probed
//      BEFORE any client op, so an absent editor degrades to an honest
//      'unreachable' in under a second, never a hang;
//    · editor truth (errors · current scene · running scene) — ONLY when
//      VULCAN is reachable, through the existing client op path
//      (editor_errors / scene_current / runtime_status, 8s per-op ceilings
//      under the client's own connect/hello/heartbeat guards); otherwise an
//      honest 'unavailable (VULCAN disarmed/unreachable)'.
//
//  Launch-profile discovery (discoverGodotLaunchProfiles) is the slice-7
//  feeder: main scene from project.godot, the editor's current scene when
//  VULCAN can answer, and a bounded deterministic *.tscn walk (cap 50, the
//  overflow reported as an honest truncation count) — it EXECUTES nothing.
//
//  Consumers: the mercury://ide/godot/session resource (wiring recorded in
//  docs/forge/SLICE6-GODOT.md for the lead to apply), /doctor + /capabilities
// the slice-7 unified launch profiles. Proofs:
//  scripts/ide/prove-godot-session.ts (structural) +
//  scripts/ide/live-godot-session-smoke.sh (RUN_LIVE journey).
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import * as path from 'node:path'
import type { OwnerKey } from '../run/ownerKey.js'
import { getCwd } from '../../utils/cwd.js'
import {
  builtinGodotServer,
  findGodotProjectRoot,
  godotBridgeCommand,
  godotDapPort,
  godotEditorHint,
  godotLspPort,
  mercuryGodotEnabled,
  probeGodotEditorReachable,
  probeGodotLane,
  GODOT_DAP_ADAPTER_KEY,
  MERCURY_GODOT_SERVER_NAME,
} from '../lsp/godotLane.js'
import { mercuryLspEnabled } from '../lsp/mercuryLsp.js'
import { getLspServerManager } from '../lsp/manager.js'
import {
  mercuryDapEnabled,
  listDapSessions,
  resolveAdapter,
} from '../dap/dapClient.js'
import { vulcanEnabled, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import {
  vulcanInstallStatus,
  type VulcanInstallStatus,
} from '../vulcan/addonInstaller.js'
import { getVulcanClient, type VulcanResult } from '../vulcan/vulcanClient.js'

// The exact arm surfaces (the startupMenu.ts rows) — every disarmed string
// names them so "how do I turn this on?" is never a second question.
export const GODOT_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot language lanes") or MERCURY_GODOT=1'
export const VULCAN_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot control surface (VULCAN)") or MERCURY_GODOT_TOOLS=1'

/** Per-op ceiling for the editor-truth reads (under the client's own 30s
 *  default; the 8s value matches the DAP request ceiling — tolerant of a
 *  busy editor import, still bounded against a wedge). */
const VULCAN_OP_TIMEOUT_MS = 8_000
/** *.tscn discovery bounds: profile cap + a directory-visit ceiling so a
 *  pathological tree can never wedge the projection. */
export const GODOT_SCENE_PROFILE_CAP = 50
const DIR_VISIT_CAP = 4_000
const SKIP_DIRS = new Set(['.godot', '.git', '.import', 'node_modules'])

// ── typed shape ──────────────────────────────────────────────────────────────

export type GodotLaneArming =
  | { state: 'armed' }
  | { state: 'disarmed'; armSurface: string }

export type GodotProjectResult =
  | {
      state: 'ok'
      root: string
      /** project.godot [application] config/name, when set. */
      name?: string
      /** run/main_scene verbatim (res:// or uid://). */
      mainScene?: string
      /** The main scene resolved to an existing absolute path (res:// only). */
      mainScenePath?: string
    }
  | { state: 'absent'; detail: string }

export interface GodotLspState {
  /** Would the mercury-godot lane register right now (the lane's OWN config
   *  source, not a re-derivation)? */
  registered: boolean
  port: number
  detail: string
  /** The live manager row, when a mercury-godot server instance exists. */
  live?: { state: string; healthy: boolean; restartCount: number }
}

export interface GodotDapSessionRow {
  id: string
  alive: boolean
  program: string
  lastStopped: { reason: string; threadId?: number; description?: string } | null
  exitDetail?: string
}

export interface GodotDapState {
  /** Is the `godot` adapter row resolvable right now (lane armed + bridge)? */
  adapterRegistered: boolean
  port: number
  detail: string
  /** THIS owner's godot debug sessions only (owner-scoped by contract). */
  sessions: GodotDapSessionRow[]
}

export type GodotVulcanState =
  | { state: 'disarmed'; port: number; detail: string }
  | { state: 'no-project'; port: number; detail: string }
  | { state: 'unreachable'; port: number; detail: string; addon: VulcanInstallStatus }
  | {
      state: 'reachable'
      port: number
      detail: string
      addon: VulcanInstallStatus
      clientStatus: 'disconnected' | 'connecting' | 'ready'
    }

/** Editor truth rides the EXISTING client op path — each field is either the
 *  op's result (bounded JSON) or that op's honest failure text. */
export type GodotEditorTruth =
  | { state: 'ok'; errors: string; currentScene: string; runningScene: string }
  | { state: 'unavailable'; detail: string }

export interface GodotIdeSession {
  project: GodotProjectResult
  /** MERCURY_GODOT — the LSP + DAP language lanes, one flag. */
  godotLane: GodotLaneArming
  /** MERCURY_GODOT_TOOLS — the VULCAN editor-control surface. */
  vulcanLane: GodotLaneArming
  lsp: GodotLspState
  dap: GodotDapState
  vulcan: GodotVulcanState
  editor: GodotEditorTruth
  collectedAt: number
}

// Slice-7 feeder — keep this type SMALL; the unified launch profiles build
// over it, they do not extend it here.
export interface GodotLaunchProfile {
  kind: 'main' | 'current' | 'scene'
  /** res:// (or uid://) scene reference. */
  scene: string
  /** Absolute path when the reference resolves to an existing file. */
  path?: string
  label: string
}

export interface GodotLaunchDiscovery {
  profiles: GodotLaunchProfile[]
  /** Total *.tscn files found (before the cap). */
  sceneCount: number
  /** Matches beyond the cap (0 = the listing is complete). */
  truncatedScenes: number
}

// ── project.godot parsing (mtime-keyed cache) ────────────────────────────────

interface ParsedProjectGodot {
  name?: string
  mainScene?: string
}

let parseCache: { file: string; mtimeMs: number; parsed: ParsedProjectGodot } | null = null

/** TEST-ONLY: drop the project.godot parse cache. */
export function _resetGodotSessionForTesting(): void {
  parseCache = null
}

// project.godot is INI-shaped (the addonInstaller sectionSpan precedent):
// [application] carries config/name="…" and run/main_scene="…".
function sectionSpan(text: string, section: string): [number, number] | null {
  const m = new RegExp(`\\[${section}\\]`).exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start).search(/\n\[[^\]]+\]/)
  return [start, rest === -1 ? text.length : start + rest]
}

function unescapeGodotString(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

/** Parse the [application] identity out of <root>/project.godot (name +
 *  main scene). Unreadable/absent file ⇒ an empty parse, never a throw. */
export function parseGodotProjectFile(root: string): ParsedProjectGodot {
  const file = path.join(root, 'project.godot')
  try {
    const st = statSync(file)
    if (parseCache && parseCache.file === file && parseCache.mtimeMs === st.mtimeMs) {
      return parseCache.parsed
    }
    const text = readFileSync(file, 'utf8')
    const span = sectionSpan(text, 'application')
    const parsed: ParsedProjectGodot = {}
    if (span) {
      const section = text.slice(span[0], span[1])
      const name = section.match(/^config\/name="((?:[^"\\]|\\.)*)"$/m)
      if (name?.[1] !== undefined) parsed.name = unescapeGodotString(name[1])
      const scene = section.match(/^run\/main_scene="((?:[^"\\]|\\.)*)"$/m)
      if (scene?.[1] !== undefined) parsed.mainScene = unescapeGodotString(scene[1])
    }
    parseCache = { file, mtimeMs: st.mtimeMs, parsed }
    return parsed
  } catch {
    return {}
  }
}

/** res://… → the absolute path when it exists inside the project (uid://
 *  references stay unresolved — the editor owns that mapping). */
function resolveResPath(root: string, scene: string): string | undefined {
  if (!scene.startsWith('res://')) return undefined
  const abs = path.join(root, scene.slice('res://'.length))
  return existsSync(abs) ? abs : undefined
}

// ── the lane/LSP/DAP/VULCAN collectors ───────────────────────────────────────

function laneArming(armed: boolean, armSurface: string): GodotLaneArming {
  return armed ? { state: 'armed' } : { state: 'disarmed', armSurface }
}

function collectLspState(): GodotLspState {
  const port = godotLspPort()
  if (!mercuryLspEnabled()) {
    return {
      registered: false,
      port,
      detail: 'the IDE bridge is off (MERCURY_LSP=0) — no lane can register',
    }
  }
  if (!mercuryGodotEnabled()) {
    return { registered: false, port, detail: `disarmed — ${GODOT_LANES_ARM_SURFACE}` }
  }
  // The lane's OWN config source is the registration truth — this module
  // never re-derives the decision.
  const configs = builtinGodotServer()
  const config = configs[MERCURY_GODOT_SERVER_NAME]
  if (!config) {
    const probe = probeGodotLane()
    let why = probe.reason
    if (!why && probe.projectRoot) {
      const bridge = godotBridgeCommand(port, godotEditorHint(port))
      why = 'reason' in bridge ? bridge.reason : 'lane config source produced nothing'
    }
    return { registered: false, port, detail: why ?? 'lane config source produced nothing' }
  }
  const live = getLspServerManager()?.getAllServers().get(MERCURY_GODOT_SERVER_NAME)
  return {
    registered: true,
    port,
    detail:
      `mercury-godot registers (workspace ${config.workspaceFolder ?? 'unset'}; ` +
      `editor LSP on 127.0.0.1:${port}; servers lazy-start on the first .gd touch)`,
    ...(live
      ? { live: { state: live.state, healthy: live.isHealthy(), restartCount: live.restartCount } }
      : {}),
  }
}

function collectDapState(owner: OwnerKey): GodotDapState {
  const port = godotDapPort()
  // Existing sessions are truth regardless of the current flag posture (a
  // mid-session disarm must not hide a still-running debuggee).
  const sessions: GodotDapSessionRow[] = listDapSessions(owner)
    .filter(({ session }) => session.adapterKey === GODOT_DAP_ADAPTER_KEY)
    .map(({ id, session }) => ({
      id,
      alive: session.alive,
      program: session.program,
      lastStopped: session.lastStopped
        ? {
            reason: session.lastStopped.reason,
            ...(session.lastStopped.threadId !== undefined
              ? { threadId: session.lastStopped.threadId }
              : {}),
            ...(session.lastStopped.description
              ? { description: session.lastStopped.description }
              : {}),
          }
        : null,
      ...(session.terminated && session.exitDetail ? { exitDetail: session.exitDetail } : {}),
    }))
  if (!mercuryDapEnabled()) {
    return {
      adapterRegistered: false,
      port,
      detail: 'the Debug tool is off (MERCURY_DAP=0)',
      sessions,
    }
  }
  if (!mercuryGodotEnabled()) {
    return {
      adapterRegistered: false,
      port,
      detail: `disarmed — ${GODOT_LANES_ARM_SURFACE}`,
      sessions,
    }
  }
  const spec = resolveAdapter(GODOT_DAP_ADAPTER_KEY)
  return spec
    ? {
        adapterRegistered: true,
        port,
        detail:
          `the 'godot' adapter dials the editor DAP on 127.0.0.1:${port} via the loopback ` +
          `bridge (launch speaks {project, scene, playArgs})`,
        sessions,
      }
    : {
        adapterRegistered: false,
        port,
        detail:
          'the godot adapter row is unresolvable (no bridge entry — set ' +
          'MERCURY_TCP_BRIDGE_ENTRY in embedder/proof contexts)',
        sessions,
      }
}

async function probeVulcanState(root: string | undefined): Promise<GodotVulcanState> {
  const port = vulcanPort()
  if (!vulcanEnabled()) {
    return { state: 'disarmed', port, detail: `disarmed — ${VULCAN_ARM_SURFACE}` }
  }
  if (!root) {
    return {
      state: 'no-project',
      port,
      detail: `armed, but no project.godot here — VULCAN activates only inside a Godot project`,
    }
  }
  const addon = vulcanInstallStatus(root)
  // The SAME 400ms-bounded probe vulcan_status runs — checked BEFORE any
  // client op so an absent editor can never hang the projection.
  const reachable = await probeGodotEditorReachable(port)
  if (!reachable) {
    return {
      state: 'unreachable',
      port,
      addon,
      detail:
        `editor not answering on 127.0.0.1:${port} — ${godotEditorHint(port)}` +
        (addon.installed ? '' : '; addon not installed (op:"vulcan_install")'),
    }
  }
  const client = getVulcanClient()
  return {
    state: 'reachable',
    port,
    addon,
    clientStatus: client?.status() ?? 'disconnected',
    detail: `editor answering on 127.0.0.1:${port}`,
  }
}

async function collectEditorTruth(
  root: string | undefined,
  vulcan: GodotVulcanState,
): Promise<GodotEditorTruth> {
  if (vulcan.state !== 'reachable') {
    const why =
      vulcan.state === 'disarmed'
        ? 'VULCAN disarmed'
        : vulcan.state === 'no-project'
          ? 'VULCAN armed, no project'
          : 'VULCAN editor unreachable'
    return { state: 'unavailable', detail: `unavailable (${why}) — ${vulcan.detail}` }
  }
  // The session client is scoped to the boot-cwd project — answer honestly
  // when the caller's root is a different project rather than reporting the
  // wrong editor's truth.
  const client = getVulcanClient()
  if (!client || findGodotProjectRoot() !== root) {
    return {
      state: 'unavailable',
      detail:
        'unavailable (the VULCAN client is scoped to the working-directory project, which is not this root)',
    }
  }
  const fmt = (op: string, r: VulcanResult): string =>
    r.ok
      ? (JSON.stringify(r.result) ?? String(r.result)).slice(0, 800)
      : `${op} failed: [${r.error.code}] ${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ''}`
  const errors = fmt(
    'editor_errors',
    await client.request('editor_errors', { limit: 8 }, VULCAN_OP_TIMEOUT_MS),
  )
  const currentScene = fmt(
    'scene_current',
    await client.request('scene_current', undefined, VULCAN_OP_TIMEOUT_MS),
  )
  const runningScene = fmt(
    'runtime_status',
    await client.request('runtime_status', undefined, VULCAN_OP_TIMEOUT_MS),
  )
  return { state: 'ok', errors, currentScene, runningScene }
}

// ── the session projection ───────────────────────────────────────────────────

/**
 * Build the fused Godot IDE session record for ONE owner: project identity +
 * lane arming + LSP/DAP/VULCAN truth + editor state, every fact through the
 * surface that owns it. Bounded (worst case: one 400ms reachability probe +
 * three 8s-capped editor reads on the reachable path); never throws for a
 * disarmed flag or an absent editor — those are STATES, not errors.
 */
export async function buildGodotIdeSession(
  owner: OwnerKey,
  from: string = getCwd(),
): Promise<GodotIdeSession> {
  const root = findGodotProjectRoot(from)
  let project: GodotProjectResult
  if (root) {
    const parsed = parseGodotProjectFile(root)
    const mainScenePath = parsed.mainScene ? resolveResPath(root, parsed.mainScene) : undefined
    project = {
      state: 'ok',
      root,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.mainScene ? { mainScene: parsed.mainScene } : {}),
      ...(mainScenePath ? { mainScenePath } : {}),
    }
  } else {
    project = {
      state: 'absent',
      detail: `no project.godot from ${path.resolve(from)} (walk-up)`,
    }
  }
  const vulcan = await probeVulcanState(root)
  return {
    project,
    godotLane: laneArming(mercuryGodotEnabled(), GODOT_LANES_ARM_SURFACE),
    vulcanLane: laneArming(vulcanEnabled(), VULCAN_ARM_SURFACE),
    lsp: collectLspState(),
    dap: collectDapState(owner),
    vulcan,
    editor: await collectEditorTruth(root, vulcan),
    collectedAt: Date.now(),
  }
}

// ── launch-profile discovery (the slice-7 feeder) ────────────────────────────

/** Bounded deterministic *.tscn walk: lexicographic DFS, editor-private and
 *  VCS dirs skipped, collection capped, the TOTAL still counted honestly. */
function walkScenes(root: string): { scenes: string[]; total: number } {
  const scenes: string[] = []
  let total = 0
  let visited = 0
  const walk = (dir: string, rel: string): void => {
    if (visited >= DIR_VISIT_CAP) return
    visited++
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile() && e.name.endsWith('.tscn')) {
        total++
        if (scenes.length < GODOT_SCENE_PROFILE_CAP) {
          scenes.push(`res://${rel ? `${rel}/` : ''}${e.name}`)
        }
      }
    }
  }
  walk(path.resolve(root), '')
  return { scenes, total }
}

/** The editor's currently-edited scene, VULCAN truth only: armed + this root
 *  is the client's project + the editor answers. Anything else ⇒ undefined
 *  (the session projection's editor block carries the why). */
async function vulcanCurrentScene(root: string): Promise<string | undefined> {
  if (!vulcanEnabled()) return undefined
  if (findGodotProjectRoot() !== root) return undefined
  if (!(await probeGodotEditorReachable(vulcanPort()))) return undefined
  const client = getVulcanClient()
  if (!client) return undefined
  const r = await client.request('scene_current', undefined, VULCAN_OP_TIMEOUT_MS)
  if (!r.ok) return undefined
  const edited = (r.result as { edited?: { path?: unknown } } | null)?.edited
  const scenePath = typeof edited?.path === 'string' ? edited.path : ''
  return scenePath.startsWith('res://') ? scenePath : undefined
}

/**
 * Discover launch profiles WITHOUT executing anything: `main` from
 * project.godot [application] run/main_scene, `current` from the running
 * editor (VULCAN, when reachable — read-class op only), plus every *.tscn
 * under the project in deterministic order (cap GODOT_SCENE_PROFILE_CAP,
 * overflow reported as truncatedScenes). unifies these with the
 * python/cpp profiles.
 */
export async function discoverGodotLaunchProfiles(root: string): Promise<GodotLaunchDiscovery> {
  const profiles: GodotLaunchProfile[] = []
  const parsed = parseGodotProjectFile(root)
  if (parsed.mainScene) {
    const p = resolveResPath(root, parsed.mainScene)
    profiles.push({
      kind: 'main',
      scene: parsed.mainScene,
      ...(p ? { path: p } : {}),
      label: 'main scene (project.godot run/main_scene)',
    })
  }
  const current = await vulcanCurrentScene(root)
  if (current) {
    const p = resolveResPath(root, current)
    profiles.push({
      kind: 'current',
      scene: current,
      ...(p ? { path: p } : {}),
      label: 'current editor scene (VULCAN scene_current)',
    })
  }
  const { scenes, total } = walkScenes(root)
  for (const scene of scenes) {
    const p = resolveResPath(root, scene)
    profiles.push({
      kind: 'scene',
      scene,
      ...(p ? { path: p } : {}),
      label: path.basename(scene),
    })
  }
  return {
    profiles,
    sceneCount: total,
    truncatedScenes: Math.max(0, total - scenes.length),
  }
}
