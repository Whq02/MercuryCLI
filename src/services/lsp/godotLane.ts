// godotLane — the Godot / GDScript IDE-hands lane (`mercury-godot`,
// MERCURY_GODOT, opt-in default-OFF per the operator directive).
//
// The GDScript language server and the Godot debug adapter live INSIDE the
// Godot editor process, listening on loopback TCP (defaults: LSP :6005,
// DAP :6006 — Editor Settings > Network). There is no stdio server to
// spawn, so both lanes ride Mercury's stdio↔TCP bridge
// (`--mercury-tcp-bridge`, src/services/tcpBridge/entry.ts): the hardened
// stdio clients drive the editor unchanged, and "editor not running" is
// just a child that exits with a teaching line.
//
//   · LSP: `mercury-godot` registers only when the lane is armed AND a
//     project.godot root is found from cwd — workspaceFolder is that root
//     (the editor resolves res:// against it). Ops that the GDScript server
//     lacks (pull diagnostics, some refactors) degrade with the tool's
//     honest capability notes; push diagnostics flow passively.
//   · DAP: dapClient gains a `godot` adapter (same bridge, DAP port) whose
//     launch request speaks the editor's contract — {project, scene} — with
//     scene selectable via the Debug tool's args ("main" | "current" | a
// Pinned from Godot's debug_adapter_parser.cpp.
//   · Both ports are operator knobs (MERCURY_GODOT_LSP_PORT /
//     MERCURY_GODOT_DAP_PORT); the host is loopback by construction.
//
// Research trail: godot-vscode-plugin issue #473 (port 6005
// default in Godot 4), Godot editor source debug_adapter_parser.cpp
// (launch args project/scene/noDebug; WRONG_PATH on project mismatch;
// attach rides an active session). The Script-IDE asset (asset-library
// #2206) sets the GDScript IDE feature bar — outline, member search,
// navigation — which the LSP tool's documentSymbol/workspaceSymbol/
// definition ops deliver once this lane connects.
//
// Proof: scripts/lsp/prove-godot-lane.ts (gate polarity, project-root
// probe, config shape, live bridge handshake against a fake TCP LSP
// server).

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

/** Master gate for BOTH Godot lanes (opt-in: MERCURY_GODOT=1). */
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

/** Nearest ancestor (including `from` itself) containing project.godot. */
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

/** The teaching line every "editor unreachable" surface repeats. A Mac's
 *  normal Godot install is the .app bundle with NO `godot` on PATH — the
 *  hint teaches that spelling too, never assuming a CLI-managed box. */
export function godotEditorHint(port: number): string {
  const headless =
    process.platform === 'darwin'
      ? 'godot --editor --headless works too — on macOS: <Godot.app>/Contents/MacOS/Godot --editor --headless --path <project>'
      : 'godot --editor --headless works too'
  return `is the Godot editor running with this project open? (${headless}; port: Editor Settings > Network, default ${port})`
}

/**
 * The bridge respawn command for a Godot loopback port. Shared by the LSP
 * config below and the DAP adapter table (dapClient.ts).
 */
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

/**
 * Lane probe shared by the config source and the /health `lsp` check, so
 * the doctor's evidence line and the boot decision can never disagree.
 */
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

/**
 * Async reachability probe for /health evidence ONLY (never gates
 * registration — the bridge itself retries and errors honestly at use time).
 */
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

/** The builtin `mercury-godot` LSP source (empty unless armed + in a project). */
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
