// ============================================================================
//  src/extensions/reload.ts — the in-session swap (04 §4). `r` on the
//  board, `/extensions reload`, the reload the board offers after a change,
//  and the boot load all come here:
//
//    1. recompute the roster from disk (records, project folder, project
//       settings, the flag, bundled);
//    2. compute health for every switched-on extension;
//    3. swap the active set inside the running session, in this order:
//       skills/commands catalogue · agents catalogue · hooks (atomic) ·
//       servers (the reconnect key re-runs the connection effects) ·
//       language servers (re-initialised) · channels · keybindings;
//    4. publish the snapshot the roster's pending state compares against
//       and settle first loads (the previous folder goes after a clean load).
//
//  The swap never blocks the composer; a reload with no changes is a no-op
//  that still repaints health.
// ============================================================================
import { clearAgentDefinitionsCache } from '../tools/AgentTool/loadAgentsDir.js'
import { clearCommandMemoizationCaches } from '../commands.js'
import { reinitializeLspServerManager } from '../services/lsp/manager.js'
import { invalidateKeybindingsCache } from '../keybindings/loadUserBindings.js'
import { logForDebugging } from '../utils/debug.js'
import { computeActiveSet, publishActiveSet, type ActiveSet } from './active.js'
import { settleFirstLoad } from './install.js'
import { clearExtensionAgentCache } from './load/agents.js'
import { clearExtensionCommandCaches, getExtensionCommands, getExtensionSkills } from './load/commands.js'
import { loadExtensionHooks } from './load/hooks.js'
import { clearExtensionLspServerCache, getExtensionLspServers } from './load/language.js'
import { clearExtensionMcpServerCache, getExtensionMcpServers } from './load/servers.js'
import { activeEntries, setActiveSnapshot, type ActiveSnapshot } from './roster.js'

export type ReloadCounts = {
  on: number
  partial: number
  broken: number
  off: number
  skills: number
  commands: number
  agents: number
  hooks: number
  servers: number
  language: number
  channels: number
  keybindings: number
}

export type ReloadResult = { set: ActiveSet; counts: ReloadCounts; line: string }

/** The transcript line after a reload: the counts, nothing else. */
export function reloadLine(counts: ReloadCounts): string {
  const parts = [
    `${counts.on} on`,
    `${counts.partial} partial`,
    `${counts.broken} broken`,
    `${counts.skills} skill${counts.skills === 1 ? '' : 's'}`,
    `${counts.agents} agent${counts.agents === 1 ? '' : 's'}`,
    `${counts.hooks} hook${counts.hooks === 1 ? '' : 's'}`,
    `${counts.servers} server${counts.servers === 1 ? '' : 's'}`,
  ]
  return `extensions: ${parts.join(' · ')}`
}

let reloading: Promise<ReloadResult> | null = null

/**
 * The swap. `onServersChanged` bumps the MCP reconnect key in app state
 * (absent in a headless CLI, where there is nothing to reconnect).
 */
export async function reloadExtensions(options: { cwd?: string; onServersChanged?: () => void } = {}): Promise<ReloadResult> {
  if (reloading) return reloading
  reloading = (async () => {
    try {
      // 1 + 2: the roster and health, from disk.
      const set = computeActiveSet({ cwd: options.cwd })
      // 3: the swap, in order. Publishing the set first means every catalogue
      // rebuilt below reads the SAME snapshot.
      publishActiveSet(set)
      clearExtensionCommandCaches()
      clearCommandMemoizationCaches()
      const skills = getExtensionSkills()
      const commands = getExtensionCommands()
      clearExtensionAgentCache()
      clearAgentDefinitionsCache()
      const hooks = loadExtensionHooks()
      clearExtensionMcpServerCache()
      const servers = getExtensionMcpServers()
      options.onServersChanged?.()
      clearExtensionLspServerCache()
      const language = getExtensionLspServers()
      reinitializeLspServerManager()
      invalidateKeybindingsCache()
      // 4: the snapshot and the first-load settlement. The snapshot is what
      // the swap CONSIDERED — every entry wanted by its records and
      // unshadowed, whether it loads, loads partially or is broken. A
      // broken-but-wanted copy is the session's truth too (its row reads
      // ✕ broken); a snapshot of the loaded set alone made the next roster
      // read see "wanted, not live" and paint ◐ reload forever.
      const snapshot: ActiveSnapshot = new Map()
      for (const entry of activeEntries(set.roster.entries)) snapshot.set(entry.id, { version: entry.version, contributionsHash: entry.contributionsHash ?? '' })
      setActiveSnapshot(snapshot)
      for (const entry of set.roster.entries) {
        if (entry.record?.pendingFirstLoad && entry.home === 'installed') {
          const health = set.healthById.get(entry.id)
          settleFirstLoad(entry.id, health?.outcome === 'broken')
        }
      }
      let on = 0
      let partial = 0
      let broken = 0
      let off = 0
      let channels = 0
      let keybindings = 0
      for (const [, health] of set.healthById) {
        if (health === null) off++
        else if (health.outcome === 'loads') on++
        else if (health.outcome === 'partial') partial++
        else broken++
      }
      for (const ext of set.active) {
        channels += ext.switches.channels ? ext.resolution.channels.length : 0
        keybindings += ext.switches.keybindings ? ext.resolution.keybindings.filter(k => !k.taken).length : 0
      }
      const agents = (await import('./load/agents.js')).getExtensionAgents().length
      const counts: ReloadCounts = {
        on,
        partial,
        broken,
        off,
        skills: skills.length,
        commands: commands.length,
        agents,
        hooks: hooks.hookCount,
        servers: Object.keys(servers).length,
        language: Object.keys(language).length,
        channels,
        keybindings,
      }
      const line = reloadLine(counts)
      logForDebugging(line)
      return { set, counts, line }
    } finally {
      reloading = null
    }
  })()
  return reloading
}

/** The boot load: the same swap, run once before the first render and the SessionStart hooks. */
export async function bootExtensions(options: { cwd?: string } = {}): Promise<ReloadResult> {
  return reloadExtensions(options)
}
