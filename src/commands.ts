// ============================================================================
//  src/commands.ts — the slash-command registry: the built-in roster, the
//  skill/extension/workflow merge under a fixed precedence, availability
//  filtering, lookup and description formatting.
//
//  The built-in list is produced by a memoized factory rather than a
//  module-level constant: entries consult configuration, and configuration
//  cannot be read while the module graph is still evaluating.
// ============================================================================
import { createRequire } from 'node:module'
import { memoize } from 'lodash-es'
import type { Command, CommandSeat } from './types/command.js'
import { getCommandName } from './types/command.js'
import { isCommandEnabled } from './commands/enablement.js'
import addDir from './commands/add-dir/index.js'
import verify from './commands/verify.js'
import agents from './commands/agents/index.js'
import branch from './commands/branch/index.js'
import branches from './commands/branches/index.js'
import counsel from './commands/counsel/index.js'
import clear from './commands/clear/index.js'
import caching from './commands/caching/index.js'
import color from './commands/color/index.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import contractCommand from './commands/contract/index.js'
import copy from './commands/copy/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import { mission, missionNonInteractive } from './commands/mission/index.js'
import autoCompactWindow from './commands/auto-compact-window/index.js'
import cost from './commands/cost/index.js'
import crew from './commands/crew/index.js'
import debrief from './commands/debrief/index.js'
import halt from './commands/halt/index.js'
import companion from './commands/companion/index.js'
import critter from './commands/critter/index.js'
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
import sessions from './commands/sessions/index.js'
import sessiontab from './commands/sessiontab/index.js'
import substrate from './commands/substrate/index.js'
import trace from './commands/trace/index.js'
import { kill, unkill } from './commands/kill/index.js'
import remember from './commands/remember/index.js'
import themis from './commands/themis/index.js'
import meh from './commands/meh/index.js'
import good from './commands/good/index.js'
import diff from './commands/diff/index.js'
import health from './commands/health/index.js'
import effort from './commands/effort/index.js'
import exit from './commands/exit/index.js'
import heapdump from './commands/heapdump/index.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import keybindings from './commands/keybindings/index.js'
import keys from './commands/keys/index.js'
import mcp from './commands/mcp/index.js'
import memory from './commands/memory/index.js'
import model from './commands/model/index.js'
import extensions from './commands/extensions/index.js'
import prComments from './commands/pr_comments/index.js'
import releaseNotes from './commands/release-notes/index.js'
import rename from './commands/rename/index.js'
import title from './commands/title/index.js'
import resume from './commands/resume/index.js'
import session from './commands/session/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import feedback from './commands/feedback/index.js'
import review from './commands/review.js'
import rewind from './commands/rewind/index.js'
import securityReview from './commands/security-review.js'
import terminalSetup from './commands/terminalSetup/index.js'
import mockLimits from './commands/mock-limits/index.js'
import usage from './commands/usage/index.js'
import defaultprovider from './commands/defaultprovider/index.js'
import vim from './commands/vim/index.js'
import permissions from './commands/permissions/index.js'
import pings from './commands/pings/index.js'
import plan from './commands/plan/index.js'
import hooks from './commands/hooks/index.js'
import exportCommand from './commands/export/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import logout from './commands/logout/index.js'
import loginFactory from './commands/login/index.js'
import tasks from './commands/tasks/index.js'
import team from './commands/team/index.js'
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
import cards from './commands/cards/index.js'
import tabula, { minervaCommand, noteCommand } from './commands/tabula/index.js'
import workbench from './commands/workbench/index.js'
import router from './commands/router/index.js'
import daemon from './commands/daemon/index.js'
import saturn from './commands/saturn/index.js'
import realms from './commands/realms/index.js'
import accounts from './commands/accounts/index.js'
import agentForm from './commands/agent-form/index.js'
import teammates from './commands/teammates/index.js'
import consoleCommand from './commands/console/index.js'
import submodels from './commands/submodels/index.js'
import supercode from './commands/supercode/index.js'
import supervisor from './commands/supervisor/index.js'
import palette from './commands/palette/index.js'
import capabilitiesDetail from './commands/capabilities-detail/index.js'
import orient from './commands/orient/index.js'
import { retiredMultiplayerCommands } from './commands/retired.js'
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
// Enablement is world-aware (commands/enablement.ts): every reader of the
// table takes it from here, so no reader can see a concourse-only or a
// retired command as enabled in any world.
export { commandOffInPlainWorld, commandRetired, isCommandEnabled } from './commands/enablement.js'

const require = createRequire(import.meta.url)

// The workflow-command factory loads lazily at the first command assembly
// through a dynamic import, which the bundler carries into the artifact
// (a filesystem require beside the single-file build can never resolve).
// A load failure yields an empty workflow list.
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

// The skill-search index layer is build-absent in this build (the snapshot
// carries only a type stub declaring the module tree-shaken), so this
// binding stays null and the guarded call below is a no-op by construction.
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

/**
 * The heavy insights report command is registered as a lazy shim: a
 * prompt-type command whose prompt builder dynamically imports the real
 * module on first invocation and delegates.
 */
const insightsShim = {
  type: 'prompt',
  name: 'insights',
  description: 'Analyse your recent sessions and generate a usage-insights report',
  progressMessage: 'analysing recent sessions',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const realCommand = (await import('./commands/insights.js')).default
    if (realCommand.type !== 'prompt') {
      throw new Error('insights command module did not resolve to a prompt command')
    }
    return realCommand.getPromptForCommand(args, context)
  },
} satisfies Command

/**
 * The built-in roster, in registration order (contract data — the parity
 * prover asserts the decided floor enumerates and the removed names never
 * re-enumerate).
 *
 * Absent-in-this-build families deliberately contribute no entries:
 * bridge, brief, assistant, proactive,
 * remote-control server, peers, fork, torch, subscribe-PR, force-snip and
 * the agents platform. The final-wave rulings additionally drop the
 * `/advisor`, `/files`, `/tag` and `/thinkback(-play)` registrations and the
 * internal-only stub list (S35/S36/S37 do not build those bodies).
 */
const COMMANDS = memoize((): Command[] => [
  addDir,
  verify,
  agents,
  branch,
  branches,
  counsel,
  clear,
  color,
  compact,
  config,
  contractCommand,
  copy,
  context,
  contextNonInteractive,
  mission,
  missionNonInteractive,
  autoCompactWindow,
  cost,
  crew,
  debrief,
  halt,
  companion,
  critter,
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
  sessions,
  sessiontab,
  substrate,
  trace,
  kill,
  unkill,
  remember,
  themis,
  meh,
  good,
  diff,
  health,
  effort,
  exit,
  heapdump,
  help,
  ide,
  init,
  keybindings,
  keys,
  mcp,
  memory,
  model,
  extensions,
  prComments,
  releaseNotes,
  rename,
  resume,
  session,
  skills,
  status,
  title,
  feedback,
  review,
  rewind,
  securityReview,
  terminalSetup,
  mockLimits,
  usage,
  defaultprovider,
  insightsShim,
  vim,
  permissions,
  plan,
  hooks,
  exportCommand,
  sandboxToggle,
  // The auth pair — logout first, then the login factory's product.
  logout,
  loginFactory(),
  tasks,
  team,
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
  cards,
  caching,
  tabula,
  noteCommand,
  minervaCommand,
  workbench,
  router,
  daemon,
  saturn,
  realms,
  accounts,
  agentForm,
  teammates,
  consoleCommand,
  submodels,
  supercode,
  supervisor,
  pings,
  palette,
  capabilitiesDetail,
  orient,
  live,
  sovereign,
  // Voice input: the master toggle and the capture action behind `v`.
  speak,
  voice,
  // The old multiplayer's doors stay registered, retired: a typed name
  // answers its reason, never "Unknown skill"; none is enabled or listed.
  ...retiredMultiplayerCommands,
])

/**
 * THE ONE DISPATCH RULE: where a command executes. A route alias and a
 * dialog (local-jsx) are the screen's — the surface they paint is the
 * screen's; a local command marked `seat: 'screen'` OR `userPrivate` runs
 * in the screen process against the focused connector (a user-private line
 * never leaves the screen — the command-privacy law: it enters no model
 * conversation, starts no turn, bills no token, on any seat); everything
 * else (a prompt expansion, a session-side local command) runs in the
 * SESSION's own process. The screen's submit path and the session runner's
 * table both read this answer, so no command is ever unknown in a session
 * that the screen knows.
 */
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

/** The table a SESSION's runner executes: every command of the screen's
 *  table whose seat is the session. One table, one rule. */
export function sessionSeatCommandTable(commands: readonly Command[]): Command[] {
  return commands.filter(command => commandSeat(command) === 'session')
}

/** The raw, unfiltered built-in registry — for the effective-surface
 *  catalogue and its drift prover. Runtime consumers use `getCommands`. */
export function builtinCommands(): readonly Command[] {
  return COMMANDS()
}

/** Every built-in name and alias. */
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

/**
 * Availability is a static auth requirement, distinct from enablement. A
 * command with no declared availability is universal; otherwise any met
 * requirement suffices. Deliberately not memoized — a mid-session login
 * changes the answer.
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability || cmd.availability.length === 0) {
    return true
  }
  return cmd.availability.some(requirement => {
    switch (requirement) {
      case 'claude-ai':
        return isClaudeAISubscriber()
      case 'console':
        // A direct first-party API customer.
        return (
          !isClaudeAISubscriber() &&
          isFirstPartyAnthropicBaseUrl()
        )
      case 'any-provider-credential':
        // Provider-derived: ANY family the router catalogue
        // knows with a credential — each family answered by its owning
        // resolver, never a hardcoded provider pair.
        return anyProviderCredentialed()
      default:
        requirement satisfies never
        return false
    }
  })
}

/**
 * Load every command source for a cwd, merged under the fixed precedence
 * (first match wins): bundled skills, skill-directory commands, workflow
 * commands, extension commands, extension skills, built-in commands.
 * Memoized per cwd — loading is disk I/O plus dynamic imports.
 */
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

  // Built-ins are not shadowable (FC-009): an operator- or repo-authored
  // command whose name collides with a built-in NAME OR ALIAS is dropped
  // here, before the first-wins merge — a checked-in
  // .mercury/commands/permissions.md silently replaced the built-in
  // /permissions editor with a model prompt, and a custom command named
  // like a built-in's alias hijacked that alias while the roster still
  // advertised it on the built-in. Bundled skills stay unguarded: they are
  // product-owned and the parity provers arbitrate their names.
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

/** First entry per name wins. Because bundled skills lead the merge, a name
 *  collision between a bundled skill and a same-named extension skill
 *  resolves to the bundled entry, and the losing copy leaves the list
 *  entirely, so a picker shows the name once. */
function dedupeCommandsByName(commands: Command[]): Command[] {
  const byName = new Map<string, Command>()
  const deduped: Command[] = []
  for (const command of commands) {
    const winner = byName.get(command.name)
    if (winner) {
      // A custom-vs-custom collision is a REAL loss the operator can act on
      // (FC-056: two files claiming one name registered one and dropped the
      // other with the only record behind --debug) — it rides the error
      // channel doctor surfaces. Builtin-involved shadows keep the debug
      // whisper (the FC-009 guard already reports those at load).
      const bothCustom = winner.source !== undefined && command.source !== undefined
      const collisionLine = `slash command collision on /${command.name}: the ${String(command.source)} copy is shadowed by the ${String(winner.source)} entry`
      if (bothCustom) {
        // Same-source pairs included: two files in ONE commands tree
        // claiming one name (race.md beside race/SKILL.md) are the card's
        // own shape.
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

/**
 * The usable roster for a cwd: the loaded set filtered by availability and
 * enabled-ness, with dynamic skills discovered during file operations
 * merged in immediately before the first built-in command.
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  // Availability and enabled-ness are filtered BEFORE the per-name walk, so
  // a disabled twin (e.g. the interactive half of an interactive/
  // non-interactive pair) never shadows its enabled sibling — the parity
  // prover's roster floor is the arbiter for this ordering.
  const loaded = await loadAllCommands(cwd)
  // THE SESSION KIT'S TRI-STATE OVERLAY (L24(5)) — applied
  // AFTER the per-cwd disk memo (per-session state never keys a disk
  // cache) and, for the DROP half, BEFORE the per-name dedupe for the same
  // reason enabled-ness is: an off skill must not shadow a sibling out of
  // the table. The kit is the consumed-once process latch; an un-kitted
  // process passes through byte-identically. The boot roster latches from
  // the first full catalogue — a RESOLVED kit's closed lists govern what
  // was enumerable at boot; a later-born skill passes on its author's own
  // frontmatter (the kit can only narrow what it could see).
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
        // A later-discovered dynamic skill is as unshadowing as a loaded one
        // (FC-009): a built-in name or alias is never claimable.
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

/** Drop the loaded command list and the two derived skill views, plus the
 *  optional clear of the (build-absent) skill-search index layer. */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache.clear?.()
  getSkillToolCommands.cache.clear?.()
  getSlashCommandToolSkills.cache.clear?.()
  clearSkillIndexCache?.()
}

/** The full clear: the memoization level plus the extension catalogues and
 *  the skill caches. */
export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearExtensionCommandCaches()
  clearSkillCaches()
}

/** Always empty in this build; the signature is kept for its importers. */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  void mcpCommands
  return []
}

/** The model-invocable skill list. Memoized per cwd. */
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
          command.loadedFrom === 'legacy-commands' ||
          command.hasUserSpecifiedDescription === true ||
          Boolean(command.whenToUse)),
    )
  },
)

/** The slash-command-tool skill list. Memoized per cwd; never throws —
 *  skills are optional, and a loading failure must never break the session. */
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

/**
 * Local-type commands safe to execute when the input arrived over the
 * remote bridge. The summary and file-listing members are absent in this
 * build and fall out of the set at construction.
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [compact, clear, cost, releaseNotes].filter(Boolean),
)

/** Type first: a rendered command would draw terminal UI a remote client
 *  cannot receive; a prompt command only expands into text; a local command
 *  is accepted only from the allowlist. */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') {
    return false
  }
  if (cmd.type === 'prompt') {
    return true
  }
  if (cmd.type === 'local') {
    return BRIDGE_SAFE_COMMANDS.has(cmd)
  }
  return false
}

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

export function hasCommand(name: string, commands: Command[]): boolean {
  return findCommand(name, commands) !== undefined
}

export function getCommand(name: string, commands: Command[]): Command {
  const command = findCommand(name, commands)
  if (!command) {
    const available = commands
      .map(candidate =>
        candidate.aliases?.length
          ? `${getCommandName(candidate)} (aliases: ${candidate.aliases.join(', ')})`
          : getCommandName(candidate),
      )
      .sort((a, b) => a.localeCompare(b))
      .join(', ')
    throw new ReferenceError(
      `Command ${name} not found. Available commands: ${available}`,
    )
  }
  return command
}

/**
 * User-facing surfaces only — model-facing prompts read the raw
 * description. Prompt commands prefer the menu-facing description (a
 * bundled skill's model-facing text can be far too long for a picker row),
 * then annotate by kind and source.
 */
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
    // Operator-facing truth: 'bundled' is packaging vocabulary —
    // to the user these are simply the built-in skill commands.
    return `${description} (built-in)`
  }
  return `${description} (${getSourceDisplayName(cmd.source)})`
}
