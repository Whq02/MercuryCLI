// ============================================================================
//  services/kitMenu/kitCatalogue — the ENUMERATION (the operator's L24(5):
//  "all of your loaded MCPs … all of your skills"), read from the SAME doors
//  the runner resolves through, so every row's name is the spelling a
//  toggle must hit (a row whose name no door resolves is a silent no-op):
//    · MCPs — getAllMcpConfigs (the runner's own merge: enterprise · local ·
//      project (approved) · user · the extensions' `ext:<name>:<server>`
//      servers · claude.ai connectors when armed), keyed by the resolved
//      name; the `ide` client is EXCLUDED exactly as /mcp excludes it (owned
//      by /ide, never toggled — contract data).
//    · Skills — the skill loaders (getSkillDirCommands: project · user ·
//      managed homes, SKILL.md and legacy commands) + the extensions' skills
//      (getExtensionSkills: `<extension>:<skill>`). Bundled skills are
//      Mercury's own organs (Q1) and never appear. MCP-sourced skills are
//      DERIVED from a connected server — no server is connected at the Boot
//      face, so the Skills section carries the honest sentence instead of a
//      silent gap (the lead's ruling).
//    · Extensions (OPTION 2) — every active extension gets a MASTER ROW
//      above its items in each section it contributes to (an extension with
//      commands/hooks alone sits in Skills — commands ride with skills on
//      the switch); the row's words carry contributionCounts.
//  The doors are INJECTABLE (the prover feeds the doors' own output shapes
//  cpu-pure); the real doors read the config home + cwd and never spawn.
// ============================================================================
import { getActiveSet, publishActiveSet, type ActiveExtension } from '../../extensions/active.js'
import { clearExtensionCommandCaches, getExtensionSkills } from '../../extensions/load/commands.js'
import { contributionCounts, parseServerRuntimeName, type ExtensionManifest } from '../../extensions/manifest.js'
import { clearSkillCaches, getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import type { Command } from '../../types/command.js'
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js'
import { clearClaudeAIMcpConfigsCache } from '../mcp/claudeai.js'
import { getAllMcpConfigs } from '../mcp/config.js'
import type { ScopedMcpServerConfig } from '../mcp/types.js'
import type { KitCatalogue, KitRow } from './kitTypes.js'

/** /mcp's own exemption (src/commands/mcp/mcp.tsx): owned by /ide, never toggled. */
export const IDE_CLIENT_NAME = 'ide'

/** The ruled sentence for the group no face can enumerate. */
export const MCP_SKILLS_NOTE = 'skills from MCP servers appear once a session connects them'

/** The doors, in the shapes the real owners answer with. */
export interface KitDoors {
  mcpConfigs: () => Promise<{ servers: Record<string, ScopedMcpServerConfig> }>
  dirSkills: (cwd: string) => Promise<readonly Command[]>
  extensionSkills: () => readonly Command[]
  activeExtensions: () => ReadonlyArray<Pick<ActiveExtension, 'manifest'>>
}

export const REAL_KIT_DOORS: KitDoors = {
  mcpConfigs: () => getAllMcpConfigs(),
  dirSkills: cwd => getSkillDirCommands(cwd),
  extensionSkills: () => getExtensionSkills(),
  activeExtensions: () => getActiveSet().active,
}

/**
 * THE FRESHNESS DOOR (operator ruling: "a screen never shows a
 * stale list"): the real doors above answer through
 * process-lifetime memos — the per-cwd skill loader, the extension
 * skill/command catalogues, the active-extension set, the claude.ai
 * connector fetch — so a screen that enumerated once at mount kept showing
 * the FIRST boot's estate: a skill created after boot (skill-forge →
 * .mercury/skills/<name>) never appeared without a restart. This door
 * drops every one of those memos; the next enumeration re-reads the disk.
 * The CHAT session's own change-watcher clears the same skill caches on
 * real file events — this door is the SCREEN's open-time twin (and the
 * fallback for estates the watcher does not cover).
 */
export function refreshKitCatalogueDoors(): void {
  clearSkillCaches()
  clearExtensionCommandCaches()
  clearClaudeAIMcpConfigsCache()
  publishActiveSet(null)
}

/** Enumerate through FRESH doors — the screen's every-open road. Injected
 *  doors (proofs, stills, hosts) never trigger the real clears. */
export async function enumerateKitCatalogueFresh(cwd: string, doors: KitDoors = REAL_KIT_DOORS): Promise<KitCatalogue> {
  if (doors === REAL_KIT_DOORS) refreshKitCatalogueDoors()
  return enumerateKitCatalogue(cwd, doors)
}

/** The master row's plain-words census of what its off turns off. */
export function contributesWords(manifest: ExtensionManifest): string {
  const c = contributionCounts(manifest)
  const n = (count: number | undefined, one: string, many = `${one}s`): string | null =>
    count === undefined || count === 0 ? null : `${count} ${count === 1 ? one : many}`
  const parts = [
    n(c.skills, 'skill'),
    n(c.servers, 'server'),
    n(c.commands, 'command'),
    n(c.agents, 'agent'),
    c.hooks ? 'hooks' : null,
    n(c.language, 'language server'),
    c.channels ? 'channels' : null,
    c.keybindings ? 'keybindings' : null,
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(' · ') : 'nothing yet'
}

/** A loader skill: SKILL.md or a legacy command from a settings home —
 *  never a bundled organ, never an MCP-derived entry. */
function isLoaderSkill(command: Command): boolean {
  return command.type === 'prompt' && (command.loadedFrom === 'skills' || command.loadedFrom === 'legacy-commands')
}

function skillSourceWords(command: Command): string {
  const source = command.source as SettingSource | string
  switch (source) {
    case 'userSettings':
    case 'projectSettings':
    case 'localSettings':
    case 'policySettings':
    case 'flagSettings':
      return `${getSettingSourceName(source)} settings`
    default:
      return String(source)
  }
}

/** Every row the manager shows, in the ruled order (MCPs then Skills; plain
 *  rows first in door order, then each extension's master row directly
 *  above its items). Pure over the doors' answers. */
export async function enumerateKitCatalogue(cwd: string, doors: KitDoors = REAL_KIT_DOORS): Promise<KitCatalogue> {
  const [{ servers }, dirSkills] = await Promise.all([doors.mcpConfigs(), doors.dirSkills(cwd)])
  const extensionSkills = doors.extensionSkills()
  const extensions = doors.activeExtensions()

  // ── MCPs ──────────────────────────────────────────────────────────────────
  const mcpPlain: KitRow[] = []
  const mcpByExtension = new Map<string, KitRow[]>()
  for (const [name, config] of Object.entries(servers)) {
    if (name === IDE_CLIENT_NAME) continue
    const owner = config.extensionSource ? (parseServerRuntimeName(name)?.name ?? null) : null
    const row: KitRow = { kind: 'mcp', section: 'mcp', name, scope: config.scope, extension: owner }
    if (owner === null) mcpPlain.push(row)
    else {
      const list = mcpByExtension.get(owner) ?? []
      list.push(row)
      mcpByExtension.set(owner, list)
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const skillPlain: KitRow[] = dirSkills
    .filter(isLoaderSkill)
    .map(command => ({ kind: 'skill', section: 'skill', name: command.name, source: skillSourceWords(command), extension: null }))
  const skillByExtension = new Map<string, KitRow[]>()
  for (const command of extensionSkills) {
    if (command.type !== 'prompt' || command.loadedFrom !== 'extension') continue
    const owner = command.extensionInfo?.manifest.name ?? null
    if (owner === null) continue
    const list = skillByExtension.get(owner) ?? []
    list.push({ kind: 'skill', section: 'skill', name: command.name, source: `${owner} extension`, extension: owner })
    skillByExtension.set(owner, list)
  }

  // ── the extensions' master rows (Option 2) ────────────────────────────────
  const rows: KitRow[] = [...mcpPlain]
  const skillRows: KitRow[] = [...skillPlain]
  for (const ext of extensions) {
    const name = ext.manifest.name
    const contributes = contributesWords(ext.manifest)
    const itsServers = mcpByExtension.get(name) ?? []
    const itsSkills = skillByExtension.get(name) ?? []
    if (itsServers.length > 0) rows.push({ kind: 'extension', section: 'mcp', name, contributes }, ...itsServers)
    // Commands and hooks ride with skills on the extension's own switch, so
    // an extension contributing no listed item still owns a master row —
    // in Skills, where its off is the only way to turn those off.
    if (itsSkills.length > 0 || itsServers.length === 0) skillRows.push({ kind: 'extension', section: 'skill', name, contributes }, ...itsSkills)
  }
  // Extension servers/skills whose extension the active set no longer
  // names (a reload mid-read) still appear — under their own label, never
  // dropped silently.
  for (const [owner, list] of mcpByExtension) if (!extensions.some(e => e.manifest.name === owner)) rows.push(...list)
  for (const [owner, list] of skillByExtension) if (!extensions.some(e => e.manifest.name === owner)) skillRows.push(...list)

  rows.push(...skillRows)
  rows.push({ kind: 'note', section: 'skill', text: MCP_SKILLS_NOTE })
  return { rows }
}
