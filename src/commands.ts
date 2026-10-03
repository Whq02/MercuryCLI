import { createRequire } from 'node:module'
import { memoize } from 'lodash-es'
import type { Command, CommandSeat } from './types/command.js'
import { getCommandName } from './types/command.js'
import { isCommandEnabled } from './commands/enablement.js'
import verify from './commands/verify.js'
import advise from './commands/advise/index.js'
import agents from './commands/agents/index.js'
import branch from './commands/branch/index.js'
import branches from './commands/branches/index.js'
import counsel from './commands/counsel/index.js'
import clear from './commands/clear/index.js'
import caching from './commands/caching/index.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import contractCommand from './commands/contract/index.js'
import copy from './commands/copy/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import { mission, missionNonInteractive } from './commands/mission/index.js'
import autoCompactWindow from './commands/auto-compact-window/index.js'
import crew from './commands/crew/index.js'
import debrief from './commands/debrief/index.js'
import halt from './commands/halt/index.js'
import critter from './commands/critter/index.js'
import view from './commands/view/index.js'
import bootmenu from './commands/bootmenu/index.js'
import concourse from './commands/concourse/index.js'
import cockpit from './commands/cockpit/index.js'
import ledger from './commands/ledger/index.js'
import run from './commands/run/index.js'
import fleet from './commands/fleet/index.js'
import monitor from './commands/monitor/index.js'
import home from './commands/home/index.js'
import manager from './commands/manager/index.js'
import policy from './commands/policy/index.js'
import browser from './commands/browser/index.js'
import provenance from './commands/provenance/index.js'
import samples from './commands/samples/index.js'
import sessions from './commands/sessions/index.js'
import sessiontab from './commands/sessiontab/index.js'
import substrate from './commands/substrate/index.js'
import trace from './commands/trace/index.js'
import { kill, unkill } from './commands/kill/index.js'
import diff from './commands/diff/index.js'
import health from './commands/health/index.js'
import effort from './commands/effort/index.js'
import exit from './commands/exit/index.js'
import help from './commands/help/index.js'
import init from './commands/init.js'
import keybindings from './commands/keybindings/index.js'
import keys from './commands/keys/index.js'
import mcp from './commands/mcp/index.js'
import memory from './commands/memory/index.js'
import model from './commands/model/index.js'
import extensions from './commands/extensions/index.js'
import updateNotes from './commands/update-notes/index.js'
import rename from './commands/rename/index.js'
import title from './commands/title/index.js'
import resume from './commands/resume/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import feedback from './commands/feedback/index.js'
import review from './commands/review.js'
import rewind from './commands/rewind/index.js'
import audit from './commands/audit/index.js'
import keysetup from './commands/keysetup/index.js'
import usage from './commands/usage/index.js'
import jev from './commands/jev/index.js'
import jevor from './commands/jevor/index.js'
import localsetup from './commands/localsetup/index.js'
import defaultprovider from './commands/defaultprovider/index.js'
import vim from './commands/vim/index.js'
import permissions from './commands/permissions/index.js'
import hooks from './commands/hooks/index.js'
import exportCommand from './commands/export/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import logout from './commands/logout/index.js'
import loginFactory from './commands/login/index.js'
import tasks from './commands/tasks/index.js'
import appearance from './commands/appearance/index.js'
import workflows from './commands/workflows/index.js'
import subagents from './commands/subagents/index.js'
import accent from './commands/accent/index.js'
import authority from './commands/authority/index.js'
import mouse from './commands/mouse/index.js'
import showcase from './commands/showcase/index.js'
import fullscreen from './commands/fullscreen/index.js'
import capabilities from './commands/capabilities/index.js'
import harness from './commands/harness/index.js'
import workbench from './commands/workbench/index.js'
import router from './commands/router/index.js'
import daemon from './commands/daemon/index.js'
import saturn from './commands/saturn/index.js'
import seats from './commands/seats/index.js'
import realms from './commands/realms/index.js'
import accounts from './commands/accounts/index.js'
import agentForm from './commands/agent-form/index.js'
import crewmates from './commands/crewmates/index.js'
import consoleCommand from './commands/console/index.js'
import submodels from './commands/submodels/index.js'
import supervisor from './commands/supervisor/index.js'
import palette from './commands/palette/index.js'
import capabilitiesDetail from './commands/capabilities-detail/index.js'
import orient from './commands/orient/index.js'
import live from './commands/live/index.js'
import sovereign from './commands/sovereign/index.js'
import speak from './commands/speak/index.js'
import voice from './commands/voice/index.js'
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
import { getInitialSettings } from './utils/settings/settings.js'

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

const require = createRequire(import.meta.url)

async function loadWorkflowCommands(): Promise<Command[]> {
  try {
    const factory = await import('./tools/WorkflowTool/createWorkflowCommand.js')
    return await factory.getWorkflowCommands()
  } catch (error) {
    logError(error)
    logForDebugging('workflow command loading failed; continuing without workflow commands')
    return []
  }
}

const clearSkillIndexCache: (() => void) | null = (() => {
  try {
    const searchModule = require('./services/skillSearch/localSearch.js') as {
      clearSkillIndexCache?: () => void
    }
    return searchModule.clearSkillIndexCache ?? null
  } catch {
    return null
  }
})()

const COMMANDS = memoize((): Command[] => [
  verify,
  advise,
  agents,
  branch,
  branches,
  counsel,
  clear,
  compact,
  config,
  contractCommand,
  copy,
  context,
  contextNonInteractive,
  mission,
  missionNonInteractive,
  autoCompactWindow,
  crew,
  debrief,
  halt,
  critter,
  view,
  bootmenu,
  concourse,
  cockpit,
  ledger,
  run,
  fleet,
  monitor,
  home,
  manager,
  policy,
  browser,
  provenance,
  samples,
  sessions,
  sessiontab,
  substrate,
  trace,
  kill,
  unkill,
  diff,
  health,
  effort,
  exit,
  help,
  init,
  keybindings,
  keys,
  mcp,
  memory,
  model,
  extensions,
  updateNotes,
  rename,
  resume,
  skills,
  status,
  title,
  feedback,
  review,
  rewind,
  audit,
  keysetup,
  usage,
  jev,
  jevor,
  localsetup,
  defaultprovider,
  vim,
  permissions,
  hooks,
  exportCommand,
  sandboxToggle,
  logout,
  loginFactory(),
  tasks,
  appearance,
  workflows,
  subagents,
  accent,
  authority,
  mouse,
  showcase,
  fullscreen,
  capabilities,
  harness,
  caching,
  workbench,
  router,
  daemon,
  saturn,
  seats,
  realms,
  accounts,
  agentForm,
  crewmates,
  consoleCommand,
  submodels,
  supervisor,
  palette,
  capabilitiesDetail,
  orient,
  live,
  sovereign,
  speak,
  voice,
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
  return commands.filter(command => commandSeat(command) === 'session')
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

export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability || cmd.availability.length === 0) {
    return true
  }
  return cmd.availability.some(requirement => {
    switch (requirement) {
      case 'claude-ai':
        return isClaudeAISubscriber()
      case 'console':
        return (
          !isClaudeAISubscriber() &&
          isFirstPartyAnthropicBaseUrl()
        )
      case 'any-provider-credential':
        return anyProviderCredentialed()
      default:
        requirement satisfies never
        return false
    }
  })
}

const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  let skillCommands: Command[] = []
  let workflowCommands: Command[] = []
  let extensionCommands: Command[] = []
  let extensionSkills: Command[] = []
  try {
    ;[skillCommands, workflowCommands] = await Promise.all([
      getSkillDirCommands(cwd).catch((error: unknown) => {
        logError(error)
        logForDebugging('skill loading failed; continuing without skill commands')
        return [] as Command[]
      }),
      loadWorkflowCommands(),
    ])
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
    workflowCommands = []
    extensionCommands = []
    extensionSkills = []
  }
  logForDebugging(
    `loaded command sources: ${skillCommands.length} skill commands, ${workflowCommands.length} workflow commands, ${extensionCommands.length} extension commands, ${extensionSkills.length} extension skills`,
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
    ...dropBuiltinShadows(workflowCommands, 'workflow'),
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
  const loaded = await loadAllCommands(cwd)
  const kit = sessionKitOf()
  if (kit !== undefined) {
    noteBootSkillRoster(loaded.filter(isKitGovernedSkillCommand).map(command => command.name))
  }
  const base = dedupeCommandsByName(
    loaded
      .filter(
        command =>
          meetsAvailabilityRequirement(command) &&
          isCommandEnabled(command) &&
          !kitDropsCommand(kit, command),
      )
      .map(command => withKitSkillMark(kit, command)),
  )
  const dynamicSkills = getDynamicSkills()
  if (dynamicSkills.length === 0) {
    return base
  }
  const surviving = dynamicSkills
    .filter(
      command =>
        meetsAvailabilityRequirement(command) &&
        isCommandEnabled(command) &&
        !base.some(existing => existing.name === command.name) &&
        !builtInCommandNames().has(command.name) &&
        !kitDropsCommand(kit, command),
    )
    .map(command => withKitSkillMark(kit, command))
  if (surviving.length === 0) {
    return base
  }
  const firstBuiltinIndex = base.findIndex(command => command.source === 'builtin')
  if (firstBuiltinIndex === -1) {
    return [...base, ...surviving]
  }
  return [
    ...base.slice(0, firstBuiltinIndex),
    ...surviving,
    ...base.slice(firstBuiltinIndex),
  ]
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
  mcpCommands: readonly Command[],
): readonly Command[] {
  void mcpCommands
  return []
}

export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const commands = await getCommands(cwd)
    return commands.filter(
      command =>
        command.type === 'prompt' &&
        command.disableModelInvocation !== true &&
        command.source !== 'builtin' &&
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
      const commands = await getCommands(cwd)
      return commands.filter(
        command =>
          command.type === 'prompt' &&
          command.source !== 'builtin' &&
          (command.hasUserSpecifiedDescription === true ||
            Boolean(command.whenToUse)) &&
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
      (command.aliases?.includes(name) ?? false),
  )
}

export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }
  const description = cmd.menuDescription ?? cmd.description
  if (cmd.kind === 'workflow') {
    return `${description} (workflow)`
  }
  if (cmd.source === 'extension') {
    const owner = cmd.extensionInfo?.manifest.name
    return owner ? `(${owner}) ${description}` : `${description} (extension)`
  }
  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return description
  }
  if (cmd.source === 'bundled') {
    return `${description} (built-in)`
  }
  return `${description} (${getSourceDisplayName(cmd.source)})`
}
