
import { existsSync } from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import { resolveMercuryRespawnEntry } from './respawnEntry.js'
import type { ScopedLspServerConfig } from './types.js'

export const MERCURY_GODOT_SERVER_NAME = 'mercury-godot'
export const GODOT_DAP_ADAPTER_KEY = 'godot'

const DEFAULT_GODOT_LSP_PORT = 6005
const DEFAULT_GODOT_DAP_PORT = 6006
const PROJECT_ROOT_WALK_LIMIT = 24

export function mercuryGodotEnabled(): boolean {
  return flagEnabled('MERCURY_GODOT')
}

function portFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  if (raw && raw.trim().length > 0) {
    logForDebugging(
      `[GODOT LANE] ignoring invalid port '${raw}' — using ${fallback}`,
    )
  }
  return fallback
}

export function godotLspPort(): number {
  return portFromEnv(flagEnv('MERCURY_GODOT_LSP_PORT'), DEFAULT_GODOT_LSP_PORT)
}

export function godotDapPort(): number {
  return portFromEnv(flagEnv('MERCURY_GODOT_DAP_PORT'), DEFAULT_GODOT_DAP_PORT)
}

export function findGodotProjectRoot(
  from: string = getCwd(),
): string | undefined {
  let dir = path.resolve(from)
  for (let depth = 0; depth < PROJECT_ROOT_WALK_LIMIT; depth++) {
    if (existsSync(path.join(dir, 'project.godot'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export function godotEditorHint(port: number): string {
  const headless =
    process.platform === 'darwin'
      ? 'godot --editor --headless works too — on macOS: <Godot.app>/Contents/MacOS/Godot --editor --headless --path <project>'
      : 'godot --editor --headless works too'
  return `is the Godot editor running with this project open? (${headless}; port: Editor Settings > Network, default ${port})`
}

export function godotBridgeCommand(
  port: number,
  hint: string,
): { command: string; args: string[] } | { reason: string } {
  const entry = resolveMercuryRespawnEntry(
    flagEnv('MERCURY_TCP_BRIDGE_ENTRY'),
    'MERCURY_TCP_BRIDGE_ENTRY',
  )
  if (!entry.script) {
    return { reason: entry.reason ?? 'no bridge entry script' }
  }
  const target = `127.0.0.1:${port}`
  return {
    command: process.execPath,
    args: entry.direct
      ? [entry.script, target, '--hint', hint]
      : [entry.script, '--mercury-tcp-bridge', target, '--hint', hint],
  }
}

export interface GodotLaneProbe {
  enabled: boolean
  projectRoot?: string
  lspPort: number
  dapPort: number
  reason?: string
}

export function probeGodotLane(): GodotLaneProbe {
  const lspPort = godotLspPort()
  const dapPort = godotDapPort()
  if (!mercuryGodotEnabled()) {
    return { enabled: false, lspPort, dapPort, reason: 'MERCURY_GODOT not set' }
  }
  const projectRoot = findGodotProjectRoot()
  if (!projectRoot) {
    return {
      enabled: true,
      lspPort,
      dapPort,
      reason: `no project.godot from ${getCwd()}`,
    }
  }
  return { enabled: true, projectRoot, lspPort, dapPort }
}

export function probeGodotEditorReachable(
  port: number,
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

export function builtinGodotServer(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspEnabled() || !mercuryGodotEnabled()) return {}
  const probe = probeGodotLane()
  if (!probe.projectRoot) {
    logForDebugging(
      `[LSP BUILTIN] mercury-godot unavailable: ${probe.reason ?? 'unknown'}`,
    )
    return {}
  }
  const bridge = godotBridgeCommand(
    probe.lspPort,
    godotEditorHint(probe.lspPort),
  )
  if ('reason' in bridge) {
    logForDebugging(`[LSP BUILTIN] mercury-godot unavailable: ${bridge.reason}`)
    return {}
  }
  return {
    [MERCURY_GODOT_SERVER_NAME]: {
      command: bridge.command,
      args: bridge.args,
      extensionToLanguage: { '.gd': 'gdscript' },
      transport: 'stdio',
      workspaceFolder: probe.projectRoot,
      startupTimeout: 30_000,
      maxRestarts: 2,
      scope: 'dynamic',
      source: 'mercury-builtin',
    },
  }
}
