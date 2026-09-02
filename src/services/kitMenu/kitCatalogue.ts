import { getActiveSet, publishActiveSet, type ActiveExtension } from '../../extensions/active.js'
import { clearExtensionCommandCaches, getExtensionSkills } from '../../extensions/load/commands.js'
import { contributionCounts, parseServerRuntimeName, type ExtensionManifest } from '../../extensions/manifest.js'
import { clearSkillCaches, getSkillDirCommands, getSkillLoadRefusals, type SkillLoadRefusal } from '../../skills/loadSkillsDir.js'
import type { Command } from '../../types/command.js'
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js'
import { clearClaudeAIMcpConfigsCache } from '../mcp/claudeai.js'
import { getAllMcpConfigs } from '../mcp/config.js'
import type { ScopedMcpServerConfig } from '../mcp/types.js'
import type { KitCatalogue, KitRow } from './kitTypes.js'

export const IDE_CLIENT_NAME = 'ide'

export const MCP_SKILLS_NOTE = 'skills from MCP servers appear once a session connects them'

export interface KitDoors {
  mcpConfigs: () => Promise<{ servers: Record<string, ScopedMcpServerConfig> }>
  dirSkills: (cwd: string) => Promise<readonly Command[]>
  extensionSkills: () => readonly Command[]
  activeExtensions: () => ReadonlyArray<Pick<ActiveExtension, 'manifest'>>
  skillRefusals?: () => readonly SkillLoadRefusal[]
}

export const REAL_KIT_DOORS: KitDoors = {
  mcpConfigs: () => getAllMcpConfigs(),
  dirSkills: cwd => getSkillDirCommands(cwd),
  extensionSkills: () => getExtensionSkills(),
  activeExtensions: () => getActiveSet().active,
  skillRefusals: () => getSkillLoadRefusals(),
}

export function refusedSkillNote(refusal: SkillLoadRefusal, cwd: string): string {
  const file = refusal.path.startsWith(cwd) ? refusal.path.slice(cwd.length).replace(/^[\\/]/, '') : refusal.path
  const reason = refusal.error.split('\n')[0]?.trim() ?? refusal.error
  return `refused: ${file} (${refusal.source}) — ${reason}`
}

export function shadowedSkillNote(name: string, winner: string, shadowed: readonly string[]): string {
  const losers = shadowed.map(copy => `the ${copy}`)
  const list = losers.length === 1 ? losers[0]! : `${losers.slice(0, -1).join(', ')} and ${losers[losers.length - 1]!}`
  return `shadowed: ${name} — the ${winner} loads; ${list} ${losers.length === 1 ? 'stays' : 'stay'} on disk unused (rename one)`
}

function skillCopyWords(command: Command): string {
  return `${skillSourceWords(command)} ${command.loadedFrom === 'legacy-commands' ? 'legacy command' : 'skill'}`
}

export function refreshKitCatalogueDoors(): void {
  clearSkillCaches()
  clearExtensionCommandCaches()
  clearClaudeAIMcpConfigsCache()
  publishActiveSet(null)
}

export async function enumerateKitCatalogueFresh(cwd: string, doors: KitDoors = REAL_KIT_DOORS): Promise<KitCatalogue> {
  if (doors === REAL_KIT_DOORS) refreshKitCatalogueDoors()
  return enumerateKitCatalogue(cwd, doors)
}

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

export async function enumerateKitCatalogue(cwd: string, doors: KitDoors = REAL_KIT_DOORS): Promise<KitCatalogue> {
  const [{ servers }, dirSkills] = await Promise.all([doors.mcpConfigs(), doors.dirSkills(cwd)])
  const extensionSkills = doors.extensionSkills()
  const extensions = doors.activeExtensions()

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

  const skillPlain: KitRow[] = []
  const shadowed = new Map<string, { winner: string; losers: string[] }>()
  for (const command of dirSkills.filter(isLoaderSkill)) {
    const seen = shadowed.get(command.name)
    if (seen !== undefined) {
      seen.losers.push(skillCopyWords(command))
      continue
    }
    shadowed.set(command.name, { winner: skillCopyWords(command), losers: [] })
    skillPlain.push({ kind: 'skill', section: 'skill', name: command.name, source: skillSourceWords(command), extension: null })
  }
  const skillNotes: KitRow[] = []
  for (const [name, { winner, losers }] of shadowed) {
    if (losers.length > 0) skillNotes.push({ kind: 'note', section: 'skill', text: shadowedSkillNote(name, winner, losers) })
  }
  for (const refusal of doors.skillRefusals?.() ?? []) {
    skillNotes.push({ kind: 'note', section: 'skill', text: refusedSkillNote(refusal, cwd) })
  }
  const skillByExtension = new Map<string, KitRow[]>()
  for (const command of extensionSkills) {
    if (command.type !== 'prompt' || command.loadedFrom !== 'extension') continue
    const owner = command.extensionInfo?.manifest.name ?? null
    if (owner === null) continue
    const list = skillByExtension.get(owner) ?? []
    list.push({ kind: 'skill', section: 'skill', name: command.name, source: `${owner} extension`, extension: owner })
    skillByExtension.set(owner, list)
  }

  const rows: KitRow[] = [...mcpPlain]
  const skillRows: KitRow[] = [...skillPlain]
  for (const ext of extensions) {
    const name = ext.manifest.name
    const contributes = contributesWords(ext.manifest)
    const itsServers = mcpByExtension.get(name) ?? []
    const itsSkills = skillByExtension.get(name) ?? []
    if (itsServers.length > 0) rows.push({ kind: 'extension', section: 'mcp', name, contributes }, ...itsServers)
    if (itsSkills.length > 0 || itsServers.length === 0) skillRows.push({ kind: 'extension', section: 'skill', name, contributes }, ...itsSkills)
  }
  for (const [owner, list] of mcpByExtension) if (!extensions.some(e => e.manifest.name === owner)) rows.push(...list)
  for (const [owner, list] of skillByExtension) if (!extensions.some(e => e.manifest.name === owner)) skillRows.push(...list)

  rows.push(...skillRows)
  rows.push(...skillNotes)
  rows.push({ kind: 'note', section: 'skill', text: MCP_SKILLS_NOTE })
  return { rows }
}
