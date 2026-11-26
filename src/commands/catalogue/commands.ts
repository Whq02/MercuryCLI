import { createRequire } from 'node:module'
import { memoize } from 'lodash-es'
import type { Command, CommandSeat, PromptCommand } from './command.js'
import { getCommandName } from './command.js'
import { isCommandEnabled } from './enablement.js'
import verify from '../verify/index.js'
import advise from '../advise/index.js'
import swarm from '../swarm/index.js'
import swarmchat from '../swarmchat/index.js'
import general from '../general/index.js'
import team from '../team/index.js'
import whisper from '../whisper/index.js'
import agents from '../agents/index.js'
import clear from '../clear/index.js'
import caching from '../caching/index.js'
import compact from '../compact/index.js'
import config from '../config/index.js'
import copy from '../copy/index.js'
import { context, contextNonInteractive } from '../context/index.js'
import { mission, missionNonInteractive } from '../mission/index.js'
import crew from '../crew/index.js'
import critter from '../critter/index.js'
import bootmenu from '../bootmenu/index.js'
import concourse from '../concourse/index.js'
import run from '../run/index.js'
import browser from '../browser/index.js'
import samples from '../samples/index.js'
import sessions from '../sessions/index.js'
import trace from '../trace/index.js'
import { kill, unkill } from '../kill/index.js'
import diff from '../diff/index.js'
import health from '../health/index.js'
import lsp from '../lsp/index.js'
import effort from '../effort/index.js'
import zen from '../zen/index.js'
import browse from '../browse/index.js'
import exit from '../exit/index.js'
import help from '../help/index.js'
import keybindings from '../keybindings/index.js'
import keys from '../keys/index.js'
import mcp from '../mcp/index.js'
import memory from '../memory/index.js'
import model from '../model/index.js'
import extensions from '../extensions/index.js'
import updateNotes from '../update-notes/index.js'
import rename from '../rename/index.js'
import title from '../title/index.js'
import skills from '../skills/index.js'
import feedback from '../feedback/index.js'
import review from '../review/index.js'
import rewind from '../rewind/index.js'
import audit from '../audit/index.js'
import keysetup from '../keysetup/index.js'
import usage from '../usage/index.js'
import jev from '../jev/index.js'
import localsetup from '../localsetup/index.js'
import imagesetup from '../imagesetup/index.js'
import llmhost from '../llmhost/index.js'
import tensorfold from '../tensorfold/index.js'
import defaultprovider from '../defaultprovider/index.js'
import vim from '../vim/index.js'
import permissions from '../permissions/index.js'
import hooks from '../hooks/index.js'
import exportCommand from '../export/index.js'
import logout from '../logout/index.js'
import loginFactory from '../logins/index.js'
import tasks from '../runs/index.js'
import appearance from '../appearance/index.js'
import mouse from '../mouse/index.js'
import capabilities from '../capabilities/index.js'
import workbench from '../workbench/index.js'
import daemon from '../daemon/index.js'
import saturn from '../saturn/index.js'
import seats from '../seats/index.js'
import accounts from '../accounts/index.js'
import crewmates from '../crewmates/index.js'
import submodels from '../submodels/index.js'
import palette from '../palette/index.js'
import orient from '../orient/index.js'
import voice from '../voice/index.js'
import restart from '../restart/index.js'
import { getBundledSkills } from '../../integrations/skills/bundledSkills.js'
import { isKitGovernedSkillCommand, kitDropsCommand, noteBootSkillRoster, withKitSkillMark } from '../../integrations/skills/kitGovernance.js'
import { sessionKitOf } from '../../integrations/mcp/sessionKitPin.js'
import {
  clearSkillCaches,
  getDynamicSkills,
  getSkillDirCommands,
} from '../../integrations/skills/loadSkillsDir.js'
import { isClaudeAISubscriber } from '../../models/sign-in/credentials/auth.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logError } from '../../platform/logs/errorLog.js'
import { isFirstPartyAnthropicBaseUrl } from '../../models/facts/providers.js'
import { anyProviderCredentialed } from '../../models/roads/providerUsage.js'
import { clearExtensionCommandCaches, getExtensionCommands, getExtensionSkills } from '../../integrations/extensions/load/commands.js'
import { getSourceDisplayName } from '../../platform/settings/settingSources.js'

export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  CommandSeat,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './command.js'
export { getCommandName, runsPromptWithArgs } from './command.js'
export { commandOffInPlainWorld, isCommandEnabled } from './enablement.js'
import { tellSessionStorageTheBuiltInCommands } from '../../sessions/transcripts/builtInCommands.js'
import { passedOver } from '../../platform/errors/passedOver.js'
const require = createRequire(import.meta.url)

const clearSkillIndexCache: (() => void) | undefined = (() => {
  try {
    const mod: { clearSkillIndexCache?: () => void } = require('../../integrations/skill-search/localSearch.js')
    return typeof mod.clearSkillIndexCache === 'function' ? mod.clearSkillIndexCache : undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
})()

const COMMANDS = memoize((): Command[] => [
  verify,
  advise,
  swarm,
  swarmchat,
  general,
  team,
  whisper,
  agents,
  clear,
  compact,
  config,
  copy,
  context,
  contextNonInteractive,
  mission,
  missionNonInteractive,
  crew,
  critter,
  bootmenu,
  concourse,
  run,
  browser,
  samples,
  sessions,
  trace,
  kill,
  unkill,
  diff,
  health,
  lsp,
  effort,
  zen,
  browse,
  exit,
  help,
  keybindings,
  keys,
  mcp,
  memory,
  model,
  extensions,
  updateNotes,
  rename,
  skills,
  title,
  feedback,
  review,
  rewind,
  audit,
  keysetup,
  usage,
  jev,
  localsetup,
  imagesetup,
  llmhost,
  tensorfold,
  defaultprovider,
  vim,
  permissions,
  hooks,
  exportCommand,
  logout,
  loginFactory(),
  tasks,
  appearance,
  mouse,
  capabilities,
  caching,
  workbench,
  daemon,
  saturn,
  seats,
  accounts,
  crewmates,
  submodels,
  palette,
  orient,
  voice,
  restart,
])

export function commandSeat(command: Command): CommandSeat {
  if (command.type === 'local-jsx') return 'screen'
  if (
    command.type === 'local' &&
    (command.uiRouteAlias !== undefined || command.seat === 'screen' || command.userPrivate === true)
  ) {
    return 'screen'
  }
  return 'session'
}

export function sessionSeatCommandTable(commands: readonly Command[]): Command[] {
  return commands.filter(
    command =>
      commandSeat(command) === 'session' ||
      (command.type === 'local-jsx' &&
        ((command.headlessVerbs?.length ?? 0) > 0 || command.promptWithArgs === true)),
  )
}

export function builtinCommands(): readonly Command[] {
  return COMMANDS()
}

export const builtInCommandNames = memoize((): Set<string> => {
  const names = new Set<string>()
  for (const command of COMMANDS()) {
    names.add(command.name)
    for (const alias of command.aliases ?? []) {
      names.add(alias)
    }
  }
  return names
})
tellSessionStorageTheBuiltInCommands(builtInCommandNames)

export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability || cmd.availability.length === 0) return true
  return cmd.availability.some(req => {
    switch (req) {
      case 'claude-ai':
        return isClaudeAISubscriber()
      case 'console':
        return !isClaudeAISubscriber() && isFirstPartyAnthropicBaseUrl()
      case 'any-provider-credential':
        return anyProviderCredentialed()
      default:
        return false
    }
  })
}

const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  let skillCommands: Command[] = []
  let extensionCommands: Command[] = []
  let extensionSkills: Command[] = []
  try {
    skillCommands = await getSkillDirCommands(cwd).catch((error: unknown) => {
      logError(error)
      logForDebugging('skill loading failed; continuing without skill commands')
      return [] as Command[]
    })
    try {
      extensionCommands = getExtensionCommands()
      extensionSkills = getExtensionSkills()
    } catch (error) {
      logError(error)
      logForDebugging('extension command loading failed; continuing without extension commands')
    }
  } catch (error) {
    logError(error)
    logForDebugging('command source loading failed; continuing with built-ins only')
    skillCommands = []
    extensionCommands = []
    extensionSkills = []
  }
  logForDebugging(
    `loaded command sources: ${skillCommands.length} skill commands, ${extensionCommands.length} extension commands, ${extensionSkills.length} extension skills`,
  )

  const builtinNames = builtInCommandNames()
  const dropBuiltinShadows = (commands: Command[], sourceLabel: string): Command[] =>
    commands.filter(command => {
      if (!builtinNames.has(command.name)) return true
      logForDebugging(
        `custom command /${command.name} (${sourceLabel}) collides with a built-in name or alias — dropped; built-ins are not shadowable`,
      )
      return false
    })

  return [
    ...getBundledSkills().filter(command => !builtinNames.has(command.name)),
    ...dropBuiltinShadows(skillCommands, 'skill directory'),
    ...dropBuiltinShadows(extensionCommands, 'extension command'),
    ...dropBuiltinShadows(extensionSkills, 'extension skill'),
    ...COMMANDS(),
  ]
})

function dedupeCommandsByName(commands: Command[]): Command[] {
  const byName = new Map<string, Command>()
  const deduped: Command[] = []
  for (const command of commands) {
    const winner = byName.get(command.name)
    if (winner) {
      const bothCustom = winner.source !== undefined && command.source !== undefined
      const collisionLine = `slash command collision on /${command.name}: the ${String(command.source)} copy is shadowed by the ${String(winner.source)} entry`
      if (bothCustom) {
        logError(new Error(collisionLine))
      } else if (winner.source !== command.source) {
        logForDebugging(collisionLine)
      }
      continue
    }
    byName.set(command.name, command)
    deduped.push(command)
  }
  return deduped
}

function readyCommands(
  commands: readonly Command[],
  kit: ReturnType<typeof sessionKitOf>,
): Command[] {
  return commands
    .filter(
      command =>
        meetsAvailabilityRequirement(command) &&
        isCommandEnabled(command) &&
        !kitDropsCommand(kit, command),
    )
    .map(command => withKitSkillMark(kit, command))
}

function displacedBundledSkills(): Command[] {
  const builtinNames = builtInCommandNames()
  return readyCommands(
    getBundledSkills().filter(command => builtinNames.has(command.name)),
    sessionKitOf(),
  )
}

export function findBundledPromptSkill(name: string): PromptCommand | undefined {
  const found = displacedBundledSkills().find(command => command.name === name && command.type === 'prompt')
  return found !== undefined && found.type === 'prompt' ? found : undefined
}

export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)
  const kit = sessionKitOf()
  if (kit !== undefined) {
    const builtinNames = builtInCommandNames()
    const displaced = getBundledSkills().filter(command => builtinNames.has(command.name))
    noteBootSkillRoster([...displaced, ...allCommands].filter(isKitGovernedSkillCommand).map(command => command.name))
  }
  const base = dedupeCommandsByName(readyCommands(allCommands, kit))
  const dynamicSkills = getDynamicSkills()
  if (dynamicSkills.length === 0) return base
  const baseNames = new Set(base.map(command => command.name))
  const builtinNames = builtInCommandNames()
  const survivors = readyCommands(
    dynamicSkills.filter(command => !baseNames.has(command.name) && !builtinNames.has(command.name)),
    kit,
  )
  if (survivors.length === 0) return base
  const firstBuiltinIndex = base.findIndex(command => command.source === 'builtin')
  if (firstBuiltinIndex === -1) return [...base, ...survivors]
  return [...base.slice(0, firstBuiltinIndex), ...survivors, ...base.slice(firstBuiltinIndex)]
}

export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache.clear?.()
  getSkillToolCommands.cache.clear?.()
  getSlashCommandToolSkills.cache.clear?.()
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearExtensionCommandCaches()
  clearSkillCaches()
}

export function getMcpSkillCommands(
  _mcpCommands: readonly Command[],
): readonly Command[] {
  return []
}

export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const commands = [...displacedBundledSkills(), ...(await getCommands(cwd)).filter(command => command.type === 'prompt')]
    return commands.filter(
      command =>
        command.type === 'prompt' &&
        command.source !== 'builtin' &&
        !command.disableModelInvocation &&
        (command.loadedFrom === 'bundled' ||
          command.loadedFrom === 'skills' ||
          command.hasUserSpecifiedDescription === true ||
          Boolean(command.whenToUse)),
    )
  },
)

export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const commands = [...displacedBundledSkills(), ...(await getCommands(cwd)).filter(command => command.type === 'prompt')]
      return commands.filter(
        command =>
          command.type === 'prompt' &&
          command.source !== 'builtin' &&
          (command.hasUserSpecifiedDescription === true || Boolean(command.whenToUse)) &&
          (command.loadedFrom === 'skills' ||
            command.loadedFrom === 'extension' ||
            command.loadedFrom === 'bundled' ||
            command.disableModelInvocation === true),
      )
    } catch (error) {
      logError(error)
      logForDebugging('slash-command tool skill listing failed; returning none')
      return []
    }
  },
)

export function findCommand(
  name: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    command =>
      command.name === name ||
      getCommandName(command) === name ||
      command.aliases?.includes(name),
  )
}

export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') return cmd.description
  const base = cmd.menuDescription ?? cmd.description
  if (cmd.source === 'extension') {
    const owner = cmd.extensionInfo?.manifest.name
    return owner ? `(${owner}) ${base}` : `${base} (extension)`
  }
  if (cmd.source === 'builtin' || cmd.source === 'mcp') return base
  if (cmd.source === 'bundled') return `${base} (built-in)`
  return `${base} (${getSourceDisplayName(cmd.source)})`
}
