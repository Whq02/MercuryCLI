
import { findGodotProjectRoot, probeGodotEditorReachable, godotDapPort, godotLspPort, mercuryGodotEnabled } from '../lsp/godotLane.js'
import { vulcanEnabled, vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { presenceNudge, probeGodotEditorPresence } from './editorPresence.js'
import type { GodotProcess } from './godotProcessCensus.js'
import { getVulcanClient } from './vulcanClient.js'
import { vulcanInstallStatus } from './addonInstaller.js'

export type GodotProviderState =
  | 'ready'
  | 'not-answering'
  | 'not-installed'
  | 'disabled'
  | 'no-project'

export interface GodotProviderRow {
  id: 'vulcan' | 'godot-lsp' | 'godot-dap'
  source: string
  endpoint: string
  capabilities: string[]
  state: GodotProviderState
  observedAt: number
  failureReason?: string
}

export async function godotProviderInventory(
  projectRoot: string,
  opts: { census?: { ok: boolean; processes: GodotProcess[] } } = {},
): Promise<GodotProviderRow[]> {
  const now = Date.now()
  const rows: GodotProviderRow[] = []

  {
    const port = vulcanPort()
    const caps = vulcanLiteMode()
      ? ['scene-read', 'project-read']
      : ['scene-read', 'scene-edit', 'script-run', 'project-read', 'editor-undo']
    if (!vulcanEnabled()) {
      rows.push({
        id: 'vulcan', source: 'mercury_vulcan editor addon', endpoint: `127.0.0.1:${port}`,
        capabilities: caps, state: 'disabled', observedAt: now,
        failureReason: 'the VULCAN flag is off',
      })
    } else {
      const install = vulcanInstallStatus(projectRoot)
      if (!install.installed) {
        rows.push({
          id: 'vulcan', source: 'mercury_vulcan editor addon', endpoint: `127.0.0.1:${port}`,
          capabilities: caps, state: 'not-installed', observedAt: now,
          failureReason: 'addon not installed in this project (op:"vulcan_install")',
        })
      } else {
        const presence = await probeGodotEditorPresence(projectRoot, port, opts.census)
        const client = getVulcanClient()
        rows.push({
          id: 'vulcan', source: 'mercury_vulcan editor addon', endpoint: `127.0.0.1:${port}`,
          capabilities: caps,
          state: presence.reachable ? 'ready' : 'not-answering', observedAt: now,
          ...(presence.reachable
            ? {}
            : { failureReason: `addon installed${install.enabled ? '' : ' but NOT enabled'}; ${presence.words} — ${presenceNudge(presence, install)}` }),
          ...(client && presence.reachable ? {} : {}),
        })
      }
    }
  }

  {
    const port = godotLspPort()
    if (!mercuryGodotEnabled()) {
      rows.push({
        id: 'godot-lsp', source: 'editor language server (godot lane)', endpoint: `127.0.0.1:${port}`,
        capabilities: ['diagnostics', 'symbols', 'hover'], state: 'disabled', observedAt: now,
        failureReason: 'MERCURY_GODOT not set',
      })
    } else if (!findGodotProjectRoot(projectRoot)) {
      rows.push({
        id: 'godot-lsp', source: 'editor language server (godot lane)', endpoint: `127.0.0.1:${port}`,
        capabilities: ['diagnostics', 'symbols', 'hover'], state: 'no-project', observedAt: now,
        failureReason: 'no project.godot at or above the given root',
      })
    } else {
      const up = await probeGodotEditorReachable(port)
      rows.push({
        id: 'godot-lsp', source: 'editor language server (godot lane)', endpoint: `127.0.0.1:${port}`,
        capabilities: ['diagnostics', 'symbols', 'hover'],
        state: up ? 'ready' : 'not-answering', observedAt: now,
        ...(up ? {} : { failureReason: 'the editor is not answering on the LSP port' }),
      })
    }
  }

  {
    const port = godotDapPort()
    if (!mercuryGodotEnabled()) {
      rows.push({
        id: 'godot-dap', source: 'editor debug adapter (godot lane)', endpoint: `127.0.0.1:${port}`,
        capabilities: ['breakpoints', 'stepping', 'scenes-run'], state: 'disabled', observedAt: now,
        failureReason: 'MERCURY_GODOT not set',
      })
    } else {
      const up = await probeGodotEditorReachable(port)
      rows.push({
        id: 'godot-dap', source: 'editor debug adapter (godot lane)', endpoint: `127.0.0.1:${port}`,
        capabilities: ['breakpoints', 'stepping', 'scenes-run'],
        state: up ? 'ready' : 'not-answering', observedAt: now,
        ...(up ? {} : { failureReason: 'the editor is not answering on the DAP port' }),
      })
    }
  }

  return rows
}

export function renderProviderRows(rows: GodotProviderRow[]): string[] {
  return rows.map(r =>
    `${r.id}: ${r.state}${r.failureReason ? ` — ${r.failureReason}` : ''} · ${r.endpoint} · ${r.capabilities.join('/')}`,
  )
}
