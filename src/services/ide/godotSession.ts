
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
import { presenceNudge, probeGodotEditorPresence } from '../vulcan/editorPresence.js'
import { getVulcanClient, type VulcanResult } from '../vulcan/vulcanClient.js'

export const GODOT_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot language lanes") or MERCURY_GODOT=1'
export const VULCAN_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot control surface (VULCAN)") or MERCURY_GODOT_TOOLS=1'

const VULCAN_OP_TIMEOUT_MS = 8_000
export const GODOT_SCENE_PROFILE_CAP = 50
const DIR_VISIT_CAP = 4_000
const SKIP_DIRS = new Set(['.godot', '.git', '.import', 'node_modules'])


export type GodotLaneArming =
  | { state: 'armed' }
  | { state: 'disarmed'; armSurface: string }

export type GodotProjectResult =
  | {
      state: 'ok'
      root: string
      name?: string
      mainScene?: string
      mainScenePath?: string
    }
  | { state: 'absent'; detail: string }

export interface GodotLspState {
  registered: boolean
  port: number
  detail: string
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
  adapterRegistered: boolean
  port: number
  detail: string
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

export type GodotEditorTruth =
  | { state: 'ok'; errors: string; currentScene: string; runningScene: string }
  | { state: 'unavailable'; detail: string }

export interface GodotIdeSession {
  project: GodotProjectResult
  godotLane: GodotLaneArming
  vulcanLane: GodotLaneArming
  lsp: GodotLspState
  dap: GodotDapState
  vulcan: GodotVulcanState
  editor: GodotEditorTruth
  collectedAt: number
}

export interface GodotLaunchProfile {
  kind: 'main' | 'current' | 'scene'
  scene: string
  path?: string
  label: string
}

export interface GodotLaunchDiscovery {
  profiles: GodotLaunchProfile[]
  sceneCount: number
  truncatedScenes: number
}


interface ParsedProjectGodot {
  name?: string
  mainScene?: string
}

let parseCache: { file: string; mtimeMs: number; parsed: ParsedProjectGodot } | null = null

export function _resetGodotSessionForTesting(): void {
  parseCache = null
}

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

function resolveResPath(root: string, scene: string): string | undefined {
  if (!scene.startsWith('res://')) return undefined
  const abs = path.join(root, scene.slice('res://'.length))
  return existsSync(abs) ? abs : undefined
}


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
  const presence = await probeGodotEditorPresence(root, port)
  if (!presence.reachable) {
    return {
      state: 'unreachable',
      port,
      addon,
      detail: `${presence.words} — 127.0.0.1:${port} dark; ${presenceNudge(presence, addon)}`,
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
