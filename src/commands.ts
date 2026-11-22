import { createRequire } from 'node:module'
import { memoize } from 'lodash-es'
import type { Command, CommandSeat } from './types/command.js'
import { getCommandName } from './types/command.js'
import { isCommandEnabled } from './commands/enablement.js'
import verify from './commands/verify.js'
import advise from './commands/advise/index.js'
import swarm from './commands/swarm/index.js'
import swarmchat from './commands/swarmchat/index.js'
import general from './commands/general/index.js'
import team from './commands/team/index.js'
import whisper from './commands/whisper/index.js'
import agents from './commands/agents/index.js'
import clear from './commands/clear/index.js'
import caching from './commands/caching/index.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import contractCommand from './commands/contract/index.js'
import copy from './commands/copy/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import { mission, missionNonInteractive } from './commands/mission/index.js'
import crew from './commands/crew/index.js'
import critter from './commands/critter/index.js'
import bootmenu from './commands/bootmenu/index.js'
import concourse from './commands/concourse/index.js'
import run from './commands/run/index.js'
import browser from './commands/browser/index.js'
import samples from './commands/samples/index.js'
import sessions from './commands/sessions/index.js'
import trace from './commands/trace/index.js'
import { kill, unkill } from './commands/kill/index.js'
import diff from './commands/diff/index.js'
import health from './commands/health/index.js'
import lsp from './commands/lsp/index.js'
import effort from './commands/effort/index.js'
import zen from './commands/zen/index.js'
import browse from './commands/browse/index.js'
import exit from './commands/exit/index.js'
import help from './commands/help/index.js'
import keybindings from './commands/keybindings/index.js'
import keys from './commands/keys/index.js'
import mcp from './commands/mcp/index.js'
import memory from './commands/memory/index.js'
import model from './commands/model/index.js'
import extensions from './commands/extensions/index.js'
import updateNotes from './commands/update-notes/index.js'
import rename from './commands/rename/index.js'
import title from './commands/title/index.js'
import skills from './commands/skills/index.js'
import feedback from './commands/feedback/index.js'
import review from './commands/review.js'
import rewind from './commands/rewind/index.js'
import audit from './commands/audit/index.js'
import keysetup from './commands/keysetup/index.js'
import usage from './commands/usage/index.js'
import jev from './commands/jev/index.js'
import localsetup from './commands/localsetup/index.js'
import imagesetup from './commands/imagesetup/index.js'
import llmhost from './commands/llmhost/index.js'
import tensorfold from './commands/tensorfold/index.js'
import defaultprovider from './commands/defaultprovider/index.js'
import vim from './commands/vim/index.js'
import permissions from './commands/permissions/index.js'
import hooks from './commands/hooks/index.js'
import exportCommand from './commands/export/index.js'
import logout from './commands/logout/index.js'
import loginFactory from './commands/login/index.js'
import tasks from './commands/tasks/index.js'
import appearance from './commands/appearance/index.js'
import mouse from './commands/mouse/index.js'
import capabilities from './commands/capabilities/index.js'
import workbench from './commands/workbench/index.js'
import daemon from './commands/daemon/index.js'
import saturn from './commands/saturn/index.js'
import seats from './commands/seats/index.js'
import accounts from './commands/accounts/index.js'
import crewmates from './commands/crewmates/index.js'
import submodels from './commands/submodels/index.js'
import palette from './commands/palette/index.js'
import orient from './commands/orient/index.js'
import voice from './commands/voice/index.js'
import restart from './commands/restart/index.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { isKitGovernedSkillCommand, kitDropsCommand, noteBootSkillRoster, withKitSkillMark } from './skills/kitGovernance.js'
import { sessionKitOf } from './services/mcp/sessionKitPin.js'
import {
  clearSkillCaches,
  getDynamicSkills,
  getSkillDirCommands,
} from './skills/loadSkillsDir.js'
import { isClaudeAISubscriber } from './utils/auth.js'
import { logForDebugging } from './utils/debug.js'
import { logError } from './utils/log.js'
import { isFirstPartyAnthropicBaseUrl } from './utils/model/providers.js'
import { anyProviderCredentialed } from './services/providers/providerUsage.js'
import { clearExtensionCommandCaches, getExtensionCommands, getExtensionSkills } from './extensions/load/commands.js'
import { getSourceDisplayName } from './utils/settings/constants.js'

export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  CommandSeat,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName } from './types/command.js'
export { commandOffInPlainWorld, isCommandEnabled } from './commands/enablement.js'
import { tellSessionStorageTheBuiltInCommands } from './utils/sessionStorage/builtInCommands.js'
import { passedOver } from './utils/passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from './pi/holes.js'

const require = createRequire(import.meta.url)

const COMMANDS: Unbuilt = unbuilt('src/commands.ts:128')

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
  return notBuilt('src/commands.ts:222')
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
  return notBuilt('src/commands.ts:242')
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
    ...getBundledSkills(),
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

export async function getCommands(cwd: string): Promise<Command[]> {
  return notBuilt('src/commands.ts:332')
}

export function clearCommandMemoizationCaches(): void {
  return notBuilt('src/commands.ts:376')
}

export function clearCommandsCache(): void {
  return notBuilt('src/commands.ts:383')
}

export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  return notBuilt('src/commands.ts:389')
}

export const getSkillToolCommands: Unbuilt = unbuilt('src/commands.ts:396')

export const getSlashCommandToolSkills: Unbuilt = unbuilt('src/commands.ts:412')

export function findCommand(
  name: string,
  commands: Command[],
): Command | undefined {
  return notBuilt('src/commands.ts:435')
}

export function formatDescriptionWithSource(cmd: Command): string {
  return notBuilt('src/commands.ts:447')
}
