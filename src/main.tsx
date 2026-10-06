import { Command as CommanderCommand, InvalidArgumentError, Option } from 'commander'
import { writeSync } from 'node:fs'
import React from 'react'
import {
  getIsInteractive,
  getSessionId,
  setClientType,
  setInitialEngineModel,
  setSessionExtensions,
  setHeadlessOneShot,
  setIsInteractive,
  setEngineModelOverride,
  setMainThreadAgentType,
  setQuestionPreviewFormat,
  setSessionPersistenceDisabled,
  switchSession,
} from './bootstrap/state.js'
import { armBackgroundDiscovery, registerBackgroundNode } from './boot/launchGraph.js'
import { getCommands, sessionSeatCommandTable } from './commands.js'
import { surfaceDumpDocument } from './commands/effectiveCatalogue.js'
import { MERCURY_VERSION } from './constants/product.js'
import { getSystemContext, getUserContext } from './context.js'
import { initBundledSkills } from './skills/bundled/index.js'
import { launchChat } from './chatLauncher.js'
import { getInstructionFiles } from './services/instructions/engine.js'
import { initializeLspServerManager, waitForInitialization } from './services/lsp/manager.js'
import { mercuryLspEnabled } from './services/lsp/mercuryLsp.js'
import { qualifiedIdSpaceOf } from './services/providers/idSpaces.js'
import { fetchAnthropicConnectorsIfEligible } from './services/mcp/anthropicConnectors.js'
import {
  clearServerCache,
  connectToServer,
  fenceMcpPrefixCollisions,
  fetchCommandsForClient,
  fetchToolsForClient,
  mcpLaunchBudgetMs,
  withMcpLaunchBudget,
} from './services/mcp/client.js'
import { getMcpPrefix } from './services/mcp/mcpStringUtils.js'
import { partitionMcpConfigsByMembership } from './services/mcp/membership.js'
import { completeProcessSessionKit, consumeSessionKitPin, noteRefusedKitOnSessionReceipt, sessionKitOf } from './services/mcp/sessionKitPin.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMcpServerSignature,
  getMercuryMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from './services/mcp/config.js'
import { clearBootAttempts } from './substrate/bootBeacon.js'
import { addBootNote, collectLauncherNotes } from './substrate/bootNotes.js'
import { flagEnv, setFlagEnv } from './substrate/flagRegistry.js'
import { recordInvocation } from './substrate/invocationRecord.js'
import { recordLaunchMilestone } from './substrate/launchMilestones.js'
import { markExplicitBootJourney, retractExplicitBootJourney } from './substrate/splashHandover.js'
import { getCwd } from './utils/cwd.js'
import { applyBootMenuEnv, recordBootAdmissionSnapshot, resolveEffectiveSettingsSnapshot } from './substrate/startupMenu.js'
import { setAssistantModeActive } from './tasks/LocalShellTask/LocalShellTask.js'
import { getTools } from './tools.js'
import { getAgentDefinitionsWithOverrides, computeActiveAgents, parseAgentsFromJson, type AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { init } from './entrypoints/init.js'
import { releaseLauncherAltHoldNow } from './ink/launcherAltHold.js'
import { resolveTerminalExperience } from './ink/session/terminalExperience.js'
import {
  exitWithError,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from './interactiveHelpers.js'
import { launchInvalidSettingsDialog, launchResumeChooser } from './dialogLaunchers.js'
import { hasFirstPartyCredential, validateForceLoginOrg } from './utils/auth.js'
import { startBackgroundHousekeeping } from './utils/backgroundHousekeeping.js'
import { getGlobalConfig, saveGlobalConfigDeferred, flushDeferredGlobalConfigSaves, binaryName, getRemoteControlAtStartup, getCurrentProjectConfig } from './utils/config.js'
import { registerSession, updateSessionName } from './utils/concurrentSessions.js'
import { lastCrashReportPath } from './utils/crashReport.js'
import { logForDebugging } from './utils/debug.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { startCapturingEarlyInput, stopCapturingEarlyInput, consumeEarlyInput } from './utils/earlyInput.js'
import { describeEffortEnvOverride, EFFORT_LEVELS, parseCliEffort, type EffortLevel } from './utils/effort.js'
import { isBareMode, isEnvTruthy, ensurePrivateConfigHome } from './utils/envUtils.js'
import { refreshExampleCommands } from './utils/exampleCommands.js'
import { startEventLoopStallDetector } from './utils/eventLoopStallDetector.js'
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js'
import type { HookResultMessage } from './types/message.js'
import { logError } from './utils/log.js'
import { createUserMessage } from './utils/messages/factories.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { getModelDeprecationWarning } from './utils/model/deprecation.js'
import { getDefaultEngineModelSetting, getEngineModel, getCanonicalName } from './utils/model/model.js'
import {
  initializeToolPermissionContext,
  stripDangerousPermissionsForAutoMode,
} from './utils/permissions/permissionSetup.js'
import { PERMISSION_MODES, modeBypassesPermissions, type PermissionMode } from './utils/permissions/PermissionMode.js'
import { MODE_GLOSS } from './utils/settings/validationTips.js'
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'
import { resetUserCache, getCoreUserData } from './utils/user.js'
import { settingsChangeDetector } from './utils/settings/changeDetector.js'
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js'
import { getSettingsWithErrors, getInitialSettings } from './utils/settings/settings.js'
import { parseSettingSourcesFlag } from './utils/settings/constants.js'
import { resetSettingsCache, setSessionSettingsCache } from './utils/settings/settingsCache.js'
import { setFlagSettingsInline, setFlagSettingsPath, setAllowedSettingSources, getSessionProjectDir } from './bootstrap/state.js'
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js'
import { lastSession, sessionAtIndex, searchSessionsByCustomTitle, listSessions, sessionIdExists } from './utils/sessionStorage.js'
import { sessionIdOfListing } from './utils/sessionStorage/logs.js'
import { armProvisionalSessionReconcile } from './utils/provisionalSessionReconcile.js'
import { computeInitialCrewContext } from './utils/crew/reconnection.js'
import { findRoleDefinition, getRoleSystemPrompt } from './utils/crew/roleResolver.js'
import { getTipToShowOnSpinner } from './services/tips/tipScheduler.js'
import { getSlashCommandToolSkills } from './commands.js'
import { countFilesRoundedRg } from './utils/ripgrep.js'
import { checkHasTrustDialogAccepted } from './utils/config.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import { crashShutdown, gracefulShutdown, isShuttingDown } from './utils/gracefulShutdown.js'
import { initSinks } from './utils/sinks.js'
import { setup } from './setup.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { createStore } from './state/store.js'
import { onChangeAppState } from './state/onChangeAppState.js'
import type { AppState } from './state/AppStateStore.js'
import type { Props as ChatProps } from './screens/Chat.js'
import type { UUID } from 'node:crypto'
import { update as updateCli } from './cli/update.js'
import type { ScopedMcpServerConfig } from './services/mcp/types.js'
import { writeShimSet, resolveLayoutRoots } from './services/privateChannel/installLayout.js'
import type { Root } from './ink.js'
import chalk from 'chalk'
import { refusedOutcome } from './cli/headless/refusalEnvelope.js'
import { inspectSessionArgs as inspectRunArgs, isSessionRunArgv as isRunArgv, readSessionOption } from './cli/sessionArgs.js'

profileCheckpoint('main_tsx_entry')
startMdmRawRead();
startKeychainPrefetch();
profileCheckpoint('main_tsx_imports_loaded')

function refuseDebugger(): void {
  const isBun = typeof (process as { isBun?: boolean }).isBun !== 'undefined' || process.versions.bun !== undefined
  const flags = isBun
    ? [/^--inspect(-brk)?(=|$)/]
    : [/^--inspect(-brk)?(=|$)/, /^--debug(-brk)?(=|$)/]
  const argvHit = process.execArgv.some(arg => flags.some(re => re.test(arg)))
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  const envHit = /--inspect(-brk)?(=|\s|$)/.test(nodeOptions) || (!isBun && /--debug(-brk)?(=|\s|$)/.test(nodeOptions))
  let inspectorHit = false
  try {
    const req = (globalThis as { require?: (id: string) => { url?: () => string | undefined } }).require
    if (req) inspectorHit = Boolean(req('node:inspector').url?.())
  } catch {
    inspectorHit = false
  }
  if (argvHit || envHit || inspectorHit) {
    process.exit(1)
  }
}
refuseDebugger()

function applyMergedConfigEnv(): void {
  const env = getInitialSettings().environment?.values ?? {}
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = String(value)
  }
}


const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function typedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function writeErr(text: string): void {
  releaseLauncherAltHoldNow()
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

function wantsRowStream(): boolean {
  const args = inspectRunArgs(process.argv.slice(2))
  return args.command === 'run' && args.format === 'rows'
}

const USAGE_ERROR_CODES = new Set([
  'commander.unknownOption',
  'commander.unknownCommand',
  'commander.missingArgument',
  'commander.optionMissingArgument',
  'commander.missingMandatoryOptionValue',
  'commander.invalidArgument',
  'commander.excessArguments',
  'commander.conflictingOption',
])
function exitForCommanderError(error: { code?: string; exitCode?: number }): void {
  if (error.code !== undefined && USAGE_ERROR_CODES.has(error.code)) process.exit(2)
}

function failCli(message: string, code: 1 | 2 = 2): never {
  if (wantsRowStream()) {
    try {
      const envelope = refusedOutcome([message])
      writeSync(1, `${JSON.stringify(envelope)}\n`)
      process.exit(code)
    } catch {
    }
  }
  writeErr(chalk.red(message))
  process.exit(code)
}

let abandonAnnounced = false
function announceAbandonedLaunch(): void {
  if (abandonAnnounced) return
  abandonAnnounced = true
  process.once('exit', code => {
    if (code === 0) return
    try {
      process.stderr.write(
        `Mercury did not start: a shutdown was initiated during boot (exit ${code}). Boot again with --debug and read the debug log for the initiator.\n`,
      )
    } catch {
    }
  })
}

export async function main(): Promise<void> {
  profileCheckpoint('main_function_start')

  applyBootMenuEnv();
  recordBootAdmissionSnapshot(resolveEffectiveSettingsSnapshot({ sessionId: getSessionId() }));
  ensurePrivateConfigHome();
  collectLauncherNotes();

  const surfaceDumpPath = flagEnv('MERCURY_SURFACE_DUMP')
  if (surfaceDumpPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(surfaceDumpPath, JSON.stringify(surfaceDumpDocument(), null, 2))
    process.exit(0)
  }

  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  const { initializeWarningHandler } = await import('./utils/warningHandler.js')
  initializeWarningHandler()
  process.on('exit', () => {
    if (!process.stderr.isTTY) return
    process.stderr.write('\x1b[?25h')
    process.stderr.write('\x1b]111\x07')
  })
  if (!isRunArgv()) {
    process.on('SIGINT', () => process.exit(130))
  }
  profileCheckpoint('main_warning_handler_initialized')

  const runFlag = isRunArgv()
  const initOnlyFlag = readSessionOption(process.argv.slice(2), '--prepare-only').present
  const stdoutTty = Boolean(process.stdout.isTTY)
  const isNonInteractive = runFlag || initOnlyFlag || !stdoutTty
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }
  setIsInteractive(!isNonInteractive)
  if (!stdoutTty && !runFlag && !initOnlyFlag && process.stdin.isTTY) {
    writeErr(
      'stdout is not attached to a terminal, so this run is non-interactive. Pass run to silence this note, or attach a terminal to get the interactive session.',
    )
  }

  if (!process.env.MERCURY_ENTRYPOINT) {
    const mcpIndex = process.argv.indexOf('mcp')
    const mcpServe = mcpIndex >= 0 && process.argv[mcpIndex + 1] === 'serve'
    process.env.MERCURY_ENTRYPOINT = mcpServe ? 'mcp' : isNonInteractive ? 'headless' : 'cli'
  }

  const entrypoint = process.env.MERCURY_ENTRYPOINT
  const clientType = entrypoint === 'headless' ? 'headless' : entrypoint === 'local-agent' ? 'local-agent' : 'cli'
  setClientType(clientType)

  if (clientType !== 'headless' && clientType !== 'local-agent') {
    setQuestionPreviewFormat('markdown')
  }
  profileCheckpoint('main_client_type_determined')

  eagerLoadSettings()
  profileCheckpoint('main_before_run')
  await run();
  profileCheckpoint('main_after_run')
}

function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  const argv = process.argv
  const ddIndex = argv.indexOf('--')
  const optionArgv = ddIndex >= 0 ? argv.slice(0, ddIndex) : argv
  const eagerFlagValue = (name: string): string | undefined => readSessionOption(optionArgv.slice(2), name).value
  const settingsValue = eagerFlagValue('--config')
  if (settingsValue !== undefined) {
    const value = settingsValue
    if (value && value.length > 0) {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          failCli('The JSON supplied to --config is invalid.')
        }
        const serialized = JSON.stringify(parsed).replace(
          /[-]/g,
          ch => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        )
        const { createHash } = require('node:crypto') as typeof import('node:crypto')
        const { tmpdir } = require('node:os') as typeof import('node:os')
        const { join } = require('node:path') as typeof import('node:path')
        const { writeFileSync } = require('node:fs') as typeof import('node:fs')
        const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 16)
        const settingsPath = join(tmpdir(), `mercury-settings-${hash}.json`)
        writeFileSync(settingsPath, serialized)
        setFlagSettingsInline(parsed)
        setFlagSettingsPath(settingsPath)
        resetSettingsCache()
      } else {
        try {
          const { resolve } = require('node:path') as typeof import('node:path')
          const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
          const resolved = resolve(value)
          if (!existsSync(resolved)) {
            failCli(`Settings file not found: ${resolved}`)
          }
          readFileSync(resolved, 'utf8')
          setFlagSettingsPath(resolved)
          resetSettingsCache()
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Settings file not found')) throw error
          logError(error)
          failCli(`Failed while processing --config: ${error instanceof Error ? error.message : String(error)}`, 1)
        }
      }
    }
  }
  const sourcesValue = eagerFlagValue('--config-layers')
  if (sourcesValue !== undefined || readSessionOption(optionArgv.slice(2), '--config-layers').present) {
    try {
      const value = sourcesValue ?? ''
      setAllowedSettingSources(parseSettingSourcesFlag(value))
      resetSettingsCache()
    } catch (error) {
      logError(error)
      failCli(`Failed to process --config-layers: ${error instanceof Error ? error.message : String(error)}`, 1)
    }
  }
  profileCheckpoint('eagerLoadSettings_end')
}

const require = (await import('node:module')).createRequire(import.meta.url)

async function run(): Promise<void> {
  profileCheckpoint('run_function_start')
  const cliName = binaryName()
  const program = new CommanderCommand()
  const sessionOptions = (command: CommanderCommand): RootOptions => {
    const values: RootOptions = { ...program.opts() }
    for (const [key, value] of Object.entries(command.opts())) {
      if (command.getOptionValueSource(key) !== 'default' || !(key in values)) values[key] = value
    }
    if (command !== program && program.getOptionValueSource('extension') === 'cli' && command.getOptionValueSource('extension') === 'cli') {
      values.extension = [...program.opts().extension, ...command.opts().extension]
    }
    return values
  }
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (actionCommand === (program as unknown) || actionCommand.name() === 'run') return
    try {
      const names: string[] = []
      type CommandNode = { name(): string; parent: CommandNode | null }
      let node: CommandNode | null = actionCommand as unknown as CommandNode
      while (node !== null && (node as unknown) !== (program as unknown)) {
        names.unshift(node.name())
        node = node.parent
      }
      if (names.length > 0) {
        const { enableConfigs } = await import('./utils/config/globalConfig.js')
        enableConfigs()
        const { noteHeadlessActivity } = await import('./utils/activityLedger.js')
        noteHeadlessActivity(`verb:${names.join(':')}`)
      }
    } catch {
    }
  })
  program
    .name(cliName)
    .description(
      `${cliName} — an interactive session starts by default; run answers a prompt without a terminal UI.`,
    )
    .enablePositionalOptions()
    .configureHelp({ sortSubcommands: true, sortOptions: true })
    .configureOutput({
      writeOut: text => {
        releaseLauncherAltHoldNow()
        process.stdout.write(text)
      },
      writeErr: text => {
        releaseLauncherAltHoldNow()
        process.stderr.write(text)
      },
    })
    .exitOverride(exitForCommanderError)
    .helpOption('-h, --help', 'Show help')
  profileCheckpoint('run_commander_initialized')

  program
    .argument('[prompt]', 'The prompt to start with')
    .option('-d', 'Enable debug output')
    .option('--debug [filter]', 'Enable debug output (with an optional category filter)')
    .addOption(new Option('--log-stderr', 'Mirror debug output to stderr').hideHelp())
    .option('--log-file <path>', 'Write debug output to a file')
    .option('--lean', 'Minimal session: skips hooks, LSP, extensions, attribution, memory, background discovery, keychain reads and automatic project instructions. Supply context with --brief, --brief-add, --mcp and --allowed-tools; supply API-key settings with --config.')
    .addOption(new Option('--prepare', 'Run setup hooks before the session').hideHelp())
    .addOption(new Option('--prepare-only', 'Run setup hooks and exit').hideHelp())
    .addOption(new Option('--upkeep', 'Run maintenance hooks').hideHelp())
    .addOption(new Option('--format <format>', 'Answer format for run: text, one JSON result, or JSON-line rows').choices(['text', 'json', 'rows']))
    .addOption(new Option('--input <format>', 'Read JSON-line rows from stdin with run').choices(['rows']))
    .option('--schema <schema>', 'JSON schema for structured output')
    .option('--partial', 'Include partial rows while run streams')
    .option('--sovereign', 'Start in sovereign mode: no permission prompts at all (a deny rule still refuses)')
    .option('--allow-sovereign', 'Let the session switch into running without permission prompts (sovereign mode) later; it does not start there')
    .addOption(new Option('--reasoning-mode <mode>', 'Thinking mode').choices(['enabled', 'adaptive', 'disabled']).hideHelp())
    .addOption(new Option('--max-turns <turns>', 'Maximum turns for a run').argParser((value: string) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        failCli(`--max-turns must be a positive integer (got '${value}')`)
      }
      return parsed
    }).hideHelp())
    .option('--budget <usd>', 'The most a run may spend, in US dollars (2.50 is two dollars fifty); the turn ends when it is reached', value => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        failCli('--budget must be a positive number greater than 0')
      }
      return parsed
    })
    .option('--allowed-tools <tools...>', 'Tools the model may use without asking, as rules: a tool name, or a tool with a pattern — Read, Bash(git *), Edit(src/**), mcp__server__tool')
    .option('--toolset <tools...>', 'Base tool set')
    .option('--block-tools <tools...>', 'Tools the model may never use, in the same shape as --allowed-tools')
    .option('--mcp <configs...>', 'MCP server configs (JSON or file paths)')
    .option('--only-mcp', 'Only use MCP servers from --mcp')
    .option('--brief <prompt>', 'Set the standing instructions the model reads before the conversation (the session system brief)')
    .addOption(new Option('--brief-file <file>', 'Read the session system brief from a file').hideHelp())
    .option('--brief-add <prompt>', 'Append to the session system brief')
    .addOption(new Option('--brief-add-file <file>', 'Append to the session system brief from a file').hideHelp())
    .addOption(new Option('--mode <mode>', `Permission mode — ${PERMISSION_MODES.map(mode => `${mode}: ${MODE_GLOSS[mode]}`).join('; ')}`).choices(PERMISSION_MODES))
    .option('-c, --continue', 'Continue the most recent conversation')
    .option('-r, --resume [value]', 'Resume a conversation (session id, title, or picker)')
    .option('--fork', 'Fork to a new session id on resume')
    .option('--pr [value]', 'Resume a session linked to a PR')
    .addOption(new Option('--draft <text>', 'Prefill the input buffer').hideHelp())
    .option('--ephemeral', 'Do not persist the session transcript')
    .addOption(new Option('--replay-to <message-id>', 'Truncate the resumed session at a message').hideHelp())
    .addOption(new Option('--restore-files <user-message-id>', 'Rewind files to a user message').hideHelp())
    .option('--model <model>', 'The model for the session')
    .option('--advise', 'Turn on the second model that advises the working model (the advisor) from the run\'s first turn (at birth) — the headless form of /advise on; the advisor\'s master switch in Mercury\'s home folder for this run (the config home) must be on')
    .option(`--effort <level>`, `Reasoning effort level (${EFFORT_LEVELS.join(', ')})`, value => {
      const { level } = parseCliEffort(value)
      if (level === undefined) {
        throw new InvalidArgumentError(
          `Unrecognised effort level "${value}". Valid values: ${EFFORT_LEVELS.join(', ')}.`,
        )
      }
      return level
    })
    .option('--agent <agent>', 'The agent to run as')
    .option('--provider-preview <betas...>', 'Provider beta headers')
    .option('--backup-model <model>', 'Fallback model when the primary is overloaded')
    .addOption(new Option('--meter-tag <tag>', 'Workload tag').hideHelp())
    .option('--project <directory>', 'Start in this folder; it must come first on the command line, before everything else (mercury --project <dir> run …)', () => {
      throw new Error('--project must appear before all other arguments')
    })
    .option('--config <file-or-json>', 'Extra settings (path or inline JSON)')
    .option('--session-id <uuid>', 'Use a specific session id')
    .option('--title <name>', 'Session title')
    .option('--chat', 'Open only the screen Mercury opens on (the Boot face) and a chat: no board of your sessions (no concourse) in this boot, and the row of screens shift+←/→ move between (the strip) is those two alone; ↵ New Session on the menu starts the chat (`-chat` is the same switch)')
    .option('--concourse-off', 'Turn the concourse off for this and every future boot (persisted; the strip is the Boot face and the chat alone; the Boot face\'s Session Concourse row keeps a plain live view of your sessions; `-concourse-off` is the same switch)')
    .option('--concourse-on', 'Turn the concourse back on for this and every future boot (persisted; the default is on; `-concourse-on` is the same switch)')
    .option('--agent-defs <json>', 'Extra agent definitions (JSON)')
    .option('--config-layers <sources>', 'Which settings sources may apply, comma-separated: user, project, local')
    .option('--extension <path>', 'An extension folder approved for this session only (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
    .option('--no-commands', 'Disable all slash commands')
    .option('-v, --version', 'Print the version')
    .option('-w, --worktree [name]', 'Run inside a managed worktree')
    .option('--multiplex', 'Create a tmux session for the worktree')

  for (const [flags, description] of [
    ['--seat-id <id>', 'Crewmate agent id'],
    ['--seat <name>', 'Crewmate agent name'],
    ['--crew <name>', 'Crewmate crew name'],
    ['--seat-color <color>', 'Crewmate color'],
    ['--parent <id>', 'Parent session id'],
    ['--role <type>', 'Crewmate agent type'],
  ] as const) {
    program.addOption(new Option(flags, description).hideHelp())
  }

  program.addOption(new Option('-V', 'Print the version').hideHelp())
  program.on('option:V', () => {
    releaseLauncherAltHoldNow()
    try {
      writeSync(1, `Mercury ${MERCURY_VERSION}\n`)
    } catch {
    }
    process.exit(0)
  })
  profileCheckpoint('run_main_options_built')

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    profileCheckpoint('preAction_start')
    const slowBootNote = setTimeout(() => {
      if (process.stderr.isTTY) process.stderr.write('checking the system keychain and managed settings…\n')
    }, 1_500)
    slowBootNote.unref?.()
    const { ensureMdmSettingsLoaded, mdmBootAwaitsRawRead, getMdmSettings, getHkcuSettings } = await import('./utils/settings/mdm/settings.js')
    if (mdmBootAwaitsRawRead()) {
      await ensureMdmSettingsLoaded().catch((error: unknown) => {
        logForDebugging(`MDM settings load failed at boot; no policy tier applies: ${String(error)}`, { level: 'error' })
      })
    } else {
      void ensureMdmSettingsLoaded()
        .then(() => {
          if (Object.keys(getMdmSettings().settings).length === 0 && Object.keys(getHkcuSettings().settings).length === 0) return
          settingsChangeDetector.notifyChange('policySettings')
        })
        .catch((error: unknown) => {
          logForDebugging(`MDM settings load failed in the background; no policy tier applies: ${String(error)}`, { level: 'error' })
        })
    }
    resetSettingsCache()
    profileCheckpoint('preAction_after_mdm')
    await ensureKeychainPrefetchCompleted()
    clearTimeout(slowBootNote)
    await init()
    profileCheckpoint('preAction_after_init')
    if (resolveTerminalExperience().terminalTitle.effective) {
      process.title = 'mercury'
    }
    initSinks()
    profileCheckpoint('preAction_after_sinks')
    const extensionPaths = sessionOptions(actionCommand).extension as unknown
    if (Array.isArray(extensionPaths) && extensionPaths.length > 0 && extensionPaths.every(entry => typeof entry === 'string')) {
      const { existsSync: extensionDirExists } = require('node:fs') as typeof import('node:fs')
      const missing = (extensionPaths as string[]).filter(entry => !extensionDirExists(entry))
      if (missing.length > 0) {
        failCli(`--extension path${missing.length === 1 ? ' does' : 's do'} not exist: ${missing.join(', ')}`)
      }
      setSessionExtensions(extensionPaths)
    }
  })

  program.action(async (prompt: string | undefined) => {
    await defaultAction(prompt, program.opts())
  })
  const runCommand = program.command('run')
    .description('Run a prompt without a terminal UI; use only in directories you trust')
    .argument('[prompt]', 'The prompt; - or no prompt reads it from stdin to the end; with a prompt, anything piped in within 1 s is added as context')
    .configureHelp({ sortOptions: true })
    .action(async (prompt: string | undefined) => {
      await defaultAction(prompt, { ...sessionOptions(runCommand), runMode: true })
    })
  const headlessResumeOption = new Option('-r, --resume <value>', 'Resume a session by its id (a UUID) or its .jsonl transcript path')
  for (const option of program.options) {
    if (INTERACTIVE_BOOT_OPTIONS.has(option.long ?? '')) continue
    runCommand.addOption(option.long === '--resume' ? headlessResumeOption : option)
  }
  const runnerCommand = program.command('runner')
    .description('Serve a session to a host over stdio (JSON-RPC 2.0, one message per line): the host sends the prompts and answers the permission asks')
    .configureHelp({ sortOptions: true })
    .action(async () => {
      await defaultAction(undefined, { ...sessionOptions(runnerCommand), runMode: true, runner: true })
    })
  for (const option of program.options) {
    if (RUN_OUTPUT_OPTIONS.has(option.long ?? '') || INTERACTIVE_BOOT_OPTIONS.has(option.long ?? '')) continue
    runnerCommand.addOption(option.long === '--resume' ? headlessResumeOption : option)
  }

  const parseProgram = () => program.parseAsync(process.argv)

  if (isRunArgv()) {
    profileCheckpoint('run_before_parse')
    if (wantsRowStream()) {
      program.exitOverride()
      runCommand.exitOverride()
      try {
        await parseProgram()
      } catch (error) {
        const commanderError = error as { code?: string; exitCode?: number; message?: string }
        if (
          commanderError.code === 'commander.helpDisplayed' ||
          commanderError.code === 'commander.version'
        ) {
          process.exit(commanderError.exitCode ?? 0)
        }
        if (commanderError.code === 'commander.unknownOption') {
          exitForCommanderError(commanderError)
        }
        const { emitLoadError } = await import('./cli/headless/resume.js')
        emitLoadError(String(commanderError.message ?? error), 'rows')
        process.exit(
          commanderError.code !== undefined && USAGE_ERROR_CODES.has(commanderError.code)
            ? 2
            : typeof commanderError.exitCode === 'number' && commanderError.exitCode !== 0
              ? commanderError.exitCode
              : 1,
        )
      }
    } else {
      await parseProgram()
    }
    profileCheckpoint('run_after_parse')
    return
  }

  await registerSubcommands(program)

  profileCheckpoint('run_before_parse')
  await parseProgram()
  profileCheckpoint('run_after_parse')
  profileCheckpoint('run_complete')
  profileReport()
}

async function registerSubcommands(program: CommanderCommand): Promise<void> {
  const cliName = binaryName()

  const mcp = program.command('mcp').description('Manage MCP servers').helpCommand('help [command]', 'Show help for a command')
  mcp.enablePositionalOptions().configureHelp({ sortSubcommands: true, sortOptions: true })
  mcp
    .command('serve')
    .description('Run the MCP server')
    .option('-d, --debug', 'Debug output')
    .action(async options => {
      const { mcpServeHandler } = await import('./cli/handlers/mcp.js')
      await mcpServeHandler(options)
    })
  if (process.argv.includes('mcp')) {
    try {
      const { registerMcpAddCommand } = await import('./commands/mcp/addCommand.js')
      registerMcpAddCommand(mcp as unknown as Parameters<typeof registerMcpAddCommand>[0])
    } catch (error) {
      logError(error)
    }
  }
  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option('-s, --scope <scope>', 'Configuration scope')
    .action(async (name, options) => {
      const { mcpRemoveHandler } = await import('./cli/handlers/mcp.js')
      await mcpRemoveHandler(name, options)
    })
  mcp
    .command('list')
    .description(
      "List the configured MCP servers and check each by connecting to it (a stdio server is started for the check; the project's servers are included without the approval question)",
    )
    .action(async () => {
      const { mcpListHandler } = await import('./cli/handlers/mcp.js')
      await mcpListHandler()
    })
  mcp
    .command('get <name>')
    .description(
      'Show one MCP server and check it by connecting to it (a stdio server is started for the check; a project server is included without the approval question)',
    )
    .action(async name => {
      const { mcpGetHandler } = await import('./cli/handlers/mcp.js')
      await mcpGetHandler(name)
    })
  mcp
    .command('import <name> <json>')
    .description('Add an MCP server from a JSON definition')
    .option('-s, --scope <scope>', 'Configuration scope', 'local')
    .option('--client-secret', 'Prompt for a client secret')
    .action(async (name, json, options) => {
      const { mcpAddJsonHandler } = await import('./cli/handlers/mcp.js')
      await mcpAddJsonHandler(name, json, options)
    })
  mcp
    .command('trust-reset')
    .description('Reset project MCP server approval choices')
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('./cli/handlers/mcp.js')
      await mcpResetChoicesHandler()
    })

  const auth = program.command('auth').description('Manage authentication').helpCommand('help [command]', 'Show help for a command')
  auth
    .command('mint')
    .description('Create a long-lived authentication token')
    .action(async () => {
      const { setupTokenHandler } = await import('./cli/handlers/util.js')
      const { createRoot } = await import('./ink.js')
      await setupTokenHandler(await createRoot())
    })
  auth
    .command('login')
    .description('Sign in')
    .option('--email <email>', 'Account email')
    .option('--sso', 'Use SSO')
    .option('--console', 'Sign in with an Anthropic Console (API) account; the default is the subscription sign-in')
    .action(async options => {
      const { authLogin } = await import('./cli/handlers/auth.js')
      await authLogin(options)
    })
  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'JSON output (the default when stdout is not a terminal)')
    .action(async options => {
      const { authStatus } = await import('./cli/handlers/auth.js')
      await authStatus(options)
    })
  auth
    .command('logout')
    .description('Sign out')
    .action(async () => {
      const { authLogout } = await import('./cli/handlers/auth.js')
      await authLogout()
    })

  const extensions = program.command('extensions').description('Install extensions and manage their sources').helpCommand('help [command]', 'Show help for a command')
  extensions
    .command('list')
    .description('The installed extensions, each with its state and the first reason behind it; --source lists what one source offers')
    .option('--json', 'JSON output')
    .option('--source <label>', 'List what one source offers, by the name you filed it under (its label)')
    .action(async options => {
      const { listVerb } = await import('./extensions/cli.js')
      process.exitCode = (await listVerb(options)).exit
    })
  extensions
    .command('sources')
    .description('Your sources, each with its state')
    .option('--json', 'JSON output')
    .action(async options => {
      const { sourcesVerb } = await import('./extensions/cli.js')
      process.exitCode = (await sourcesVerb(options)).exit
    })
  extensions
    .command('add <source>')
    .description('Add a source: a git URL on any host, a folder, or an archive (nothing is installed)')
    .option('--label <label>', 'The name to file the source under (its label)')
    .option('--json', 'JSON output')
    .action(async (source, options) => {
      const { addVerb } = await import('./extensions/cli.js')
      process.exitCode = (await addVerb(source, options)).exit
    })
  extensions
    .command('remove')
    .argument('<label>', 'The name you filed the source under (its label)')
    .description('Remove a source (its installed copies keep working)')
    .option('--and-extensions', 'Also uninstall the extensions installed from it')
    .action(async (label, options) => {
      const { removeVerb } = await import('./extensions/cli.js')
      process.exitCode = (await removeVerb(label, options)).exit
    })
  extensions
    .command('refresh')
    .argument('[label]', 'The name you filed the source under (its label); none means every source')
    .description('Refresh one or every source; prints the updates found (installs nothing)')
    .option('--json', 'JSON output')
    .action(async (label, options) => {
      const { checkVerb } = await import('./extensions/cli.js')
      process.exitCode = (await checkVerb(label, options)).exit
    })
  extensions
    .command('install')
    .argument('<name>', 'The extension to install; name@label takes it from the one source filed under that name (its label)')
    .description('Install an extension: fetch it, show what it will run on your machine and what it needs (the card), then approve it (on a TTY-less run, --yes is the approval)')
    .option('--yes', 'Approve without asking (the only scripted approval)')
    .option('--project', 'Switch on for this project only')
    .action(async (name, options) => {
      const { installVerb } = await import('./extensions/cli.js')
      process.exitCode = (await installVerb(name, options)).exit
    })
  extensions
    .command('trust <id>')
    .description('Show what an installed-but-off or newly found extension will run and needs, then approve it')
    .option('--yes', 'Approve without asking')
    .option('--project', 'Switch on for this project only')
    .action(async (id, options) => {
      const { approveVerb } = await import('./extensions/cli.js')
      process.exitCode = (await approveVerb(id, options)).exit
    })
  extensions
    .command('enable <id>')
    .description('Turn an installed extension on')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { enableVerb } = await import('./extensions/cli.js')
      process.exitCode = (await enableVerb(id, options)).exit
    })
  extensions
    .command('disable <id>')
    .description('Turn an installed extension off (its switch)')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { disableVerb } = await import('./extensions/cli.js')
      process.exitCode = (await disableVerb(id, options)).exit
    })
  extensions
    .command('update [id]')
    .description('Update to the version the source lists (after a check); --previous swaps back')
    .option('--all', 'Every installed extension with a known update')
    .option('--yes', 'Approve without asking when the update changes what the extension contributes')
    .option('--previous', 'Swap back to the kept previous version')
    .action(async (id, options) => {
      const { updateVerb } = await import('./extensions/cli.js')
      process.exitCode = (await updateVerb(id, options)).exit
    })
  extensions
    .command('uninstall <id>')
    .description('Uninstall, leaving no residue')
    .option('--keep-data', "Keep the extension's data folder")
    .option('--yes', 'Do not ask')
    .action(async (id, options) => {
      const { uninstallVerb } = await import('./extensions/cli.js')
      process.exitCode = (await uninstallVerb(id, options)).exit
    })
  extensions
    .command('fence <entry>')
    .description('Add an entry to the blocklist (the fence): an extension id, the name a source is filed under (its label), a URL or a host')
    .action(async entry => {
      const { blockVerb } = await import('./extensions/cli.js')
      process.exitCode = (await blockVerb(entry)).exit
    })
  extensions
    .command('unfence <entry>')
    .description('Remove an entry from the blocklist')
    .action(async entry => {
      const { unblockVerb } = await import('./extensions/cli.js')
      process.exitCode = (await unblockVerb(entry)).exit
    })
  extensions
    .command('inspect <path>')
    .description("The maker's linter — checks an extension's manifest, or a source's list of extensions (its catalogue), and what each contributes")
    .option('--json', 'JSON output')
    .action(async (path, options) => {
      const { validateVerb } = await import('./extensions/cli.js')
      process.exitCode = (await validateVerb(path, options)).exit
    })
  extensions
    .command('scaffold <name>')
    .description('Scaffold an extension folder (or, with --source, a source root) that validates clean')
    .option('--source', 'Scaffold a source root with its list of extensions (a catalogue) and the README template')
    .option('--dir <dir>', 'Where to create it (default: the current directory)')
    .action(async (name, options) => {
      const { initVerb } = await import('./extensions/cli.js')
      process.exitCode = (await initVerb(name, options)).exit
    })

  program
    .command('roster')
    .description('Print the agent inventory')
    .option('--config-layers <sources>', 'Which settings sources may apply, comma-separated: user, project, local')
    .action(async () => {
      const { agentsHandler } = await import('./cli/handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  program.command('health [topic]')
    .description('Check the installation health: configured MCP servers are validated WITHOUT starting them; `health processes` lists Mercury\'s own processes as JSON')
    .option('--json', 'The full health report as JSON (the certificate)')
    .option('--deep', 'Run the slower, deeper checks too')
    .option('--fix', 'Run the guided fix flow')
    .option('--only <id>', 'Limit to one check')
    .option('--yes', 'Assume yes at fix prompts')
    .option('--end-stale', 'With `health processes`: end the stale processes the listing names — first by asking the background process that runs them (the daemon), then a termination signal, then a kill')
    .action(async (topic, options) => {
      if (typeof topic === 'string' && topic !== '') {
        if (topic !== 'processes') {
          process.stderr.write(`unknown health topic: ${topic} (the one topic is "processes")\n`)
          await gracefulShutdown(2)
          return
        }
        const { runHealthProcessesCli } = await import('./cli/healthProcesses.js')
        await gracefulShutdown(await runHealthProcessesCli({ endStale: options.endStale === true }))
        return
      }
      await healthAction({
        json: Boolean(options.json),
        deep: Boolean(options.deep),
        fix: Boolean(options.fix),
        only: typedString(options.only),
        yes: options.yes === true,
      })
    })

  program
    .command('godot [verb] [args...]')
    .description('Godot engine jobs, each on a copy of the project taken the moment the job is submitted (a frozen project): run | check | capture | frames | profile | tour | jobs | cancel | result')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_verb: string | undefined, _args: string[] | undefined, _options: unknown, command: { args: string[] }) => {
      const { godotEngineCli } = await import('./cli/godotEngineCli.js')
      process.exit(await godotEngineCli(command.args))
    })

  for (const [name, description, usage] of [
    ['daemon [subcommand]', 'The background process that hosts your sessions and runs scheduled jobs (the daemon): run | status | stop | restart', `Usage: ${cliName} daemon <run|status|stop|restart>`],
    ['acp', 'Serve an editor over the Agent Client Protocol on stdio', `Usage: ${cliName} acp`],
  ] as const) {
    program
      .command(name)
      .description(description)
      .allowUnknownOption(true)
      .action(() => {
        writeErr(usage)
        process.exit(1)
      })
  }

  program
    .command('image <image>')
    .description('Render an image to the terminal')
    .option('--protocol <p>', 'Force a display protocol: iterm, kitty, sixel or cells')
    .option('--cols <n>', 'Width limit in terminal columns (default 76) — exact when the picture is drawn as coloured text (the cells protocol)', Number)
    .action(async (image: string, options: { protocol?: string; cols?: number }) => {
      await showAction(image, options)
    })

  program
    .command('bridge <action>')
    .description('Install, check or remove the VS Code extension: install | status | uninstall')
    .action(async (action: string) => {
      const { editorBridgeMain } = await import('./cli/editorBridge.js')
      process.exit(await editorBridgeMain(action))
    })

  program
    .command('update')
    .alias('upgrade')
    .description('Update to the newest release (no GitHub sign-in needed)')
    .option('--allow-unsigned', 'Explicitly allow an unsigned payload; invalid or untrusted signatures still refuse')
    .option('--check', 'Only check for updates')
    .option('--status', 'Show update status')
    .option('--rollback', 'Roll back to the previous version')
    .option('--yes', "Inside an install made by Homebrew or npm, run that package manager's own upgrade without asking first")
    .option('--json', 'JSON output')
    .action(async options => {
      await updateCli(options)
    })

  program
    .command('install')
    .description('Install the release archive this command runs from, for your user only (a stable `mercury` command and its managed launcher shims); a build tree is refused')
    .option('--allow-unsigned', 'Explicitly allow an unsigned payload; invalid or untrusted signatures still refuse')
    .option('--dry-run', 'Preview only')
    .option('--uninstall', 'Remove the shims')
    .option('--force', 'Overwrite unexpected files')
    .option('--json', 'JSON output')
    .action(async options => {
      const { installVerb } = await import('./cli/installVerb.js')
      await installVerb(options)
    })
}

async function healthAction(options: {
  json: boolean
  deep: boolean
  fix: boolean
  only?: string
  yes: boolean
}): Promise<void> {
  const { resolveHealthPresentation, renderPlainCertificate, writeOutAndExit } = await import(
    './cli/healthPresentation.js'
  )
  if (options.fix) {
    const { runHealthFixCli } = await import('./cli/healthJson.js')
    await runHealthFixCli({ only: options.only, yes: options.yes })
    return
  }
  const presentation = resolveHealthPresentation(
    { json: options.json },
    { stdoutIsTTY: Boolean(process.stdout.isTTY), stdinIsTTY: Boolean(process.stdin.isTTY) },
  )
  if (presentation.output === 'json') {
    const { runHealthJsonCli } = await import('./cli/healthJson.js')
    await runHealthJsonCli({ deep: options.deep, only: options.only })
    return
  }
  if (presentation.output === 'text' || presentation.depth === 'deep' || options.only !== undefined) {
    const { beginReadOnlyDiagnostic } = await import('./utils/diagnosticReadOnly.js')
    beginReadOnlyDiagnostic()
    const { runAndRecordHealthReport } = await import('./utils/healthReport.js')
    let completed = 0
    const cert = await runAndRecordHealthReport({
      depth: options.deep ? 'deep' : 'fast',
      onProgress: event => {
        completed++
        process.stderr.write(`[health] ${completed}/${event.total} ${event.check.id}: ${event.check.status}\n`)
      },
    })
    if (options.only !== undefined) {
      const { filterCertificateToCheck, flattenChecks } = await import('./utils/healthCertCore.js')
      const filtered = filterCertificateToCheck(cert, options.only)
      if (filtered === null) {
        writeErr(
          `No health check has id '${options.only}'. Known ids: ${flattenChecks(cert)
            .map(c => c.id)
            .join(', ')}`,
        )
        process.exit(1)
      }
      return writeOutAndExit(renderPlainCertificate(filtered), filtered.verdict === 'fault' ? 3 : 0)
    }
    return writeOutAndExit(renderPlainCertificate(cert), cert.verdict === 'fault' ? 3 : 0)
  }
  const { healthHandler } = await import('./cli/handlers/util.js')
  const { createRoot } = await import('./ink.js')
  await healthHandler(await createRoot())
}

async function showAction(
  imagePath: string,
  options: { protocol?: string; cols?: number },
): Promise<void> {
  const accepted = ['iterm', 'kitty', 'sixel', 'cells'] as const
  try {
    if (options.protocol !== undefined) {
      if (!(accepted as readonly string[]).includes(options.protocol)) {
        writeErr(
          `Unknown protocol '${options.protocol}'. Accepted: ${accepted.join(', ')}. The pin names itself — there is no silent fallback.`,
        )
        process.exit(1)
      }
      setFlagEnv('MERCURY_IMAGE_PROTOCOL', options.protocol)
    }
    {
      const { readSync: readBytes, openSync: openFd, closeSync: closeFd } = await import('node:fs')
      const head = Buffer.alloc(12)
      try {
        const fd = openFd(imagePath, 'r')
        try {
          readBytes(fd, head, 0, 12, 0)
        } finally {
          closeFd(fd)
        }
      } catch (error) {
        writeErr(`Cannot read ${imagePath}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      const isGif = head.subarray(0, 3).toString('latin1') === 'GIF'
      const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
      if (!isPng && !isJpeg && !isGif && !isWebp) {
        writeErr(`${imagePath} is not an image file (no PNG/JPEG/GIF/WebP signature) — nothing was rendered.`)
        process.exit(1)
      }
    }
    const { renderImageForTerminal } = await import('./services/visual/imageDisplay.js')
    const rendered = await renderImageForTerminal(imagePath, {
      maxCols: options.cols ?? 76,
    })
    const payload = rendered.payload
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stdout.write(`${payload}\n`, error => (error ? rejectPromise(error) : resolvePromise()))
    })
    try {
      writeSync(2, `[${rendered.protocol}] ${imagePath}\n`)
    } catch {
    }
    process.exit(0)
  } catch (error) {
    writeErr(`Failed to display the image: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

type RootOptions = Record<string, unknown>

const RUN_OUTPUT_OPTIONS: ReadonlySet<string> = new Set(['--format', '--input', '--partial'])
const INTERACTIVE_BOOT_OPTIONS: ReadonlySet<string> = new Set(['--chat', '--concourse-off', '--concourse-on', '--multiplex', '--pr'])

async function defaultAction(inputPromptArg: string | undefined, opts: RootOptions): Promise<void> {
  if ((opts as { version?: boolean }).version) {
    console.log(`Mercury ${MACRO.VERSION}`)
    process.exit(0)
  }
  try {
    recordLaunchMilestone('runtime-entry', { boot: getIsInteractive() ? 'interactive' : 'headless' })
  } catch {
  }
  const cliName = binaryName()
  const isNonInteractiveSession = !getIsInteractive()
  const runMode = Boolean(opts.runMode)
  const runnerDoor = opts.runner === true

  const worktreeOpt = opts.worktree as string | boolean | undefined
  const tmuxEnabled = Boolean(opts.multiplex)
  if (tmuxEnabled && !worktreeOpt) failCli('--multiplex requires --worktree')
  if (tmuxEnabled && process.platform === 'win32') failCli('--multiplex is not supported on Windows')
  if (tmuxEnabled) {
    const { isTmuxAvailable, getTmuxInstallInstructions } = await import('./utils/worktree.js')
    if (!(await isTmuxAvailable())) {
      failCli(`tmux is not installed. ${getTmuxInstallInstructions()}`, 1)
    }
  }

  const agentId = typedString(opts.seatId)
  const agentName = typedString(opts.seat)
  const crewName = typedString(opts.crew)
  const agentColor = typedString(opts.seatColor)
  const parentSessionId = typedString(opts.parent)
  const agentTypeOpt = typedString(opts.role)
  const { isCrewEnabled } = await import('./utils/crewEnabled.js')
  if (isCrewEnabled()) {
    const identityCount = [agentId, agentName, crewName].filter(Boolean).length
    if (identityCount > 0 && identityCount < 3) {
      failCli('--seat-id, --seat and --crew must be provided together')
    }
  }

  if (opts.continue && opts.resume) {
    failCli('--continue and --resume name two different sessions — give exactly one')
  }
  if (opts.fork && !runMode) {
    failCli('--fork requires mercury run: a managed resume continues the session as itself')
  }
  if (opts.advise === true && !runMode) {
    failCli('--advise requires mercury run: in a chat, /advise on turns the advisor on for that chat')
  }
  const sessionIdOpt = typedString(opts.sessionId)
  if (sessionIdOpt) {
    if ((opts.continue || opts.resume) && !opts.fork) {
      failCli('--session-id cannot be combined with --continue/--resume unless --fork is given')
    }
    if (!UUID_SHAPE.test(sessionIdOpt)) failCli(`--session-id must be a valid UUID: ${sessionIdOpt}`)
    if (await sessionIdExists(sessionIdOpt)) failCli(`Session id already exists: ${sessionIdOpt}`, 1)
  }
  if (runMode && opts.mode === 'apollo' && !runnerDoor) {
    failCli('mercury run: apollo needs a host that answers its asks (mercury runner)')
  }
  if (opts.backupModel && opts.backupModel === opts.model) {
    failCli('--backup-model cannot equal --model')
  }
  if (opts.brief && opts.briefFile) failCli('Use either --brief or --brief-file, not both')
  if (opts.briefAdd && opts.briefAddFile) {
    failCli('Use either --brief-add or --brief-add-file, not both')
  }
  let customSystemPrompt = typedString(opts.brief)
  let appendSystemPrompt = typedString(opts.briefAdd)
  for (const [fileOpt, assign] of [
    [typedString(opts.briefFile), (text: string) => (customSystemPrompt = text)],
    [typedString(opts.briefAddFile), (text: string) => (appendSystemPrompt = text)],
  ] as const) {
    if (fileOpt) {
      const { resolve } = await import('node:path')
      const { readFileSync, existsSync } = await import('node:fs')
      const resolved = resolve(fileOpt)
      if (!existsSync(resolved)) failCli(`Prompt file not found: ${resolved}`)
      try {
        assign(readFileSync(resolved, 'utf8'))
      } catch (error) {
        failCli(`Failed to read the prompt file: ${error instanceof Error ? error.message : String(error)}`, 1)
      }
    }
  }

  const inputFormat = runnerDoor || opts.input === 'rows' ? 'rows' : 'text'
  const outputFormat = runnerDoor || opts.format === 'rows' ? 'rows' : typedString(opts.format) ?? 'text'
  if (!runMode && (opts.input || opts.format || opts.partial)) failCli('Use mercury run for --input, --format and --partial')
  if (inputFormat === 'rows' && outputFormat !== 'rows') {
    failCli('--input rows requires run --format rows')
  }
  const includePartialMessages = Boolean(opts.partial)
  if (opts.partial && (!runMode || outputFormat !== 'rows')) {
    failCli('--partial requires run --format rows')
  }
  if (opts.ephemeral === true && !runMode) {
    failCli('--ephemeral requires mercury run: an interactive session is hosted by the daemon and resumed from its transcript, so it always writes one')
  }

  if (opts.lean) {
    setFlagEnv('MERCURY_BARE', '1')
  }
  let inputPrompt = runMode && inputPromptArg === '-' ? undefined : inputPromptArg
  if (typedString(opts.draft)) {
    startCapturingEarlyInput()
    process.stdin.unshift?.(Buffer.from(String(opts.draft)))
  }

  const bypassFromRegistry = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS')) && !isRunArgv()
  const dangerouslySkipPermissions = Boolean(opts.sovereign) || opts.mode === 'sovereign' || bypassFromRegistry
  const allowDangerousSkip = Boolean(opts.allowSovereign)
  const { initialPermissionModeFromCLI, isSovereignDisabled } = await import('./utils/permissions/permissionSetup.js')
  const explicitMode = typedString(opts.mode) as PermissionMode | undefined
  if (opts.sovereign && explicitMode && !modeBypassesPermissions(explicitMode)) {
    failCli(`mercury run: --sovereign conflicts with --mode ${explicitMode}; choose one permission posture`)
  }
  if ((opts.sovereign || opts.mode === 'sovereign' || allowDangerousSkip) && isSovereignDisabled()) {
    const word = opts.sovereign ? '--sovereign' : opts.mode === 'sovereign' ? '--mode sovereign' : '--allow-sovereign'
    failCli(`mercury run: ${word} is disabled by permissions policy`)
  }
  const resolved = initialPermissionModeFromCLI({
    permissionModeCli: typedString(opts.mode),
    dangerouslySkipPermissions,
  })
  const permissionMode: PermissionMode = resolved.mode
  const { setSessionSovereign } = await import('./bootstrap/state.js')
  setSessionSovereign(modeBypassesPermissions(permissionMode))

  const permissionInit = await initializeToolPermissionContext({
    allowedToolsCli: (opts.allowedTools as string[] | undefined) ?? [],
    disallowedToolsCli: (opts.blockTools as string[] | undefined) ?? [],
    baseToolsCli: opts.toolset as string[] | undefined,
    permissionMode,
    allowDangerouslySkipPermissions: allowDangerousSkip,
  })
  let toolPermissionContext = permissionInit.toolPermissionContext
  for (const warning of permissionInit.warnings) console.error(warning)
  if (permissionInit.dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext)
  }

  const assistantBootActive = false
  setAssistantModeActive(assistantBootActive)

  let worktreeName = typeof worktreeOpt === 'string' ? worktreeOpt : undefined
  let worktreePRNumber: number | undefined
  if (worktreeName) {
    const prMatch = /^#(\d+)$/.exec(worktreeName) ?? /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(worktreeName)
    if (prMatch) {
      worktreePRNumber = Number(prMatch[1])
      worktreeName = undefined
    }
  }
  const { isWorktreeModeEnabled } = await import('./utils/worktreeModeEnabled.js')
  const worktreeEnabled = Boolean(worktreeOpt) && isWorktreeModeEnabled()

  const thinkingOpt = typedString(opts.reasoningMode)
  const { noteSessionThinkingConfig, shouldEnableThinkingByDefault } = await import('./utils/thinking.js')
  let thinkingConfig: import('./utils/thinking.js').ThinkingConfig
  if (thinkingOpt === 'enabled' || thinkingOpt === 'adaptive') thinkingConfig = { type: 'adaptive' }
  else if (thinkingOpt === 'disabled') thinkingConfig = { type: 'disabled' }
  else {
    const envTokens = flagEnv('MERCURY_THINKING_BUDGET')
    const budget = envTokens !== undefined ? Number.parseInt(envTokens, 10) : undefined
    if (budget !== undefined && Number.isFinite(budget) && budget > 0) {
      thinkingConfig = { type: 'enabled', budgetTokens: budget }
    } else if (budget === 0) {
      thinkingConfig = { type: 'disabled' }
    } else {
      thinkingConfig = shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' }
    }
  }
  noteSessionThinkingConfig(thinkingConfig)

  const agentInfo = await getAgentDefinitionsWithOverrides()
  let activeAgents = agentInfo.activeAgents
  let allAgents = agentInfo.allAgents
  if (typedString(opts.agentDefs)) {
    try {
      const cliAgents = parseAgentsFromJson(JSON.parse(typedString(opts.agentDefs)!) as unknown)
      allAgents = [...allAgents, ...cliAgents]
      activeAgents = computeActiveAgents(allAgents)
    } catch (error) {
      logError(error)
    }
  }
  const requestedAgent = typedString(opts.agent) ?? getInitialSettings().engine?.agent
  let mainThreadAgentDefinition: AgentDefinition | undefined
  if (requestedAgent) {
    mainThreadAgentDefinition = activeAgents.find(agent => agent.agentType === requestedAgent)
    if (!mainThreadAgentDefinition) {
      const refusal = `unknown agent '${requestedAgent}' — available: ${activeAgents.map(agent => agent.agentType).join(', ')}`
      if (typedString(opts.agent) !== undefined) {
        failCli(refusal)
      }
      process.stderr.write(`${refusal} (from settings.engine.agent — running without it)\n`)
      logForDebugging(refusal)
    } else {
      setMainThreadAgentType(requestedAgent)
      void import('./utils/sessionStorage.js')
        .then(storage => storage.saveAgentSetting(requestedAgent))
        .catch(() => {})
    }
  }

  let userSpecifiedModel = typedString(opts.model)
  if (userSpecifiedModel === 'default') userSpecifiedModel = getDefaultEngineModelSetting() ?? undefined
  let fallbackModel = typedString(opts.backupModel)
  if (fallbackModel === 'default') fallbackModel = getDefaultEngineModelSetting() ?? undefined
  if (!userSpecifiedModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
    userSpecifiedModel = mainThreadAgentDefinition.model
  }
  if (userSpecifiedModel) setEngineModelOverride(userSpecifiedModel)
  setInitialEngineModel(userSpecifiedModel ?? null)
  if (runMode) {
    const { readComputedDefaultCatalogue } = await import('./utils/model/computedDefault.js')
    await readComputedDefaultCatalogue()
  }
  const resolvedInitialModel = getEngineModel()

  if (agentId && agentName && crewName && agentTypeOpt) {
    let rolePrompt: string | undefined
    const roleDefinition = findRoleDefinition(agentTypeOpt, activeAgents)
    if (!roleDefinition) {
      logForDebugging(`unknown crewmate role '${agentTypeOpt}'; nothing appended`)
    } else {
      rolePrompt = getRoleSystemPrompt(roleDefinition) || undefined
    }
    if (rolePrompt) {
      appendSystemPrompt = [appendSystemPrompt, `# Role contract: ${agentTypeOpt}\n${rolePrompt}`]
        .filter(Boolean)
        .join('\n\n')
    } else {
      logForDebugging(`no boot-time role prompt for agent type '${agentTypeOpt}'; nothing appended`)
    }
  }

  const sessionTitle = typedString(opts.title)?.trim() || undefined

  let prompt: string | AsyncIterable<string> | undefined = inputPrompt
  let syntaxInput: string | undefined
  if (runnerDoor) {
    prompt = noStdinChunks()
  } else if (!process.stdin.isTTY) {
    if (inputFormat === 'rows') {
      prompt = readStdinChunks()
    } else {
      const collected = await readStdinWithPeek(runMode ? (inputPrompt === undefined ? -1 : 1_000) : 3000)
      if (collected === null && runMode && inputPrompt === undefined) failCli('mercury run could not read its prompt from stdin', 1)
      if (collected === null && inputPrompt === undefined) {
        writeErr(
          'No stdin data arrived within 3s; proceeding without piped input. Redirect from the null device to skip the wait, or keep the pipe open longer to include its data.',
        )
      }
      const pieces = [inputPrompt, collected ?? undefined].filter(
        (piece): piece is string => typeof piece === 'string' && piece.length > 0,
      )
      if (runMode && collected) syntaxInput = inputPrompt ?? ''
      prompt = runMode && inputPrompt && collected
        ? `${inputPrompt}\n\n<stdin>\n${collected}${collected.endsWith('\n') ? '' : '\n'}</stdin>`
        : pieces.length > 0 ? pieces.join('\n') : undefined
    }
  }

  if (
    (runMode || !process.stdout.isTTY) &&
    prompt === undefined &&
    !opts.resume &&
    !opts.continue &&
    !opts.pr &&
    inputFormat !== 'rows' &&
    mainThreadAgentDefinition?.initialPrompt == null
  ) {
    const variadicCandidates: Array<[string, unknown]> = [
      ['--allowed-tools', opts.allowedTools],
      ['--block-tools', opts.blockTools],
      ['--toolset', opts.toolset],
      ['--mcp', opts.mcp],
      ['--provider-preview', opts.providerPreview],
    ]
    const multi = variadicCandidates.filter(
      (pair): pair is [string, string[]] => Array.isArray(pair[1]) && pair[1].length >= 2,
    )
    const lastArgvToken = process.argv[process.argv.length - 1]
    const swallower =
      multi.find(([, values]) => values[values.length - 1] === lastArgvToken) ?? multi[0]
    if (swallower) {
      const [flag, values] = swallower
      const lastValue = values[values.length - 1] ?? ''
      failCli(
        `No prompt reached run, and the list flag ${flag} captured ${values.length} values — ` +
          `its last value ${JSON.stringify(lastValue)} may have been meant as the prompt ` +
          `(a variadic flag consumes every following bare argument). ` +
          `Put the prompt before the flag, or end the list with -- : ` +
          `${cliName} run ${flag} "..." -- "your prompt". ` +
          `If every value really is a list entry, provide the prompt via stdin or as a positional argument.`,
      )
    }
  }

  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof prompt === 'string') {
      prompt = `${mainThreadAgentDefinition.initialPrompt}\n${prompt}`
      if (syntaxInput !== undefined) syntaxInput = `${mainThreadAgentDefinition.initialPrompt}\n${syntaxInput}`
    } else if (prompt === undefined) {
      prompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  if (runMode && inputFormat === 'text' && (prompt === undefined || (typeof prompt === 'string' && !prompt.trim())) && !opts.resume && !opts.continue && !opts.pr) {
    const usage = 'Usage: mercury run "<prompt>" or pipe a prompt to mercury run -'
    if (process.stdin.isTTY) {
      writeSync(2, `${usage}\n`)
      process.exit(2)
    }
    failCli(usage)
  }

  consumeSessionKitPin()
  const dynamicConfigResult = parseDynamicMcpConfigs((opts.mcp as string[] | undefined) ?? [])
  if (dynamicConfigResult.errors.length > 0) {
    logForDebugging(
      `${dynamicConfigResult.errors.length} MCP config error(s): ${dynamicConfigResult.errors.join('; ')}`,
    )
    failCli(`Invalid MCP configuration:\n${dynamicConfigResult.errors.join('\n')}`)
  }
  let dynamicMcpConfig = dynamicConfigResult.servers

  const policyFiltered = filterMcpServersByPolicy(dynamicMcpConfig)
  const blockedNames = Object.keys(dynamicMcpConfig).filter(name => !(name in policyFiltered.allowed))
  if (blockedNames.length > 0) {
    writeErr(
      chalk.yellow(
        `${blockedNames.length === 1 ? 'MCP server' : 'MCP servers'} blocked by managed policy: ${blockedNames.join(', ')}`,
      ),
    )
  }
  dynamicMcpConfig = policyFiltered.allowed as typeof dynamicMcpConfig

  if (doesEnterpriseMcpConfigExist()) {
    if (opts.onlyMcp) failCli('--only-mcp is not available when an enterprise MCP configuration exists', 1)
    const allowedCheck = areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
    if (allowedCheck !== true) {
      failCli('Dynamic MCP servers are not allowed when an enterprise MCP configuration exists', 1)
    }
  }
  const strictOrBare = Boolean(opts.onlyMcp) || isBareMode()
  const mcpResolutionStartedAt = Date.now()
  const discoveredMcpPromise: Promise<Record<string, ScopedMcpServerConfig>> = strictOrBare
    ? Promise.resolve({})
    : getMercuryMcpConfigs(dynamicMcpConfig).then(resolved => resolved.servers)
  const mcpConfigPromise = discoveredMcpPromise.then(discovered => {
    const regular: Record<string, ScopedMcpServerConfig> = Object.assign(Object.create(null), discovered, dynamicMcpConfig) as Record<string, ScopedMcpServerConfig>
    logForDebugging(`MCP config resolution took ${Date.now() - mcpResolutionStartedAt}ms`)
    return regular
  })
  const regularDynamicMcpConfig: Record<string, ScopedMcpServerConfig> = dynamicMcpConfig

  if (process.env.MERCURY_ENTRYPOINT !== 'local-agent') {
    initBundledSkills()
    const { initBundledWorkflows } = await import('./tools/WorkflowTool/bundled/index.js')
    initBundledWorkflows()
  }
  const { getProjectRoot, getOriginalCwd } = await import('./bootstrap/state.js')
  const cwd = process.cwd()
  if (!worktreeEnabled && !isNonInteractiveSession && checkHasTrustDialogAccepted()) {
    void getInstructionFiles().catch(() => {})
  }
  profileCheckpoint('action_before_setup')
  const setupPromise = setup(
    cwd,
    permissionMode,
    allowDangerousSkip,
    worktreeEnabled,
    worktreeName,
    tmuxEnabled,
    sessionIdOpt ?? null,
    worktreePRNumber,
    undefined,
  )
  let commandsPromise: Promise<import('./commands.js').Command[]>
  if (worktreeEnabled) {
    await setupPromise
    commandsPromise = getCommands(getProjectRoot())
  } else {
    setupPromise.catch(() => {})
    commandsPromise = getCommands(cwd)
    commandsPromise.catch(() => {})
    await setupPromise
  }
  profileCheckpoint('action_after_setup')
  const commands = await commandsPromise
  profileCheckpoint('action_commands_loaded')

  if (isNonInteractiveSession) {
    applyMergedConfigEnv()
    void getSystemContext().catch(() => {})
    void getUserContext().catch(() => {})
  }
  logForDiagnosticsNoPII('info', 'mercury_started', {
    version: MERCURY_VERSION,
    bundled: typeof (globalThis as { MACRO?: unknown }).MACRO !== 'undefined',
  })
  registerCleanup(async () => {
    logForDiagnosticsNoPII('info', 'mercury_exited')
  })

  const setupTrigger: 'init' | 'maintenance' | undefined =
    opts.prepareOnly || opts.prepare ? 'init' : opts.upkeep ? 'maintenance' : undefined

  if (opts.concourseOff === true || opts.concourseOn === true) {
    const { setConcourseEnabled } = await import('./services/concourse/concourseEnabled.js')
    const lastSwitch = [...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')
    setConcourseEnabled(lastSwitch === '--concourse-on')
  }

  if (!isNonInteractiveSession) {
    await interactiveLaunch({
      opts,
      commands,
      prompt: typeof prompt === 'string' ? prompt : undefined,
      permissionMode,
      toolPermissionContext,
      allowDangerousSkip,
      dynamicMcpConfig:
        Object.keys(regularDynamicMcpConfig).length > 0 ? regularDynamicMcpConfig : undefined,
      thinkingConfig,
      resolvedInitialModel,
      userSpecifiedModel,
      mainThreadAgentDefinition,
      activeAgents,
      allAgents,
      sessionTitle,
      setupTrigger,
      crewmateContext: { agentId, agentName, crewName, agentColor, parentSessionId },
    })
    return
  }

  await runLaunch({
    opts,
    commands,
    prompt,
    syntaxInput,
    permissionMode,
    toolPermissionContext,
    allowDangerousSkip,
    mcpConfigPromise,
    thinkingConfig,
    userSpecifiedModel,
    fallbackModel,
    mainThreadAgentDefinition,
    activeAgents,
    allAgents,
    customSystemPrompt,
    appendSystemPrompt,
    inputFormat,
    outputFormat,
    includePartialMessages,
    setupTrigger,
    door: runnerDoor ? 'wire' : 'rows',
  })
}

async function* readStdinChunks(): AsyncIterable<string> {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) yield chunk as string
}

async function* noStdinChunks(): AsyncIterable<string> {}

function readStdinWithPeek(timeoutMs: number): Promise<string | null> {
  return new Promise(resolvePeek => {
    const chunks: string[] = []
    const onData = (chunk: string): void => { chunks.push(chunk) }
    const finish = (empty: string | null): void => {
      clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      resolvePeek(chunks.length > 0 ? chunks.join('') : empty)
    }
    const onEnd = (): void => finish('')
    const onError = (): void => finish(null)
    const timer = timeoutMs < 0 ? undefined : setTimeout(() => finish(null), timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
  })
}

function parseDynamicMcpConfigs(items: string[]): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: string[]
} {
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const errors: string[] = []
  for (const rawItem of items) {
    const item = rawItem.trim()
    if (!item) continue
    let inlineObject: unknown
    let isInline = false
    try {
      inlineObject = JSON.parse(item)
      isInline = true
    } catch {
      isInline = false
    }
    const parsed = isInline
      ? parseMcpConfig({ configObject: inlineObject, expandVars: true, scope: 'dynamic' })
      : parseMcpConfigFromFilePath({ filePath: item, expandVars: true, scope: 'dynamic' })
    for (const entry of parsed.errors) errors.push(`${entry.path}: ${entry.message}`)
    Object.assign(servers, parsed.config?.mcpServers ?? {})
  }
  return { servers, errors }
}

async function interactiveLaunch(args: {
  opts: RootOptions
  commands: import('./commands.js').Command[]
  prompt: string | undefined
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  thinkingConfig: import('./utils/thinking.js').ThinkingConfig
  resolvedInitialModel: string
  userSpecifiedModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  sessionTitle: string | undefined
  setupTrigger: 'init' | 'maintenance' | undefined
  crewmateContext: {
    agentId?: string
    agentName?: string
    crewName?: string
    agentColor?: string
    parentSessionId?: string
  }
}): Promise<void> {
  const { opts, commands } = args
  let inputPrompt = args.prompt

  if (opts.prepareOnly) {
    applyMergedConfigEnv()
    await processSetupHooks('init', { forceSyncExecution: true })
    await processSessionStartHooks('startup', { forceSyncExecution: true })
    await gracefulShutdown(0)
    return
  }

  profileCheckpoint('action_before_create_root')
  const { renderOptions, getFpsMetrics, stats } = getRenderContext(false)
  const { createRoot } = await import('./ink.js')
  const root = await createRoot(renderOptions)
  profileCheckpoint('action_after_create_root')

  const startupMeasuredAt = Date.now()
  const onboardingShown = await showSetupScreens(
    root,
    args.permissionMode,
    args.allowDangerousSkip,
    commands,
    undefined,
  )
  if (onboardingShown && inputPrompt?.trim().toLowerCase() === '/logins') {
    inputPrompt = undefined
  }
  if (onboardingShown) resetUserCache()
  const orgValidation = await validateForceLoginOrg()
  if (!orgValidation.valid) {
    await exitWithError(root, orgValidation.message)
    return
  }
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    announceAbandonedLaunch()
    logForDebugging('graceful shutdown already initiated; abandoning interactive launch')
    return
  }
  if (isShuttingDown()) {
    announceAbandonedLaunch()
    logForDebugging('shutdown in progress; abandoning interactive launch')
    return
  }

  registerBackgroundNode('lsp-manager', async () => {
    initializeLspServerManager()
  })
  registerBackgroundNode('example-commands', async () => {
    await refreshExampleCommands()
  })
  registerBackgroundNode('session-registry', async () => {
    await registerSession()
    if (args.sessionTitle) await updateSessionName(args.sessionTitle)
    try {
      const { readSessionWorkers } = await import('./daemon/concourseWorkers.js')
      const { sweepPrefixRecords } = await import('./services/providers/anthropic/prefixRecordStore.js')
      const liveSessionIds = Object.values(readSessionWorkers()).filter(record => record.endedAt === undefined).map(record => record.sessionId)
      await sweepPrefixRecords({ liveSessionIds })
    } catch (error) {
      logForDebugging(`preserved thinking: the prefix record sweep did not run (${String(error)})`)
    }
  })
  registerBackgroundNode('session-telemetry', async () => {
    void getEngineModel()
    const { ensureExtensionsLoaded } = await import('./extensions/boot.js')
    await ensureExtensionsLoaded().catch(() => {})
  })
  registerBackgroundNode('shim-reconcile', async () => {
    try {
      writeShimSet(resolveLayoutRoots())
    } catch (error) {
      logForDebugging(`shim reconcile failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  registerBackgroundNode('deferred-prefetches', () => {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  })
  registerBackgroundNode('process-registry', async () => {
    const { registerCockpit, recordProcessCensusAtBoot, COCKPIT_HEARTBEAT_MS } = await import('./daemon/processSweepRun.js')
    if (process.stdin.isTTY) {
      const registration = await registerCockpit({ terminal: null })
      if (registration !== null) {
        const beat = setInterval(() => void registration.heartbeat(), COCKPIT_HEARTBEAT_MS)
        beat.unref()
        registerCleanup(async () => {
          clearInterval(beat)
          await registration.clear()
        })
      }
    }
    const census = await recordProcessCensusAtBoot()
    logForDebugging(`process census at boot: ${census.entries.length} Mercury process(es) read, ${census.entries.filter(entry => entry.classification === 'stale').length} stale — nothing ended at boot`)
  })

  const settingsErrors = getSettingsWithErrors().errors.filter(
    error => error.mcpErrorMetadata === undefined,
  )
  if (settingsErrors.length > 0) {
    await launchInvalidSettingsDialog(root, {
      settingsErrors,
      onExit: () => void gracefulShutdown(1),
    })
  }

  const notifications: { key: string; text: string; color?: string }[] = []
  const { initialPermissionModeFromCLI } = await import('./utils/permissions/permissionSetup.js')
  const modeNotification = initialPermissionModeFromCLI({
    permissionModeCli: typedString(opts.mode),
    dangerouslySkipPermissions: modeBypassesPermissions(args.permissionMode),
  }).notification
  if (modeNotification) {
    notifications.push({ key: 'permission-mode-notification', text: modeNotification })
  }
  const deprecationWarning = getModelDeprecationWarning(args.resolvedInitialModel)
  if (deprecationWarning) {
    notifications.push({ key: 'model-deprecation-warning', text: deprecationWarning, color: 'warning' })
  }

  const effectiveContext = args.toolPermissionContext

  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().engine?.effort
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') addBootNote('warn', effortEnv.sentence)
  const { setDynamicCrewContext } = await import('./utils/crewmate.js')
  const hasCrewmateIdentity = Boolean(
    args.crewmateContext.agentId && args.crewmateContext.agentName && args.crewmateContext.crewName,
  )
  const crewContext = hasCrewmateIdentity
    ? {
        agentId: args.crewmateContext.agentId!,
        agentName: args.crewmateContext.agentName!,
        crewName: args.crewmateContext.crewName!,
        color: args.crewmateContext.agentColor,
        parentSessionId: args.crewmateContext.parentSessionId,
      }
    : undefined
  if (crewContext) setDynamicCrewContext(crewContext)
  const initialCrewContext = computeInitialCrewContext()
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: effectiveContext,
    verbose: config.toolOutput === 'full',
    expandedView: config.showSpinnerTree ? 'crewmates' : config.showExpandedTasks ? 'tasks' : 'none',
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    agent: args.mainThreadAgentDefinition?.agentType,
    agentDefinitions: { activeAgents: args.activeAgents, allAgents: args.allAgents },
    ...(initialCrewContext ? { crewContext: initialCrewContext } : {}),
    remoteControlEnabled: getRemoteControlAtStartup() || assistantBridgeSeed(),
    promptSuggestionEnabled: false,
    ...(inputPrompt
      ? {
          initialMessage: {
            message: createUserMessage({ content: inputPrompt }),
          },
        }
      : {}),
  }
  const appStateStore = createStore<AppState>(initialState, ({ newState, oldState }) =>
    onChangeAppState({ newState, oldState }),
  )

  if (inputPrompt) {
    const { addToHistory } = await import('./history.js')
    addToHistory(inputPrompt)
  }

  saveGlobalConfigDeferred(current => ({ ...current, numStartups: (current.numStartups ?? 0) + 1 }))
  clearBootAttempts()
  armProvisionalSessionReconcile()
  registerBackgroundNode('startup-records', async () => {
    await flushDeferredGlobalConfigSaves()
    try {
      recordInvocation()
    } catch {
    }
  })

  {
    const { armQuitParksAll } = await import('./services/switchboard/quitParksAll.js')
    armQuitParksAll()
  }
  if (opts.continue || opts.resume || opts.pr || inputPrompt) {
    markExplicitBootJourney()
  }
  if (opts.chat === true) {
    const { markChatBoot } = await import('./context/surfaceRoute.js')
    markChatBoot()
  }

  const appProps = {
    getFpsMetrics,
    stats,
    initialState,
  }
  const chatProps: ChatProps = {
    commands,
    initialTools: [...getTools(effectiveContext)],
    debug: Boolean(opts.debug || opts.d),
    disableSlashCommands: opts.commands === false,
  }

  if (!getIsInteractive()) return

  armBackgroundDiscovery();

  try {
    type ResumeLog = { fullPath?: string; customTitle?: string; agentName?: string }
    const resumeAtBoot = async (sessionId: string, log: ResumeLog): Promise<boolean> => {
      const { focusResumedSession } = await import('./services/switchboard/hopIntoSession.js')
      const outcome = await focusResumedSession(sessionId, log.fullPath, {
        ...(log.customTitle ?? log.agentName ? { title: (log.customTitle ?? log.agentName) as string } : {}),
        permissionMode: args.permissionMode,
        ...(typedString(opts.model) !== undefined ? { model: args.resolvedInitialModel } : {}),
        ...(typeof opts.effort === 'string' ? { effort: opts.effort } : {}),
      })
      if (outcome.ok) return true
      await exitWithError(root, `Failed to resume session ${sessionId}: ${outcome.reason}`)
      return false
    }
    {
      const facts = await import('./services/switchboard/bootBirthFacts.js')
      const { runnerArgvFromBoot } = await import('./services/switchboard/runnerArgv.js')
      facts.setBootBirthFacts({
        title: args.sessionTitle ?? null,
        effort: typeof opts.effort === 'string' ? opts.effort : null,
        permissionMode: args.permissionMode,
        bypassConsent: effectiveContext.isBypassPermissionsModeAvailable === true,
        runnerArgv: runnerArgvFromBoot(process.argv.slice(2)),
      })
    }
    if (opts.continue) {
      const lastLog = await sessionAtIndex(0)
      const sessionId = lastLog ? sessionIdOfListing(lastLog as Parameters<typeof sessionIdOfListing>[0]) : undefined
      if (!lastLog || !sessionId) {
        await exitWithError(root, 'No conversation found to continue')
        return
      }
      if (!(await resumeAtBoot(String(sessionId), lastLog as ResumeLog))) return
    } else if (opts.resume || opts.pr) {
      const resumeValue = opts.resume
      const fromPr = opts.pr
      let searchTerm: string | undefined
      let resumeLog: ResumeLog | null = null
      let resumeSessionId: string | undefined
      if (typeof resumeValue === 'string' && !UUID_SHAPE.test(resumeValue)) {
        const matches = await searchSessionsByCustomTitle(resumeValue)
        if (Array.isArray(matches) && matches.length === 1) {
          resumeLog = matches[0] as ResumeLog
          resumeSessionId = sessionIdOfListing(matches[0] as Parameters<typeof sessionIdOfListing>[0])
        } else {
          searchTerm = resumeValue
        }
      } else if (typeof resumeValue === 'string') {
        const log = await lastSession(resumeValue as UUID).catch(() => null)
        if (!log) {
          await exitWithError(root, `No conversation found for session id ${resumeValue}`)
          return
        }
        resumeLog = log as ResumeLog
        resumeSessionId = resumeValue
      }
      if (resumeLog && resumeSessionId) {
        if (!(await resumeAtBoot(String(resumeSessionId), resumeLog))) return
      } else {
        const { getWorktreePaths } = await import('./utils/getWorktreePaths.js')
        const worktreePathsPromise = getWorktreePaths(process.cwd()).catch(() => [] as string[])
        await launchResumeChooser(root, appProps, worktreePathsPromise, {
          ...chatProps,
          initialSearchQuery: searchTerm,
          forkSession: Boolean(opts.fork),
          filterByPr: fromPr === true ? true : typeof fromPr === 'string' ? fromPr : undefined,
        })
        return
      }
    } else {
      const promptIsWords = typeof inputPrompt === 'string' && inputPrompt.trim() !== '' && !inputPrompt.trimStart().startsWith('/')
      const { isFullscreenEnvEnabled } = await import('./utils/fullscreen.js')
      if (promptIsWords || !isFullscreenEnvEnabled()) {
        const { bornSession } = await import('./services/switchboard/bornSession.js')
        const birth = bornSession({ workspaceDir: getCwd(), model: null })
        void birth.then(async born => {
          if (born.ok) return
          logForDebugging(`[boot] the chat-forward birth was refused: ${born.reason}`)
          retractExplicitBootJourney()
          const { mintImmediateReceipt } = await import('./utils/model/seatReceipts.js')
          mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning')
        })
      }
    }

    await launchChat(root, appProps, chatProps, renderAndRun, {
      dynamicMcpConfig: args.dynamicMcpConfig,
      isStrictMcpConfig: Boolean(args.opts.onlyMcp),
    })
  } catch (error) {
    logError(error)
    const detail = error instanceof Error ? error.message : String(error)
    writeErr(`Mercury exited on an error: ${detail}`)
    const crashPath = lastCrashReportPath()
    if (crashPath) writeErr(`Crash report: ${crashPath}`)
    writeErr(`Run ${binaryName()} health for diagnostics.`)
    await crashShutdown(1)
    process.exit(1)
  }

  void startupMeasuredAt
}

function assistantBridgeSeed(): boolean {
  return false
}

async function connectMcpBatch(
  configs: Record<string, ScopedMcpServerConfig>,
  setAppState: (updater: (previous: AppState) => AppState) => void,
): Promise<void> {
  const { survivors, collided } = fenceMcpPrefixCollisions(configs)
  const { members, excluded } = partitionMcpConfigsByMembership(survivors)
  if (members.length === 0 && excluded.length === 0 && collided.length === 0) return
  setAppState(previous => ({
    ...previous,
    mcp: {
      ...previous.mcp,
      clients: [
        ...previous.mcp.clients,
        ...members.map(([name, config]) => ({ name, type: 'pending' as const, config })),
        ...excluded.map(([name, config]) => ({ name, type: 'disabled' as const, config })),
        ...collided.map(({ name, config, error }) => ({ name, type: 'failed' as const, config, error })),
      ],
    },
  }))
  await Promise.all(
    members.map(async ([name, config]) => {
      try {
        const client = await connectToServer(name, config)
        const [tools, commands] = await Promise.all([
          fetchToolsForClient(client),
          fetchCommandsForClient(client),
        ])
        setAppState(previous => ({
          ...previous,
          mcp: {
            ...previous.mcp,
            clients: previous.mcp.clients.map(entry => (entry.name === name ? client : entry)),
            tools: dedupeByName([...previous.mcp.tools, ...tools]),
            commands: dedupeByName([...previous.mcp.commands, ...commands]),
          },
        }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logForDebugging(`MCP connect failed for ${name}: ${reason}`)
        setAppState(previous => ({
          ...previous,
          mcp: {
            ...previous.mcp,
            clients: previous.mcp.clients.map(entry =>
              entry.name === name ? { name, type: 'failed' as const, config, error: reason } : entry,
            ),
          },
        }))
      }
    }),
  )
}

function dedupeByName<T extends { name?: string }>(entries: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name !== undefined && seen.has(name)) continue
    if (name !== undefined) seen.add(name)
    result.push(entry)
  }
  return result
}

async function runLaunch(args: {
  opts: RootOptions
  commands: import('./commands.js').Command[]
  prompt: string | AsyncIterable<string> | undefined
  syntaxInput?: string
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  mcpConfigPromise: Promise<Record<string, ScopedMcpServerConfig>>
  thinkingConfig: import('./utils/thinking.js').ThinkingConfig
  userSpecifiedModel: string | undefined
  fallbackModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  inputFormat: string
  outputFormat: string
  includePartialMessages: boolean
  setupTrigger: 'init' | 'maintenance' | undefined
  door: 'rows' | 'wire'
}): Promise<void> {
  const { opts } = args

  setHeadlessOneShot(args.inputFormat !== 'rows')

  if (mercuryLspEnabled() && qualifiedIdSpaceOf(getEngineModel())?.route !== 'local') {
    initializeLspServerManager()
    await waitForInitialization()
  }

  let tools = [...getTools(args.toolPermissionContext)]
  const jsonSchemaOpt = typedString(opts.schema)
  let parsedJsonSchema: Record<string, unknown> | undefined
  if (jsonSchemaOpt) {
    const { isSyntheticOutputToolEnabled, createSyntheticOutputTool } = await import(
      './tools/SyntheticOutputTool/SyntheticOutputTool.js'
    )
    if (isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })) {
      try {
        parsedJsonSchema = JSON.parse(jsonSchemaOpt) as Record<string, unknown>
        const synthetic = createSyntheticOutputTool(parsedJsonSchema)
        if ('tool' in synthetic) tools = [...tools, synthetic.tool]
      } catch {
      }
    }
  }
  profileCheckpoint('action_tools_loaded')

  const formatted = args.outputFormat === 'rows' || args.outputFormat === 'json'
  void formatted

  applyMergedConfigEnv()

  const sessionStartHooksPromise: Promise<HookResultMessage[]> =
    !opts.continue && !opts.resume && !args.setupTrigger
      ? processSessionStartHooks('startup', {
          agentType: args.mainThreadAgentDefinition?.agentType,
        })
      : Promise.resolve<HookResultMessage[]>([])
  sessionStartHooksPromise.catch(() => {})

  profileCheckpoint('before_validateForceLoginOrg')
  const orgValidation = await validateForceLoginOrg()
  if (!orgValidation.valid) {
    writeErr(orgValidation.message)
    process.exit(1)
  }

  const sessionRunner = flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
  const headlessCommands = opts.commands === false
    ? []
    : sessionRunner
      ? sessionSeatCommandTable(args.commands)
      : args.commands.filter(command => {
          if (command.type === 'prompt') {
            return command.disableNonInteractive !== true
          }
          if (command.type === 'local') {
            return command.supportsNonInteractive === true
          }
          if (command.type === 'local-jsx') {
            return (command.headlessVerbs ?? []).length > 0
          }
          return false
        })

  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().engine?.effort
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') process.stderr.write(`${effortEnv.sentence}\n`)
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: args.toolPermissionContext,
    verbose: config.toolOutput === 'full',
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
  }
  const store = createStore<AppState>(initialState, ({ newState, oldState }) =>
    onChangeAppState({ newState, oldState }),
  )

  if (modeBypassesPermissions(args.permissionMode) || args.allowDangerousSkip) {
    void import('./utils/permissions/bypassPermissionsKillswitch.js')
      .then(m =>
        m.checkAndDisableSovereignIfNeeded(
          store.getState().toolPermissionContext,
          updater => store.setState(updater),
        ),
      )
      .catch(() => {})
  }

  if (opts.ephemeral === true) {
    setSessionPersistenceDisabled(true)
  }

  if (Array.isArray(opts.providerPreview) && opts.providerPreview.length > 0) {
    const { filterAllowedSdkBetas } = await import('./utils/model/capabilities.js')
    const { setSdkBetas } = await import('./bootstrap/state.js')
    setSdkBetas(filterAllowedSdkBetas(opts.providerPreview.filter((beta): beta is string => typeof beta === 'string')))
  }

  profileCheckpoint('action_before_mcp_configs_await')
  const regularMcpConfigs = await args.mcpConfigPromise
  profileCheckpoint('action_mcp_configs_loaded')
  {
    if (consumeSessionKitPin().outcome === 'refused') {
      const receiptHome = getSessionProjectDir()
      if (receiptHome !== null) noteRefusedKitOnSessionReceipt(receiptHome, getSessionId())
    }
    const unresolved = sessionKitOf()
    if (unresolved !== undefined && unresolved.resolved === false) {
      const { completeSessionKitFromRoster } = await import('./services/mcp/kitCompletion.js')
      const { getActiveSet } = await import('./extensions/active.js')
      completeProcessSessionKit(
        completeSessionKitFromRoster(unresolved, {
          mcpNames: Object.keys(regularMcpConfigs),
          commands: args.commands,
          extensions: getActiveSet().active.map(ext => ext.manifest.name),
        }),
      )
    }
  }
  profileCheckpoint('before_connectMcp')
  if ((await withMcpLaunchBudget(connectMcpBatch(regularMcpConfigs, store.setState), mcpLaunchBudgetMs())) === 'timeout') {
    logForDebugging(`MCP servers were not all ready within ${mcpLaunchBudgetMs()}ms; continuing — late servers serve later calls`)
  }
  profileCheckpoint('after_connectMcp')
  await connectAnthropicConnectors(store)
  profileCheckpoint('after_connectMcp_claudeai')

  if (!isBareMode()) {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  }

  const { runHeadless } = await import('./cli/run.js')
  try {
    await runHeadless(
      args.prompt ?? '',
      store.getState,
      store.setState,
      headlessCommands,
      tools,
      args.activeAgents,
      {
        continue: Boolean(opts.continue),
        resume: opts.resume as string | boolean | undefined,
        outputFormat: args.outputFormat,
        syntaxInput: args.syntaxInput,
        jsonSchema: parsedJsonSchema,
        allowedTools: (opts.allowedTools as string[] | undefined) ?? [],
        thinkingConfig: args.thinkingConfig,
        maxTurns: opts.maxTurns as number | undefined,
        maxBudgetUsd: opts.budget as number | undefined,
        systemPrompt: args.customSystemPrompt,
        appendSystemPrompt: args.appendSystemPrompt,
        userSpecifiedModel: args.userSpecifiedModel ?? args.mainThreadAgentDefinition?.model ?? undefined,
        fallbackModel: args.fallbackModel,
        includePartialMessages: args.includePartialMessages,
        forkSession: Boolean(opts.fork),
        resumeSessionAt: typedString(opts.replayTo),
        rewindFiles: typedString(opts.restoreFiles),
        agent: typedString(opts.agent),
        workload: typedString(opts.meterTag),
        advise: opts.advise === true,
        setupTrigger: args.setupTrigger,
        bootSessionIdPinned: Boolean(typedString(opts.sessionId)),
        door: args.door,
        subscribeAppState: store.subscribe,
        sessionStartHooksPromise,
      },
    )
  } catch (error) {
    writeErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    if (!isShuttingDown()) {
      await gracefulShutdown(1)
    }
  }
}

async function connectAnthropicConnectors(store: {
  getState: () => AppState
  setState: (updater: (previous: AppState) => AppState) => void
}): Promise<void> {
  const strictOrBare = isBareMode()
  if (strictOrBare || doesEnterpriseMcpConfigExist()) return
  const timerBox: { timer?: ReturnType<typeof setTimeout> } = {}
  const bound = new Promise<'timeout'>(resolveTimeout => {
    timerBox.timer = setTimeout(() => resolveTimeout('timeout'), 5000)
  })
  const work = (async () => {
    const connectors = await fetchAnthropicConnectorsIfEligible()
    if (!connectors || Object.keys(connectors).length === 0) return
    const connectorEntries = connectors
    const state = store.getState()
    const connectorSignatures = new Set(
      Object.values(connectorEntries).map(config => getMcpServerSignature(config)),
    )
    const suppressed: string[] = []
    for (const client of state.mcp.clients) {
      if (!client.name.startsWith('ext:')) continue
      const signature = getMcpServerSignature(client.config)
      if (!connectorSignatures.has(signature)) continue
      suppressed.push(client.name)
      if (client.type === 'connected') {
        await clearServerCache(client.name, client.config).catch(() => {})
      }
    }
    const manualSignatures = new Set(
      store
        .getState()
        .mcp.clients.filter(
          client => !client.name.startsWith('ext:') && !suppressed.includes(client.name),
        )
        .map(client => getMcpServerSignature(client.config)),
    )
    const surviving: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
    for (const [name, connectorConfig] of Object.entries(connectorEntries)) {
      if (manualSignatures.has(getMcpServerSignature(connectorConfig))) continue
      surviving[name] = connectorConfig
    }
    if (suppressed.length > 0) {
      const suppressedPrefixes = suppressed.map(name => getMcpPrefix(name))
      store.setState(previous => ({
        ...previous,
        mcp: {
          ...previous.mcp,
          clients: previous.mcp.clients.filter(client => !suppressed.includes(client.name)),
          tools: previous.mcp.tools.filter(
            tool => !suppressed.includes(tool.mcpInfo?.serverName ?? ''),
          ),
          commands: previous.mcp.commands.filter(
            command => !suppressedPrefixes.some(prefix => command.name.startsWith(prefix)),
          ),
          resources: Object.fromEntries(
            Object.entries(previous.mcp.resources ?? {}).filter(([serverName]) => !suppressed.includes(serverName)),
          ),
        },
      }))
    }
    await connectMcpBatch(surviving, store.setState)
  })()
  const raced = await Promise.race([work, bound])
  if (timerBox.timer !== undefined) clearTimeout(timerBox.timer)
  if (raced === 'timeout') {
    logForDebugging('claude.ai connectors were not ready within 5s; continuing')
  }
}

export function startDeferredPrefetches(): void {
  if (isBareMode()) return
  void import('./services/api/clientContractLearned.js')
    .then(({ startClientContractPeek }) => startClientContractPeek())
    .catch((error: unknown) => logForDebugging(`client contract: the daily peek did not start: ${String(error)}`))
  void (async () => {
    try {
      void getCoreUserData()
      void getUserContext().catch(() => {})
      if (!getIsInteractive()) {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
        void getSystemContext().catch(() => {})
      } else if (checkHasTrustDialogAccepted()) {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
        void getSystemContext().catch(() => {})
      } else {
        logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
      }
      void getTipToShowOnSpinner().catch(() => {})
      const { prefetchThirdPartyCredentials } = (await import('./utils/api.js')) as {
        prefetchThirdPartyCredentials?: () => void
      }
      prefetchThirdPartyCredentials?.()
      if (getIsInteractive()) void countFilesRoundedRg(process.cwd(), AbortSignal.timeout(3000)).catch(() => {})
      const { getModelCapability } = (await import('./utils/model/capabilities.js')) as {
        getModelCapability?: (model: string) => unknown
      }
      getModelCapability?.(getEngineModel())
      settingsChangeDetector.initialize()
      skillChangeDetector.initialize()
    } catch (error) {
      logError(error)
    }
  })()
  if (flagEnv('MERCURY_STALL_DETECTOR') !== '0') {
    startEventLoopStallDetector()
  }
}
