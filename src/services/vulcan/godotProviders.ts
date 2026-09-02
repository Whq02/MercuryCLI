// ============================================================================
//  godotProviders — the typed Godot provider inventory (, field
//  row). Four SEPARATE provider identities, each with a stable id,
//  source, endpoint, capabilities, state and failure reason — one provider
//  dark says NOTHING about another, and addon-absent is a different fact
//  from installed-but-not-answering. Aggregates the EXISTING probes
//  (vulcanInstallStatus, probeGodotEditorReachable, probeGodotLane, the DAP
//  gdb/godot conditional rows) — no new probing machinery.
// ============================================================================

import { findGodotProjectRoot, probeGodotEditorReachable, godotDapPort, godotLspPort, mercuryGodotEnabled } from '../lsp/godotLane.js'
import { vulcanEnabled, vulcanLiteMode, vulcanPort } from '../../utils/vulcan/vulcanGates.js'
import { getVulcanClient } from './vulcanClient.js'
import { vulcanInstallStatus } from './addonInstaller.js'

export type GodotProviderState =
  | 'ready'
  | 'not-answering'
  | 'not-installed'
  | 'disabled'
  | 'no-project'

export interface GodotProviderRow {
  /** Stable system id (truth-law 4 — routing/attribution, never a label). */
  id: 'vulcan' | 'godot-lsp' | 'godot-dap'
  /** What establishes the provider. */
  source: string
  /** Human-legible endpoint. */
  endpoint: string
  capabilities: string[]
  state: GodotProviderState
  observedAt: number
  failureReason?: string
}

/**
 * The inventory. Each row is derived INDEPENDENTLY — a dark editor never
 * masks an absent addon, and vice versa (the field case: VULCAN dark while
 * the project MCP bridge was live read as "everything broken").
 */
export async function godotProviderInventory(
  projectRoot: string,
): Promise<GodotProviderRow[]> {
  const now = Date.now()
  const rows: GodotProviderRow[] = []

  // ── native VULCAN (the editor addon) ──────────────────────────────────────
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
        const reachable = await probeGodotEditorReachable(port)
        const client = getVulcanClient()
        rows.push({
          id: 'vulcan', source: 'mercury_vulcan editor addon', endpoint: `127.0.0.1:${port}`,
          capabilities: caps,
          state: reachable ? 'ready' : 'not-answering', observedAt: now,
          ...(reachable
            ? {}
            : { failureReason: `addon installed${install.enabled ? '' : ' but NOT enabled'}; the editor is not answering — is it running with the project open?` }),
          ...(client && reachable ? {} : {}),
        })
      }
    }
  }

  // ── godot LSP (editor language server) ────────────────────────────────────
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

  // ── godot DAP (editor debug adapter) ──────────────────────────────────────
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

/** One line per provider — the status/doctor projection. */
export function renderProviderRows(rows: GodotProviderRow[]): string[] {
  return rows.map(r =>
    `${r.id}: ${r.state}${r.failureReason ? ` — ${r.failureReason}` : ''} · ${r.endpoint} · ${r.capabilities.join('/')}`,
  )
}
