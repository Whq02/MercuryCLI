
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import * as path from 'node:path'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { getCwd } from '../../platform/files/cwd.js'
import {
  builtinGodotServer,
  findGodotProjectRoot,
  godotBridgeCommand,
  godotDapPort,
  godotEditorHint,
  godotLspPort,
  mercuryGodotEnabled,
  probeGodotLane,
  GODOT_DAP_ADAPTER_KEY,
  MERCURY_GODOT_SERVER_NAME,
} from '../lsp/godotLane.js'
import { mercuryLspEnabled } from '../lsp/mercuryLsp.js'
import { getLspServerManager } from '../lsp/serverManagerLifecycle.js'
import {
  mercuryDapEnabled,
  listDapSessions,
  resolveAdapter,
} from '../debugger/dapClient.js'
import { vulcanEnabled } from '../vulcan/vulcanGates.js'
import {
  vulcanInstallStatus,
  type VulcanInstallStatus,
  sectionSpan,
} from '../vulcan/addonInstaller.js'
import { presenceNudge, probeVulcanEditorPresence } from '../vulcan/editorPresence.js'
import { formatUnreadableVulcanInstance, scanVulcanInstances } from '../vulcan/instances.js'
import { resolveVulcanClient, type VulcanClient, type VulcanResult } from '../vulcan/vulcanClient.js'
import { SKIP_DIRS } from '../vulcan/classCache.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const GODOT_LANES_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot language lanes") or MERCURY_GODOT=1'
const VULCAN_ARM_SURFACE =
  'arm via the boot menu (miscellaneous > "Godot control surface (VULCAN)") or MERCURY_GODOT_TOOLS=1'

const VULCAN_OP_TIMEOUT_MS = 8_000
const GODOT_SCENE_PROFILE_CAP = 50
const DIR_VISIT_CAP = 4_000


type GodotLaneArming =
  | { state: 'armed' }
  | { state: 'disarmed'; armSurface: string }

type GodotProjectResult =
  | {
      state: 'ok'
      root: string
      name?: string
      mainScene?: string
      mainScenePath?: string
    }
  | { state: 'absent'; detail: string }

interface GodotLspState {
  registered: boolean
  port: number
  detail: string
  live?: { state: string; healthy: boolean; restartCount: number }
}

interface GodotDapSessionRow {
  id: string
  alive: boolean
  program: string
  lastStopped: { reason: string; threadId?: number; description?: string } | null
  exitDetail?: string
}

interface GodotDapState {
  adapterRegistered: boolean
  port: number
  detail: string
  sessions: GodotDapSessionRow[]
}

type GodotVulcanState =
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

type GodotEditorTruth =
  | { state: 'ok'; errors: string; currentScene: string; runningScene: string }
  | { state: 'unavailable'; detail: string }

interface GodotIdeSession {
  project: GodotProjectResult
  godotLane: GodotLaneArming
  vulcanLane: GodotLaneArming
  lsp: GodotLspState
  dap: GodotDapState
  vulcan: GodotVulcanState
  editor: GodotEditorTruth
  collectedAt: number
}

interface GodotLaunchProfile {
  kind: 'main' | 'current' | 'scene'
  scene: string
  path?: string
  label: string
}

interface GodotLaunchDiscovery {
  profiles: GodotLaunchProfile[]
  sceneCount: number
  truncatedScenes: number
  instanceError?: string
}


interface ParsedProjectGodot {
  name?: string
  mainScene?: string
}

let parseCache: { file: string; mtimeMs: number; parsed: ParsedProjectGodot } | null = null

export function _resetGodotSessionForTesting(): void {
  parseCache = null
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    throw error
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

async function probeVulcanState(root: string | undefined): Promise<GodotVulcanState & { client?: VulcanClient }> {
  let port = 0
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
  const presence = await probeVulcanEditorPresence(root)
  port = presence.port
  if (!presence.reachable) {
    if (!presence.instance && !presence.ambiguous?.length) {
      const scan = scanVulcanInstances(root)
      if (scan.unreadable.length > 0) {
        const first = scan.unreadable[0]!
        return {
          state: 'unreachable',
          port,
          addon,
          detail: formatUnreadableVulcanInstance(first.path, first.error),
        }
      }
    }
    return {
      state: 'unreachable',
      port,
      addon,
      detail: `${presence.words} — 127.0.0.1:${port} dark; ${presenceNudge(presence, addon)}`,
    }
  }
  const resolved = presence.instance ? resolveVulcanClient(root, presence.instance.id) : null
  if (resolved && !resolved.ok && resolved.reason === 'unreadable') {
    return {
      state: 'unreachable',
      port,
      addon,
      detail: resolved.message,
    }
  }
  const client = resolved && resolved.ok ? resolved.client : null
  return {
    state: 'reachable',
    port,
    addon,
    ...(client ? { client } : {}),
    clientStatus: client?.status() ?? 'disconnected',
    detail: addon.projectReadError
      ? `editor answering on 127.0.0.1:${port}; project.godot could not be read (${addon.projectReadError})`
      : `editor answering on 127.0.0.1:${port}`,
  }
}

async function collectEditorTruth(
  root: string | undefined,
  vulcan: GodotVulcanState,
  client?: VulcanClient,
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
  if (!client || !root) {
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
    try {
      const parsed = parseGodotProjectFile(root)
      const mainScenePath = parsed.mainScene ? resolveResPath(root, parsed.mainScene) : undefined
      project = {
        state: 'ok',
        root,
        ...(parsed.name ? { name: parsed.name } : {}),
        ...(parsed.mainScene ? { mainScene: parsed.mainScene } : {}),
        ...(mainScenePath ? { mainScenePath } : {}),
      }
    } catch (error) {
      passedOver(error)
      project = {
        state: 'absent',
        detail: `project.godot could not be read (${error instanceof Error ? error.message : String(error)})`,
      }
    }
  } else {
    project = {
      state: 'absent',
      detail: `no project.godot from ${path.resolve(from)} (walk-up)`,
    }
  }
  const { client, ...vulcan } = await probeVulcanState(root)
  return {
    project,
    godotLane: laneArming(mercuryGodotEnabled(), GODOT_LANES_ARM_SURFACE),
    vulcanLane: laneArming(vulcanEnabled(), VULCAN_ARM_SURFACE),
    lsp: collectLspState(),
    dap: collectDapState(owner),
    vulcan,
    editor: await collectEditorTruth(root, vulcan, client),
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
    } catch (error) {
      passedOver(error)
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

async function vulcanCurrentScene(root: string): Promise<{ scene?: string; error?: string }> {
  if (!vulcanEnabled()) return {}
  const presence = await probeVulcanEditorPresence(root)
  if (!presence.reachable || !presence.instance) {
    if (!presence.instance && !presence.ambiguous?.length) {
      const scan = scanVulcanInstances(root)
      if (scan.unreadable.length > 0) {
        const first = scan.unreadable[0]!
        return { error: formatUnreadableVulcanInstance(first.path, first.error) }
      }
    }
    return {}
  }
  const resolved = resolveVulcanClient(root, presence.instance.id)
  if (!resolved.ok) {
    return resolved.reason === 'unreadable' ? { error: resolved.message } : {}
  }
  const r = await resolved.client.request('scene_current', undefined, VULCAN_OP_TIMEOUT_MS)
  if (!r.ok) return {}
  const edited = (r.result as { edited?: { path?: unknown } } | null)?.edited
  const scenePath = typeof edited?.path === 'string' ? edited.path : ''
  return scenePath.startsWith('res://') ? { scene: scenePath } : {}
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
  if (current.scene) {
    const p = resolveResPath(root, current.scene)
    profiles.push({
      kind: 'current',
      scene: current.scene,
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
    ...(current.error ? { instanceError: current.error } : {}),
  }
}
