import { Command as CommanderCommand, InvalidArgumentError, Option } from 'commander'
import { writeSync } from 'node:fs'
import React from 'react'
import {
  getIsInteractive,
  getSessionId,
  setAddedDirectories,
  setClientType,
  setInitialMainLoopModel,
  setSessionExtensions,
  setHeadlessOneShot,
  setIsInteractive,
  setMainLoopModelOverride,
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
import { launchRepl } from './replLauncher.js'
import { fetchBootstrapData } from './services/api/bootstrap.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/featureGates.js'
import { checkQuotaStatus } from './services/claudeAiLimits.js'
import { getInstructionFiles } from './services/instructions/engine.js'
import { initializeLspServerManager } from './services/lsp/manager.js'
import { fetchClaudeAIMcpConfigsIfEligible } from './services/mcp/claudeai.js'
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
import {
  coordinationServerConfig,
  isCoordinationServerEnabled,
  COORDINATION_SERVER_NAME,
} from './services/mcp/coordinationServer.js'
import { loadPolicyLimits } from './services/policyLimits/index.js'
import { loadRemoteManagedSettings } from './services/remoteManagedSettings/index.js'
import { clearBootAttempts } from './substrate/bootBeacon.js'
import { addBootNote, collectLauncherNotes } from './substrate/bootNotes.js'
import { flagEnv } from './substrate/flagRegistry.js'
import { recordInvocation } from './substrate/invocationRecord.js'
import { recordLaunchMilestone } from './substrate/launchMilestones.js'
import { markExplicitBootJourney, retractExplicitBootJourney } from './substrate/splashHandover.js'
import { getCwd } from './utils/cwd.js'
import { applyBootMenuEnv, recordBootAdmissionSnapshot, resolveEffectiveSettingsSnapshot } from './substrate/startupMenu.js'
import { setAssistantModeActive } from './tasks/LocalShellTask/LocalShellTask.js'
import { getTools } from './tools.js'
import { getAgentDefinitionsWithOverrides, computeActiveAgents, parseAgentsFromJson, type AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { init } from './entrypoints/init.js'
import { preconnectAnthropicApi } from './utils/apiPreconnect.js'
import { releaseLauncherAltHoldNow } from './ink/launcherAltHold.js'
import { resolveTerminalExperience } from './ink/session/terminalExperience.js'
import {
  exitWithError,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from './interactiveHelpers.js'
import { launchInvalidSettingsDialog, launchResumeChooser } from './dialogLaunchers.js'
import { isValidAdvisorModel, canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, modelSupportsAdvisor } from './utils/advisor.js'
import { hasFirstPartyCredential, validateForceLoginOrg } from './utils/auth.js'
import { startBackgroundHousekeeping } from './utils/backgroundHousekeeping.js'
import { getGlobalConfig, saveGlobalConfig, saveGlobalConfigDeferred, flushDeferredGlobalConfigSaves, binaryName, getRemoteControlAtStartup, getCurrentProjectConfig } from './utils/config.js'
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
import { getDefaultMainLoopModelSetting, getMainLoopModel, getCanonicalName, normalizeModelStringForAPI } from './utils/model/model.js'
import {
  initializeToolPermissionContext,
  stripDangerousPermissionsForAutoMode,
} from './utils/permissions/permissionSetup.js'
import { PERMISSION_MODES, decodePermissionModeSpelling, modeBypassesPermissions, type PermissionMode } from './utils/permissions/PermissionMode.js'
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'
import { migrateChangelogFromConfig } from './utils/releaseNotes.js'
import { resetUserCache, getCoreUserData } from './utils/user.js'
import { maybeRunMinervaOnBoot } from './utils/tabula/minerva.js'
import { settingsChangeDetector } from './utils/settings/changeDetector.js'
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js'
import { getSettingsWithErrors, getInitialSettings } from './utils/settings/settings.js'
import { parseSettingSourcesFlag } from './utils/settings/constants.js'
import { resetSettingsCache, setSessionSettingsCache } from './utils/settings/settingsCache.js'
import { setFlagSettingsInline, setFlagSettingsPath, setAllowedSettingSources, getSessionProjectDir, getOriginalCwd } from './bootstrap/state.js'
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js'
import { getLastSessionLog, getLogByIndex, searchSessionsByCustomTitle, fetchLogs, sessionIdExists } from './utils/sessionStorage.js'
import { getSessionIdFromLog } from './utils/sessionStorage/logs.js'
import { armProvisionalSessionReconcile } from './utils/provisionalSessionReconcile.js'
import { computeInitialTeamContext } from './utils/swarm/reconnection.js'
import { findRoleDefinition, getRoleSystemPrompt } from './utils/swarm/roleResolver.js'
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
import type { Props as REPLProps } from './screens/REPL.js'
import type { UUID } from 'node:crypto'
import { runThemisCli } from './cli/themisCli.js'
import { update as updateCli } from './cli/update.js'
import type { McpSdkServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js'
import { setCliTeammateModeOverride } from './utils/swarm/backends/teammateModeSnapshot.js'
import { writeShimSet, resolveLayoutRoots } from './services/privateChannel/installLayout.js'
import { migrateAutoUpdatesToSettings } from './migrations/migrateAutoUpdatesToSettings.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js'
import { resetProToOpusDefault } from './migrations/resetProToOpusDefault.js'
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js'
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js'
import { migrateSonnet45ToSonnet46 } from './migrations/migrateSonnet45ToSonnet46.js'
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import type { Root } from './ink.js'
import chalk from 'chalk'
import { randomUUID } from 'node:crypto'

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

const BYPASS_ALIASES: Record<string, string> = {
  '--dangerously-bypass-permissions': '--dangerously-skip-permissions',
  '--allow-dangerously-bypass-permissions': '--allow-dangerously-skip-permissions',
}

function isPrintModeArgv(argv: readonly string[] = process.argv): boolean {
  return argv.includes('-p') || argv.includes('--print')
}

function applyMergedConfigEnv(): void {
  const env = getInitialSettings().env ?? {}
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = String(value)
  }
}


const MIGRATION_VERSION = 11

function runMigrationsIfNeeded(): void {
  try {
    const config = getGlobalConfig()
    if (config.migrationVersion === MIGRATION_VERSION) return
    const landed: boolean[] = []
    landed.push(migrateAutoUpdatesToSettings())
    landed.push(migrateBypassPermissionsAcceptedToSettings())
    landed.push(migrateEnableAllProjectMcpServersToSettings())
    resetProToOpusDefault()
    landed.push(migrateSonnet1mToSonnet45())
    landed.push(migrateLegacyOpusToCurrent())
    landed.push(migrateSonnet45ToSonnet46())
    landed.push(migrateOpusToOpus1m())
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    const incomplete = landed.some(ok => ok === false)
    if (incomplete) {
      logForDebugging(
        'a startup migration could not land its settings write; the migration version stamp is withheld so the set retries next boot',
        { level: 'error' },
      )
    }
    if (!incomplete && getGlobalConfig().migrationVersion !== MIGRATION_VERSION) {
      saveGlobalConfig(current =>
        current.migrationVersion !== MIGRATION_VERSION
          ? { ...current, migrationVersion: MIGRATION_VERSION }
          : current,
      )
    }
  } catch (error) {
    logError(error)
    logForDebugging('a config migration threw; boot continues')
  }
  void migrateChangelogFromConfig().catch(() => {})
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function typedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function typedBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function writeErr(text: string): void {
  releaseLauncherAltHoldNow()
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
}

function wantsStreamJsonEnvelope(): boolean {
  const argv = process.argv
  if (!argv.includes('-p') && !argv.includes('--print')) return false
  const flagIndex = argv.indexOf('--output-format')
  const spelled =
    flagIndex >= 0
      ? argv[flagIndex + 1]
      : argv.find(arg => arg.startsWith('--output-format='))?.slice('--output-format='.length)
  return spelled === 'stream-json'
}

function failCli(message: string): never {
  if (wantsStreamJsonEnvelope()) {
    try {
      const envelope = {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        errors: [message],
      }
      writeSync(1, `${JSON.stringify(envelope)}\n`)
      process.exit(1)
    } catch {
    }
  }
  writeErr(chalk.red(message))
  process.exit(1)
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

  process.argv = process.argv.map(arg => BYPASS_ALIASES[arg] ?? arg)

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
  if (!isPrintModeArgv()) {
    process.on('SIGINT', () => process.exit(0))
  }
  profileCheckpoint('main_warning_handler_initialized')

  const printFlag = isPrintModeArgv()
  const initOnlyFlag = process.argv.includes('--init-only')
  const stdoutTty = Boolean(process.stdout.isTTY)
  const isNonInteractive = printFlag || initOnlyFlag || !stdoutTty
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }
  setIsInteractive(!isNonInteractive)
  if (!stdoutTty && !printFlag && !initOnlyFlag && process.stdin.isTTY) {
    writeErr(
      'stdout is not attached to a terminal, so this run is non-interactive. Pass -p to silence this note, or attach a terminal to get the interactive session.',
    )
  }

  if (!process.env.MERCURY_ENTRYPOINT) {
    const mcpIndex = process.argv.indexOf('mcp')
    const mcpServe = mcpIndex >= 0 && process.argv[mcpIndex + 1] === 'serve'
    process.env.MERCURY_ENTRYPOINT = mcpServe ? 'mcp' : isNonInteractive ? 'sdk' : 'cli'
  }

  const entrypoint = process.env.MERCURY_ENTRYPOINT
  const clientType = isEnvTruthy(process.env.GITHUB_ACTIONS)
    ? 'github-action'
    : entrypoint === 'sdk'
      ? 'sdk'
      : entrypoint === 'local-agent'
        ? 'local-agent'
        : 'cli'
  setClientType(clientType)

  if (clientType !== 'sdk' && clientType !== 'local-agent') {
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
  const eagerFlagValue = (name: string): string | undefined => {
    let value: string | undefined
    for (let i = 0; i < optionArgv.length; i++) {
      const token = optionArgv[i]
      if (token === name) value = optionArgv[i + 1]
      else if (token !== undefined && token.startsWith(`${name}=`)) value = token.slice(name.length + 1)
    }
    return value
  }
  const settingsValue = eagerFlagValue('--settings')
  if (settingsValue !== undefined) {
    const value = settingsValue
    if (value && value.length > 0) {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          failCli('The JSON supplied to --settings is invalid.')
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
        const settingsPath = join(tmpdir(), `claude-settings-${hash}.json`)
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
          failCli(`Failed while processing --settings: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  const sourcesValue = eagerFlagValue('--setting-sources')
  if (sourcesValue !== undefined || optionArgv.includes('--setting-sources')) {
    try {
      const value = sourcesValue ?? ''
      setAllowedSettingSources(parseSettingSourcesFlag(value))
      resetSettingsCache()
    } catch (error) {
      logError(error)
      failCli(`Failed to process --setting-sources: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  profileCheckpoint('eagerLoadSettings_end')
}

const require = (await import('node:module')).createRequire(import.meta.url)

async function run(): Promise<void> {
  profileCheckpoint('run_function_start')
  const cliName = binaryName()
  const program = new CommanderCommand()
  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (actionCommand === (program as unknown)) return
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
      `${cliName} — an interactive session starts by default; -p/--print gives non-interactive output.`,
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
    .helpOption('-h, --help', 'Show help')
  profileCheckpoint('run_commander_initialized')

  program
    .argument('[prompt]', 'The prompt to start with')
    .option('-d, --debug [filter]', 'Enable debug output (with an optional category filter)')
    .addOption(new Option('--d2e, --debug-to-stderr', 'Mirror debug output to stderr').hideHelp())
    .option('--debug-file <path>', 'Write debug output to a file')
    .option('--verbose', 'Verbose output')
    .option(
      '-p, --print',
      'Non-interactive output. A slash command this seat cannot serve (an interactive-only surface, a retired or unavailable command) answers its typed refusal on stderr and exits 1. The workspace-trust dialog is skipped in this mode — use it only in directories you trust.',
    )
    .option(
      '--bare',
      `Minimal mode: skips hooks, LSP, the extensions load, attribution, auto-memory, background prefetches, keychain reads and project instruction auto-discovery, and sets MERCURY_SIMPLE=1. First-party auth is strictly an API key (or an API-key helper supplied via --settings); OAuth and the keychain are never read; third-party gateways use their own credentials. Skills still resolve by name. Supply context explicitly with --system-prompt, --append-system-prompt, --mcp-config, --allowed-tools and --add-dir.`,
    )
    .addOption(new Option('--init', 'Run initialization only').hideHelp())
    .addOption(new Option('--init-only', 'Run initialization and exit').hideHelp())
    .addOption(new Option('--maintenance', 'Run maintenance hooks and exit').hideHelp())
    .addOption(new Option('--output-format <format>', 'Output format').choices(['text', 'json', 'stream-json']))
    .addOption(new Option('--input-format <format>', 'Input format').choices(['text', 'stream-json']))
    .option('--json-schema <schema>', 'JSON schema for structured output')
    .option('--include-hook-events', 'Emit all hook event types')
    .option('--include-partial-messages', 'Emit partial message stream events')
    .option('--mcp-debug', '[deprecated — use --debug] MCP debug output')
    .option('--dangerously-skip-permissions', 'Bypass all permission checks')
    .option('--allow-dangerously-skip-permissions', 'Allow the bypass mode to be toggled')
    .addOption(new Option('--thinking <mode>', 'Thinking mode').choices(['enabled', 'adaptive', 'disabled']).hideHelp())
    .addOption(new Option('--max-thinking-tokens <tokens>', '[deprecated] Max thinking tokens').argParser(Number).hideHelp())
    .addOption(new Option('--max-turns <turns>', 'Maximum turns for a print run').argParser((value: string) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        failCli(`--max-turns must be a positive integer (got '${value}')`)
      }
      return parsed
    }).hideHelp())
    .option('--max-budget-usd <amount>', 'Maximum spend for a print run', value => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        failCli('--max-budget-usd must be a positive number greater than 0')
      }
      return parsed
    })
    .addOption(
      new Option('--task-budget <tokens>', 'Token budget for the whole turn')
        .argParser(value => {
          const parsed = Number(value)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            failCli('--task-budget must be a positive integer')
          }
          return parsed
        })
        .hideHelp(),
    )
    .option('--replay-user-messages', 'Replay user messages on the stream-json output')
    .addOption(new Option('--enable-auth-status', 'Emit auth status envelopes').default(false).hideHelp())
    .option('--allowedTools, --allowed-tools <tools...>', 'Allowed tool rules')
    .option('--tools <tools...>', 'Base tool set')
    .option('--disallowedTools, --disallowed-tools <tools...>', 'Denied tool rules')
    .option('--mcp-config <configs...>', 'MCP server configs (JSON or file paths)')
    .option('--strict-mcp-config', 'Only use MCP servers from --mcp-config')
    .addOption(new Option('--permission-prompt-tool <tool>', 'MCP tool for permission prompts').hideHelp())
    .option('--system-prompt <prompt>', 'Replace the system prompt')
    .addOption(new Option('--system-prompt-file <file>', 'Replace the system prompt from a file').hideHelp())
    .option('--append-system-prompt <prompt>', 'Append to the system prompt')
    .addOption(new Option('--append-system-prompt-file <file>', 'Append to the system prompt from a file').hideHelp())
    .addOption(
      new Option('--permission-mode <mode>', 'Permission mode')
        .choices(PERMISSION_MODES)
        .argParser((value: string) => {
          const decoded = decodePermissionModeSpelling(value)
          if (!(PERMISSION_MODES as readonly string[]).includes(decoded)) {
            throw new InvalidArgumentError(`Allowed choices are ${PERMISSION_MODES.join(', ')}.`)
          }
          return decoded
        }),
    )
    .option('-c, --continue', 'Continue the most recent conversation')
    .option('-r, --resume [value]', 'Resume a conversation (session id, title, or picker)')
    .option('--fork-session', 'Fork to a new session id on resume')
    .option('--from-pr [value]', 'Resume a session linked to a PR')
    .addOption(new Option('--prefill <text>', 'Prefill the input buffer').hideHelp())
    .addOption(new Option('--deep-link-origin', 'Deep-link origin').hideHelp())
    .addOption(new Option('--deep-link-repo <slug>', 'Deep-link repository').hideHelp())
    .addOption(
      new Option('--deep-link-last-fetch <ms>', 'Deep-link last fetch')
        .argParser(value => {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : undefined
        })
        .hideHelp(),
    )
    .option('--no-session-persistence', 'Do not persist the session transcript')
    .addOption(new Option('--resume-session-at <message-id>', 'Truncate the resumed session at a message').hideHelp())
    .addOption(new Option('--rewind-files <user-message-id>', 'Rewind files to a user message').hideHelp())
    .option('--model <model>', 'The model for the session')
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
    .option('--betas <betas...>', 'SDK beta headers')
    .option('--fallback-model <model>', 'Fallback model when the primary is overloaded')
    .addOption(new Option('--workload <tag>', 'Workload tag').hideHelp())
    .option('--settings <file-or-json>', 'Extra settings (path or inline JSON)')
    .option('--add-dir <directories...>', 'Additional working directories')
    .option('--ide', 'Auto-connect to the IDE')
    .option('--session-id <uuid>', 'Use a specific session id')
    .option('-n, --name <name>', 'Session title')
    .option('--chat', 'Boot the plain world: the Boot face and a chat, nothing else on the strip — no concourse in this boot; ↵ New Session on the menu starts the chat (the classic feel; `-chat` is the same switch)')
    .option('--concourse-off', 'Turn the session concourse off for this and every future boot (persisted; the strip is the boot face and the chat alone; the boot face\'s Session Concourse row keeps a plain live view of your sessions; `-concourse-off` is the same switch)')
    .option('--concourse-on', 'Turn the session concourse back on for this and every future boot (persisted; the default is on; `-concourse-on` is the same switch)')
    .option('--agents <json>', 'Extra agent definitions (JSON)')
    .option('--setting-sources <sources>', 'Comma-separated allowed setting sources')
    .option('--extension <path>', 'An extension folder approved for this session only (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
    .option('--disable-slash-commands', 'Disable all slash commands')
    .option('--file <specs...>', 'Attach files (file_id:relative_path pairs)')
    .option('-v, --version', 'Print the version')
    .option('-w, --worktree [name]', 'Run inside a managed worktree')
    .option('--tmux', 'Create a tmux session for the worktree')


  for (const [flags, description] of [
    ['--agent-id <id>', 'Teammate agent id'],
    ['--agent-name <name>', 'Teammate agent name'],
    ['--team-name <name>', 'Teammate team name'],
    ['--agent-color <color>', 'Teammate color'],
    ['--parent-session-id <id>', 'Parent session id'],
    ['--agent-type <type>', 'Teammate agent type'],
  ] as const) {
    program.addOption(new Option(flags, description).hideHelp())
  }
  program.addOption(new Option('--plan-mode-required', 'Teammate requires plan mode').hideHelp())
  program.addOption(new Option('--teammate-mode <mode>', 'Teammate pane mode').choices(['auto', 'tmux', 'in-process']).hideHelp())

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

  if (process.argv[2] === '--rollback' || process.argv[2] === '-rollback') {
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, 'Rollback is an update operation — run `mercury update --rollback`\n')
    } catch {
    }
    process.exit(2)
  }

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
    if (actionCommand === program) {
      preconnectAnthropicApi({ credentialed: hasFirstPartyCredential() })
      profileCheckpoint('init_preconnect_dispatched')
    }
    if (resolveTerminalExperience().terminalTitle.effective) {
      process.title = 'mercury'
    }
    initSinks()
    profileCheckpoint('preAction_after_sinks')
    const extensionPaths = program.opts().extension as unknown
    if (Array.isArray(extensionPaths) && extensionPaths.length > 0 && extensionPaths.every(entry => typeof entry === 'string')) {
      const { existsSync: extensionDirExists } = require('node:fs') as typeof import('node:fs')
      const missing = (extensionPaths as string[]).filter(entry => !extensionDirExists(entry))
      if (missing.length > 0) {
        failCli(`--extension path${missing.length === 1 ? ' does' : 's do'} not exist: ${missing.join(', ')}`)
      }
      setSessionExtensions(extensionPaths)
    }
    runMigrationsIfNeeded()
    profileCheckpoint('preAction_after_migrations')
    void loadRemoteManagedSettings().catch(() => {})
    profileCheckpoint('preAction_after_remote_settings')
    void loadPolicyLimits().catch(() => {})
    profileCheckpoint('preAction_after_settings_sync')
  })

  program.action(async (prompt: string | undefined) => {
    await defaultAction(prompt, program.opts())
  })

  const hasControlUri = process.argv.some(arg => arg.startsWith('cc://') || arg.startsWith('cc+unix://'))
  if (isPrintModeArgv() && !hasControlUri) {
    profileCheckpoint('run_before_parse')
    if (wantsStreamJsonEnvelope()) {
      program.exitOverride()
      try {
        await program.parseAsync(process.argv)
      } catch (error) {
        const commanderError = error as { code?: string; exitCode?: number; message?: string }
        if (
          commanderError.code === 'commander.helpDisplayed' ||
          commanderError.code === 'commander.version'
        ) {
          process.exit(commanderError.exitCode ?? 0)
        }
        const { emitLoadError } = await import('./cli/headless/resume.js')
        emitLoadError(String(commanderError.message ?? error), 'stream-json')
        process.exit(
          typeof commanderError.exitCode === 'number' && commanderError.exitCode !== 0
            ? commanderError.exitCode
            : 1,
        )
      }
    } else {
      await program.parseAsync(process.argv)
    }
    profileCheckpoint('run_after_parse')
    return
  }

  await registerSubcommands(program)

  profileCheckpoint('run_before_parse')
  await program.parseAsync(process.argv)
  profileCheckpoint('run_after_parse')
  profileCheckpoint('run_complete')
  profileReport()
}

async function registerSubcommands(program: CommanderCommand): Promise<void> {
  const cliName = binaryName()

  const mcp = program.command('mcp').description('Manage MCP servers')
  mcp.enablePositionalOptions().configureHelp({ sortSubcommands: true, sortOptions: true })
  mcp
    .command('serve')
    .description('Run the MCP server')
    .option('-d, --debug', 'Debug output')
    .option('--verbose', 'Verbose output')
    .action(async options => {
      const { mcpServeHandler } = await import('./cli/handlers/mcp.js')
      await mcpServeHandler(options)
    })
  if (process.argv.includes('mcp')) {
    try {
      const { registerMcpAddCommand } = await import('./commands/mcp/addCommand.js')
      registerMcpAddCommand(mcp as unknown as Parameters<typeof registerMcpAddCommand>[0])
      const { registerMcpXaaIdpCommand } = await import('./commands/mcp/xaaIdpCommand.js')
      registerMcpXaaIdpCommand(mcp as unknown as Parameters<typeof registerMcpXaaIdpCommand>[0])
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
      'List configured MCP servers. The trust dialog is skipped, and stdio servers from the project MCP file are spawned for health checks.',
    )
    .action(async () => {
      const { mcpListHandler } = await import('./cli/handlers/mcp.js')
      await mcpListHandler()
    })
  mcp
    .command('get <name>')
    .description(
      'Show one MCP server. The trust dialog is skipped, and stdio servers from the project MCP file are spawned for health checks.',
    )
    .action(async name => {
      const { mcpGetHandler } = await import('./cli/handlers/mcp.js')
      await mcpGetHandler(name)
    })
  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server from a JSON definition')
    .option('-s, --scope <scope>', 'Configuration scope', 'local')
    .option('--client-secret', 'Prompt for a client secret')
    .action(async (name, json, options) => {
      const { mcpAddJsonHandler } = await import('./cli/handlers/mcp.js')
      await mcpAddJsonHandler(name, json, options)
    })
  mcp
    .command('reset-project-choices')
    .description('Reset project MCP server approval choices')
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('./cli/handlers/mcp.js')
      await mcpResetChoicesHandler()
    })

  const auth = program.command('auth').description('Manage authentication')
  auth
    .command('login')
    .description('Sign in')
    .option('--email <email>', 'Account email')
    .option('--sso', 'Use SSO')
    .option('--console', 'Console account')
    .option('--claudeai', 'Claude subscription account')
    .action(async options => {
      const { authLogin } = await import('./cli/handlers/auth.js')
      await authLogin(options)
    })
  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'JSON output', true)
    .option('--text', 'Text output')
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

  const extensions = program.command('extensions').description('Install extensions and manage their sources')
  extensions
    .command('list')
    .description('The installed roster with state and the first reason; --source lists what a source offers')
    .option('--json', 'JSON output')
    .option('--source <label>', "List a source's extensions")
    .action(async options => {
      const { listVerb } = await import('./extensions/cli.js')
      process.exitCode = (await listVerb(options)).exit
    })
  extensions
    .command('sources')
    .description('The sources with state')
    .option('--json', 'JSON output')
    .action(async options => {
      const { sourcesVerb } = await import('./extensions/cli.js')
      process.exitCode = (await sourcesVerb(options)).exit
    })
  extensions
    .command('add <source>')
    .description('Add a source: a git URL on any host, a folder, or an archive (nothing is installed)')
    .option('--label <label>', 'The label to file it under')
    .option('--json', 'JSON output')
    .action(async (source, options) => {
      const { addVerb } = await import('./extensions/cli.js')
      process.exitCode = (await addVerb(source, options)).exit
    })
  extensions
    .command('remove <label>')
    .description('Remove a source (its installed copies keep working)')
    .option('--and-extensions', 'Also uninstall the extensions installed from it')
    .action(async (label, options) => {
      const { removeVerb } = await import('./extensions/cli.js')
      process.exitCode = (await removeVerb(label, options)).exit
    })
  extensions
    .command('check [label]')
    .description('Refresh one or every source; prints the updates found (installs nothing)')
    .option('--json', 'JSON output')
    .action(async (label, options) => {
      const { checkVerb } = await import('./extensions/cli.js')
      process.exitCode = (await checkVerb(label, options)).exit
    })
  extensions
    .command('install <name>')
    .description('Install <name>[@label]: fetch, show the card, approve with --yes on a TTY-less run')
    .option('--yes', 'Approve without asking (the only scripted approval)')
    .option('--project', 'Switch on for this project only')
    .action(async (name, options) => {
      const { installVerb } = await import('./extensions/cli.js')
      process.exitCode = (await installVerb(name, options)).exit
    })
  extensions
    .command('approve <id>')
    .description('The approval card for an installed-off or found extension')
    .option('--yes', 'Approve without asking')
    .option('--project', 'Switch on for this project only')
    .action(async (id, options) => {
      const { approveVerb } = await import('./extensions/cli.js')
      process.exitCode = (await approveVerb(id, options)).exit
    })
  extensions
    .command('enable <id>')
    .description('Turn the switch on')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { enableVerb } = await import('./extensions/cli.js')
      process.exitCode = (await enableVerb(id, options)).exit
    })
  extensions
    .command('disable <id>')
    .description('Turn the switch off')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { disableVerb } = await import('./extensions/cli.js')
      process.exitCode = (await disableVerb(id, options)).exit
    })
  extensions
    .command('update [id]')
    .description('Update to the version the source lists (after a check); --previous swaps back')
    .option('--all', 'Every installed extension with a known update')
    .option('--yes', 'Approve a changed contributions set without asking')
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
    .command('block <entry>')
    .description('Block an extension id, a source label, a URL or a host')
    .action(async entry => {
      const { blockVerb } = await import('./extensions/cli.js')
      process.exitCode = (await blockVerb(entry)).exit
    })
  extensions
    .command('unblock <entry>')
    .description('Remove an entry from the blocklist')
    .action(async entry => {
      const { unblockVerb } = await import('./extensions/cli.js')
      process.exitCode = (await unblockVerb(entry)).exit
    })
  extensions
    .command('validate <path>')
    .description("The maker's linter: a manifest or a catalogue, its contributions, the ignored side files")
    .option('--json', 'JSON output')
    .action(async (path, options) => {
      const { validateVerb } = await import('./extensions/cli.js')
      process.exitCode = (await validateVerb(path, options)).exit
    })
  extensions
    .command('init <name>')
    .description('Scaffold an extension folder (or, with --source, a source root) that validates clean')
    .option('--source', 'Scaffold a source root with a catalogue and the README template')
    .option('--dir <dir>', 'Where to create it (default: the current directory)')
    .action(async (name, options) => {
      const { initVerb } = await import('./extensions/cli.js')
      process.exitCode = (await initVerb(name, options)).exit
    })

  program
    .command('setup-token')
    .description('Create a long-lived authentication token')
    .action(async () => {
      const { setupTokenHandler } = await import('./cli/handlers/util.js')
      const { createRoot } = await import('./ink.js')
      await setupTokenHandler(await createRoot())
    })

  program
    .command('agents')
    .description('Print the agent inventory')
    .option('--setting-sources <sources>', 'Comma-separated allowed setting sources')
    .action(async () => {
      const { agentsHandler } = await import('./cli/handlers/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  program.command('health').alias('doctor')
    .description('Check the installation health: configured MCP servers are validated WITHOUT starting them')
    .option('--json', 'JSON certificate output')
    .option('--deep', 'Deep inventory')
    .option('--fix', 'Run the guided fix flow')
    .option('--only <id>', 'Limit to one check')
    .option('--yes', 'Assume yes at fix prompts')
    .action(async options => {
      await healthAction({
        json: Boolean(options.json),
        deep: Boolean(options.deep),
        fix: Boolean(options.fix),
        only: typedString(options.only),
        yes: options.yes === true,
      })
    })

  for (const [name, usage] of [
    ['daemon [subcommand]', `Usage: ${cliName} daemon <run|status|stop>`],
    ['acp', `Usage: ${cliName} acp [--stdio]`],
  ] as const) {
    program
      .command(name)
      .description('Managed by the launcher fast path')
      .allowUnknownOption(true)
      .action(() => {
        writeErr(usage)
        process.exit(1)
      })
  }

  program
    .command('themis [verb] [paths...]')
    .description('THEMIS integrity tooling')
    .action(async (verb: string | undefined, paths: string[] | undefined) => {
      await runThemisCli(verb ?? 'help', paths ?? [])
    })

  program
    .command('show <image>')
    .description('Render an image to the terminal')
    .option('--protocol <p>', 'Force a display protocol')
    .option('--cols <n>', 'Cells-tier column budget', Number)
    .action(async (image: string, options: { protocol?: string; cols?: number }) => {
      await showAction(image, options)
    })

  program
    .command('editor <action>')
    .description('IDE bridge editor actions')
    .action(async (action: string) => {
      const { editorBridgeMain } = await import('./cli/editorBridge.js')
      process.exit(await editorBridgeMain(action))
    })

  program
    .command('update')
    .alias('upgrade')
    .description('Update to the newest release (no GitHub sign-in needed)')
    .option('--check', 'Only check for updates')
    .option('--status', 'Show update status')
    .option('--rollback', 'Roll back to the previous version')
    .option('--json', 'JSON output')
    .action(async options => {
      await updateCli(options)
    })

  program
    .command('install')
    .description('Install this extracted release archive user-locally (managed launcher shims)')
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
      process.env.MERCURY_IMAGE_PROTOCOL = options.protocol
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

async function defaultAction(inputPromptArg: string | undefined, opts: RootOptions): Promise<void> {
  if ((opts as { version?: boolean }).version) {
    console.log(`Mercury ${MACRO.VERSION}`)
    process.exit(0)
  }
  try {
    recordLaunchMilestone('runtime-entry')
  } catch {
  }
  const cliName = binaryName()
  const isNonInteractiveSession = !getIsInteractive()
  const printMode = Boolean(opts.print)

  const worktreeOpt = opts.worktree as string | boolean | undefined
  const tmuxEnabled = Boolean(opts.tmux)
  if (tmuxEnabled && !worktreeOpt) failCli('--tmux requires --worktree')
  if (tmuxEnabled && process.platform === 'win32') failCli('--tmux is not supported on Windows')
  if (tmuxEnabled) {
    const { isTmuxAvailable, getTmuxInstallInstructions } = await import('./utils/worktree.js')
    if (!(await isTmuxAvailable())) {
      failCli(`tmux is not installed. ${getTmuxInstallInstructions()}`)
    }
  }

  const agentId = typedString(opts.agentId)
  const agentName = typedString(opts.agentName)
  const teamName = typedString(opts.teamName)
  const agentColor = typedString(opts.agentColor)
  const planModeRequired = typedBoolean(opts.planModeRequired)
  const parentSessionId = typedString(opts.parentSessionId)
  const teammateMode = typedString(opts.teammateMode)
  const agentTypeOpt = typedString(opts.agentType)
  const { isAgentSwarmsEnabled } = await import('./utils/agentSwarmsEnabled.js')
  if (isAgentSwarmsEnabled()) {
    const identityCount = [agentId, agentName, teamName].filter(Boolean).length
    if (identityCount > 0 && identityCount < 3) {
      failCli('--agent-id, --agent-name and --team-name must be provided together')
    }
  }

  if (opts.continue && opts.resume) {
    failCli('--continue and --resume name two different sessions — give exactly one')
  }
  const sessionIdOpt = typedString(opts.sessionId)
  if (sessionIdOpt) {
    if ((opts.continue || opts.resume) && !opts.forkSession) {
      failCli('--session-id cannot be combined with --continue/--resume unless --fork-session is given')
    }
    if (!UUID_SHAPE.test(sessionIdOpt)) failCli(`--session-id must be a valid UUID: ${sessionIdOpt}`)
    if (await sessionIdExists(sessionIdOpt)) failCli(`Session id already exists: ${sessionIdOpt}`)
  }
  if (opts.fallbackModel && opts.fallbackModel === opts.model) {
    failCli('--fallback-model cannot equal --model')
  }
  if (opts.systemPrompt && opts.systemPromptFile) failCli('Use either --system-prompt or --system-prompt-file, not both')
  if (opts.appendSystemPrompt && opts.appendSystemPromptFile) {
    failCli('Use either --append-system-prompt or --append-system-prompt-file, not both')
  }
  let customSystemPrompt = typedString(opts.systemPrompt)
  let appendSystemPrompt = typedString(opts.appendSystemPrompt)
  for (const [fileOpt, assign] of [
    [typedString(opts.systemPromptFile), (text: string) => (customSystemPrompt = text)],
    [typedString(opts.appendSystemPromptFile), (text: string) => (appendSystemPrompt = text)],
  ] as const) {
    if (fileOpt) {
      const { resolve } = await import('node:path')
      const { readFileSync, existsSync } = await import('node:fs')
      const resolved = resolve(fileOpt)
      if (!existsSync(resolved)) failCli(`Prompt file not found: ${resolved}`)
      try {
        assign(readFileSync(resolved, 'utf8'))
      } catch (error) {
        failCli(`Failed to read the prompt file: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const inputFormat = typedString(opts.inputFormat) ?? 'text'
  const outputFormat = typedString(opts.outputFormat) ?? 'text'
  if (inputFormat !== 'text' && inputFormat !== 'stream-json') failCli(`Invalid --input-format: ${inputFormat}`)
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    failCli('--input-format=stream-json requires --output-format=stream-json')
  }
  if (opts.replayUserMessages && (inputFormat !== 'stream-json' || outputFormat !== 'stream-json')) {
    failCli('--replay-user-messages requires stream-json input and output')
  }
  const includePartialMessages = Boolean(opts.includePartialMessages)
  if (opts.includePartialMessages && (!printMode || outputFormat !== 'stream-json')) {
    failCli('--include-partial-messages requires --print with --output-format=stream-json')
  }
  if (opts.sessionPersistence === false && !printMode) {
    failCli('--no-session-persistence is only available in print mode')
  }

  if (opts.bare) {
    process.env.MERCURY_SIMPLE = '1'
  }
  let inputPrompt = inputPromptArg
  if (inputPrompt === 'code') {
    console.warn(
      chalk.yellow(`Tip: launch ${cliName} with no arguments to start an interactive session`),
    )
    inputPrompt = undefined
  }
  if (typedString(opts.prefill)) {
    startCapturingEarlyInput()
    process.stdin.unshift?.(Buffer.from(String(opts.prefill)))
  }

  const bypassFromRegistry = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS')) && !isPrintModeArgv()
  const dangerouslySkipPermissions = Boolean(opts.dangerouslySkipPermissions) || bypassFromRegistry
  const allowDangerousSkip = Boolean(opts.allowDangerouslySkipPermissions)
  const { initialPermissionModeFromCLI } = await import('./utils/permissions/permissionSetup.js')
  const resolved = initialPermissionModeFromCLI({
    permissionModeCli: typedString(opts.permissionMode),
    dangerouslySkipPermissions,
  })
  const permissionMode: PermissionMode = resolved.mode
  const { setSessionBypassPermissionsMode } = await import('./bootstrap/state.js')
  setSessionBypassPermissionsMode(modeBypassesPermissions(permissionMode))

  const permissionInit = await initializeToolPermissionContext({
    allowedToolsCli: (opts.allowedTools as string[] | undefined) ?? [],
    disallowedToolsCli: (opts.disallowedTools as string[] | undefined) ?? [],
    baseToolsCli: opts.tools as string[] | undefined,
    permissionMode,
    allowDangerouslySkipPermissions: allowDangerousSkip,
    addDirs: (opts.addDir as string[] | undefined) ?? [],
  })
  let toolPermissionContext = permissionInit.toolPermissionContext
  for (const warning of permissionInit.warnings) console.error(warning)
  if (permissionInit.dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext)
  }
  setAddedDirectories(permissionInit.admittedDirectories)

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

  const thinkingOpt = typedString(opts.thinking)
  const { noteSessionThinkingConfig, shouldEnableThinkingByDefault } = await import('./utils/thinking.js')
  let thinkingConfig: import('./utils/thinking.js').ThinkingConfig
  if (thinkingOpt === 'enabled' || thinkingOpt === 'adaptive') thinkingConfig = { type: 'adaptive' }
  else if (thinkingOpt === 'disabled') thinkingConfig = { type: 'disabled' }
  else {
    const envTokens = process.env.MAX_THINKING_TOKENS
    const budget = envTokens !== undefined ? Number.parseInt(envTokens, 10) : (opts.maxThinkingTokens as number | undefined)
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
  if (typedString(opts.agents)) {
    try {
      const cliAgents = parseAgentsFromJson(JSON.parse(typedString(opts.agents)!) as unknown)
      allAgents = [...allAgents, ...cliAgents]
      activeAgents = computeActiveAgents(allAgents)
    } catch (error) {
      logError(error)
    }
  }
  const requestedAgent = typedString(opts.agent) ?? getInitialSettings().agent
  let mainThreadAgentDefinition: AgentDefinition | undefined
  if (requestedAgent) {
    mainThreadAgentDefinition = activeAgents.find(agent => agent.agentType === requestedAgent)
    if (!mainThreadAgentDefinition) {
      const refusal = `unknown agent '${requestedAgent}' — available: ${activeAgents.map(agent => agent.agentType).join(', ')}`
      if (typedString(opts.agent) !== undefined) {
        failCli(refusal)
      }
      process.stderr.write(`${refusal} (from settings.agent — running without it)\n`)
      logForDebugging(refusal)
    } else {
      setMainThreadAgentType(requestedAgent)
      void import('./utils/sessionStorage.js')
        .then(storage => storage.saveAgentSetting(requestedAgent))
        .catch(() => {})
    }
  }

  let userSpecifiedModel = typedString(opts.model)
  if (userSpecifiedModel === 'default') userSpecifiedModel = getDefaultMainLoopModelSetting() ?? undefined
  let fallbackModel = typedString(opts.fallbackModel)
  if (fallbackModel === 'default') fallbackModel = getDefaultMainLoopModelSetting() ?? undefined
  if (!userSpecifiedModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
    userSpecifiedModel = mainThreadAgentDefinition.model
  }
  if (userSpecifiedModel) setMainLoopModelOverride(userSpecifiedModel)
  setInitialMainLoopModel(userSpecifiedModel ?? null)
  const resolvedInitialModel = getMainLoopModel()

  let advisorModel: string | undefined
  if (isAdvisorEnabled()) {
    if (canUserConfigureAdvisor()) {
      advisorModel = getInitialAdvisorSetting()
      if (advisorModel) {
        if (!modelSupportsAdvisor(resolvedInitialModel)) {
          failCli(`The model ${resolvedInitialModel} does not support an advisor`)
        }
        if (!isValidAdvisorModel(normalizeModelStringForAPI(advisorModel))) {
          failCli(`Invalid advisor model: ${advisorModel}`)
        }
        logForDebugging(`advisor model resolved: ${advisorModel}`)
      }
    }
  }

  if (teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process') {
    setCliTeammateModeOverride(teammateMode)
  }
  if (agentId && agentName && teamName && agentTypeOpt) {
    let rolePrompt: string | undefined
    const roleDefinition = findRoleDefinition(agentTypeOpt, activeAgents)
    if (!roleDefinition) {
      logForDebugging(`unknown teammate role '${agentTypeOpt}'; nothing appended`)
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

  const sessionTitle = typedString(opts.name)?.trim() || undefined

  let prompt: string | AsyncIterable<string> | undefined = inputPrompt
  if (!process.stdin.isTTY && !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      prompt = readStdinChunks()
    } else {
      const collected = await readStdinWithPeek(3000)
      if (collected === null && inputPrompt === undefined) {
        writeErr(
          'No stdin data arrived within 3s; proceeding without piped input. Redirect from the null device to skip the wait, or keep the pipe open longer to include its data.',
        )
      }
      const pieces = [inputPrompt, collected ?? undefined].filter(
        (piece): piece is string => typeof piece === 'string' && piece.length > 0,
      )
      prompt = pieces.length > 0 ? pieces.join('\n') : undefined
    }
  }

  if (
    (printMode || !process.stdout.isTTY) &&
    prompt === undefined &&
    !opts.resume &&
    !opts.continue &&
    !opts.fromPr &&
    inputFormat !== 'stream-json' &&
    mainThreadAgentDefinition?.initialPrompt == null
  ) {
    const variadicCandidates: Array<[string, unknown]> = [
      ['--allowedTools', opts.allowedTools],
      ['--disallowedTools', opts.disallowedTools],
      ['--tools', opts.tools],
      ['--mcp-config', opts.mcpConfig],
      ['--add-dir', opts.addDir],
      ['--betas', opts.betas],
      ['--file', opts.file],
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
        `No prompt reached --print, and the list flag ${flag} captured ${values.length} values — ` +
          `its last value ${JSON.stringify(lastValue)} may have been meant as the prompt ` +
          `(a variadic flag consumes every following bare argument). ` +
          `Put the prompt before the flag, or end the list with -- : ` +
          `${cliName} -p ${flag} "..." -- "your prompt". ` +
          `If every value really is a list entry, provide the prompt via stdin or as a positional argument.`,
      )
    }
  }

  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof prompt === 'string') {
      prompt = `${mainThreadAgentDefinition.initialPrompt}\n${prompt}`
    } else if (prompt === undefined) {
      prompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  consumeSessionKitPin()
  const dynamicConfigResult = parseDynamicMcpConfigs((opts.mcpConfig as string[] | undefined) ?? [])
  if (dynamicConfigResult.errors.length > 0) {
    logForDebugging(
      `${dynamicConfigResult.errors.length} MCP config error(s): ${dynamicConfigResult.errors.join('; ')}`,
    )
    failCli(`Invalid MCP configuration:\n${dynamicConfigResult.errors.join('\n')}`)
  }
  let dynamicMcpConfig = dynamicConfigResult.servers

  if (isCoordinationServerEnabled()) {
    const reserved = Object.entries(dynamicMcpConfig).find(
      ([name, config]) => name === COORDINATION_SERVER_NAME && (config as { type?: string }).type !== 'sdk',
    )
    if (reserved) {
      writeErr(
        `The MCP server name '${COORDINATION_SERVER_NAME}' is reserved while Mercury's in-process coordination server is enabled (MERCURY_COORDINATION_MCP).`,
      )
      process.exit(1)
    }
  }

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
    if (opts.strictMcpConfig) failCli('--strict-mcp-config is not available when an enterprise MCP configuration exists')
    const allowedCheck = areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
    if (allowedCheck !== true) {
      failCli('Dynamic MCP servers are not allowed when an enterprise MCP configuration exists')
    }
  }
  if (isCoordinationServerEnabled()) {
    logForDebugging('merging the in-process coordination server into the dynamic MCP config')
    try {
      dynamicMcpConfig = {
        ...dynamicMcpConfig,
        ...Object.fromEntries(
          Object.entries(coordinationServerConfig()).map(([name, config]) => [
            name,
            { ...config, scope: 'dynamic' as const },
          ]),
        ),
      }
    } catch (error) {
      logForDebugging(`coordination server setup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const strictOrBare = Boolean(opts.strictMcpConfig) || isBareMode()
  const mcpResolutionStartedAt = Date.now()
  const discoveredMcpPromise: Promise<Record<string, ScopedMcpServerConfig>> = strictOrBare
    ? Promise.resolve({})
    : getMercuryMcpConfigs(dynamicMcpConfig).then(resolved => resolved.servers)
  const mcpConfigPromise = discoveredMcpPromise.then(discovered => {
    const merged = { ...discovered, ...dynamicMcpConfig }
    const sdk: Record<string, McpSdkServerConfig> = Object.create(null) as Record<string, McpSdkServerConfig>
    const regular: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
    for (const [name, config] of Object.entries(merged)) {
      if (config.type === 'sdk') sdk[name] = config
      else regular[name] = config
    }
    logForDebugging(`MCP config resolution took ${Date.now() - mcpResolutionStartedAt}ms`)
    return { sdk, regular }
  })
  const regularDynamicMcpConfig: Record<string, ScopedMcpServerConfig> = Object.fromEntries(
    Object.entries(dynamicMcpConfig).filter(([, config]) => config.type !== 'sdk'),
  )

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
  void import('./utils/autoUpdater.js')
    .then(m => m.assertMinVersion())
    .catch(() => {})

  const setupTrigger: 'init' | 'maintenance' | undefined =
    opts.initOnly || opts.init ? 'init' : opts.maintenance ? 'maintenance' : undefined

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
      advisorModel,
      mainThreadAgentDefinition,
      activeAgents,
      allAgents,
      sessionTitle,
      setupTrigger,
      teammateContext: { agentId, agentName, teamName, agentColor, planModeRequired, parentSessionId },
    })
    return
  }

  await printLaunch({
    opts,
    commands,
    prompt,
    permissionMode,
    toolPermissionContext,
    allowDangerousSkip,
    mcpConfigPromise,
    thinkingConfig,
    userSpecifiedModel,
    fallbackModel,
    advisorModel,
    mainThreadAgentDefinition,
    activeAgents,
    allAgents,
    customSystemPrompt,
    appendSystemPrompt,
    inputFormat,
    outputFormat,
    includePartialMessages,
    setupTrigger,
  })
}

async function* readStdinChunks(): AsyncIterable<string> {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) yield chunk as string
}

function readStdinWithPeek(timeoutMs: number): Promise<string | null> {
  return new Promise(resolvePeek => {
    let settled = false
    let sawData = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      if (!sawData && !settled) {
        settled = true
        process.stdin.pause()
        resolvePeek(null)
      }
    }, timeoutMs)
    timer.unref?.()
    process.stdin.on('data', chunk => {
      sawData = true
      chunks.push(Buffer.from(chunk))
    })
    process.stdin.on('end', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePeek(Buffer.concat(chunks).toString('utf8'))
      }
    })
    process.stdin.on('error', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePeek(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null)
      }
    })
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
  advisorModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  sessionTitle: string | undefined
  setupTrigger: 'init' | 'maintenance' | undefined
  teammateContext: {
    agentId?: string
    agentName?: string
    teamName?: string
    agentColor?: string
    planModeRequired?: boolean
    parentSessionId?: string
  }
}): Promise<void> {
  const { opts, commands } = args
  let inputPrompt = args.prompt

  if (opts.initOnly) {
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
  if (onboardingShown) {
    void loadRemoteManagedSettings().catch(() => {})
    void loadPolicyLimits().catch(() => {})
    resetUserCache()
    const { refreshFeatureGates } = await import('./services/analytics/featureGates.js')
    await refreshFeatureGates().catch(() => {})
  }
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
  registerBackgroundNode('startup-prefetch-batch', async () => {
    await runStartupPrefetchBatch()
  })
  registerBackgroundNode('usage-poll', async () => {
    const { armProviderUsagePoll } = await import('./services/providers/providerUsage.js')
    const { declaredRouteOf } = await import('./services/providers/callModelRouter.js')
    const { getFocusedSessionConnector } = await import('./services/engine-connector/focusedConnector.js')
    armProviderUsagePoll({
      family: () => declaredRouteOf(getFocusedSessionConnector().modelFacts().main) ?? 'unrecognised',
    })
  })
  registerBackgroundNode('example-commands', async () => {
    await refreshExampleCommands()
  })
  registerBackgroundNode('session-registry', async () => {
    await registerSession()
    if (args.sessionTitle) await updateSessionName(args.sessionTitle)
  })
  registerBackgroundNode('session-telemetry', async () => {
    void getMainLoopModel()
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
  registerBackgroundNode('minerva', async () => {
    maybeRunMinervaOnBoot(getOriginalCwd())
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
    permissionModeCli: typedString(opts.permissionMode),
    dangerouslySkipPermissions: modeBypassesPermissions(args.permissionMode),
  }).notification
  if (modeNotification) {
    notifications.push({ key: 'permission-mode-notification', text: modeNotification })
  }
  const deprecationWarning = getModelDeprecationWarning(args.resolvedInitialModel)
  if (deprecationWarning) {
    notifications.push({ key: 'model-deprecation-warning', text: deprecationWarning, color: 'warning' })
  }

  const { isAgentSwarmsEnabled } = await import('./utils/agentSwarmsEnabled.js')
  let effectiveContext = args.toolPermissionContext
  if (isAgentSwarmsEnabled() && args.teammateContext.planModeRequired) {
    effectiveContext = { ...effectiveContext, mode: 'strategy' }
  }

  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().effortLevel
  const supercodeArmed = opts.effort === undefined && Boolean(getInitialSettings().supercodeEffort)
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') addBootNote('warn', effortEnv.sentence)
  const { setDynamicTeamContext } = await import('./utils/teammate.js')
  const hasTeammateIdentity = Boolean(
    args.teammateContext.agentId && args.teammateContext.agentName && args.teammateContext.teamName,
  )
  const teamContext = hasTeammateIdentity
    ? {
        agentId: args.teammateContext.agentId!,
        agentName: args.teammateContext.agentName!,
        teamName: args.teammateContext.teamName!,
        color: args.teammateContext.agentColor,
        planModeRequired: Boolean(args.teammateContext.planModeRequired),
        parentSessionId: args.teammateContext.parentSessionId,
      }
    : undefined
  if (teamContext) setDynamicTeamContext(teamContext)
  const initialTeamContext = computeInitialTeamContext()
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: effectiveContext,
    verbose: Boolean(opts.verbose) || Boolean(config.verbose),
    expandedView: config.showSpinnerTree ? 'teammates' : config.showExpandedTodos ? 'tasks' : 'none',
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    ...(supercodeArmed ? { supercode: true } : {}),
    ...(isAdvisorEnabled() && args.advisorModel ? { advisorModel: args.advisorModel } : {}),
    agent: args.mainThreadAgentDefinition?.agentType,
    agentDefinitions: { activeAgents: args.activeAgents, allAgents: args.allAgents },
    ...(initialTeamContext ? { teamContext: initialTeamContext } : {}),
    replBridgeEnabled: getRemoteControlAtStartup() || assistantBridgeSeed(),
    promptSuggestionEnabled: (await import('./services/PromptSuggestion/promptSuggestion.js')).shouldEnablePromptSuggestion(),
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
  registerBackgroundNode('startup-records', () => {
    flushDeferredGlobalConfigSaves()
    try {
      recordInvocation()
    } catch {
    }
  })

  {
    const { armQuitParksAll } = await import('./services/switchboard/quitParksAll.js')
    armQuitParksAll()
  }
  if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {
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
  const replProps: REPLProps = {
    commands,
    initialTools: [...getTools(effectiveContext)],
    debug: Boolean(opts.debug),
    disableSlashCommands: Boolean(opts.disableSlashCommands),
  }

  if (!getIsInteractive()) return

  armBackgroundDiscovery();

  try {
    type ResumeLog = { fullPath?: string; customTitle?: string; agentName?: string }
    const resumeAtBoot = async (sessionId: string, log: ResumeLog): Promise<boolean> => {
      if (opts.forkSession) {
        writeErr('--fork-session: a managed resume continues the session as itself — the flag is ignored')
      }
      const { focusResumedSession } = await import('./services/switchboard/hopIntoSession.js')
      const outcome = await focusResumedSession(sessionId, log.fullPath, {
        ...(log.customTitle ?? log.agentName ? { title: (log.customTitle ?? log.agentName) as string } : {}),
        permissionMode: args.permissionMode,
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
      const lastLog = await getLogByIndex(0)
      const sessionId = lastLog ? getSessionIdFromLog(lastLog as Parameters<typeof getSessionIdFromLog>[0]) : undefined
      if (!lastLog || !sessionId) {
        await exitWithError(root, 'No conversation found to continue')
        return
      }
      if (!(await resumeAtBoot(String(sessionId), lastLog as ResumeLog))) return
    } else if (opts.resume || opts.fromPr) {
      const resumeValue = opts.resume
      const fromPr = opts.fromPr
      let searchTerm: string | undefined
      let resumeLog: ResumeLog | null = null
      let resumeSessionId: string | undefined
      if (typeof resumeValue === 'string' && !UUID_SHAPE.test(resumeValue)) {
        const matches = await searchSessionsByCustomTitle(resumeValue)
        if (Array.isArray(matches) && matches.length === 1) {
          resumeLog = matches[0] as ResumeLog
          resumeSessionId = getSessionIdFromLog(matches[0] as Parameters<typeof getSessionIdFromLog>[0])
        } else {
          searchTerm = resumeValue
        }
      } else if (typeof resumeValue === 'string') {
        const log = await getLastSessionLog(resumeValue as UUID).catch(() => null)
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
          ...replProps,
          initialSearchQuery: searchTerm,
          forkSession: Boolean(opts.forkSession),
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

    await launchRepl(root, appProps, replProps, renderAndRun, {
      dynamicMcpConfig: args.dynamicMcpConfig,
      isStrictMcpConfig: Boolean(args.opts.strictMcpConfig),
      ...(args.opts.ide !== undefined ? { ideAutoConnect: Boolean(args.opts.ide) } : {}),
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

async function runStartupPrefetchBatch(): Promise<void> {
  if (isBareMode()) {
    logForDebugging('startup prefetch batch skipped: bare mode')
    return
  }
  const throttleMs = Number(getFeatureValue_CACHED_MAY_BE_STALE('mercury_cicada_nap_ms', 0))
  const lastRunAt = getGlobalConfig().startupPrefetchedAt ?? 0
  if (throttleMs > 0 && Date.now() - lastRunAt < throttleMs) {
    logForDebugging('startup prefetch batch skipped: within the throttle interval')
    return
  }
  await checkQuotaStatus().catch((error: unknown) => logError(error))
  await fetchBootstrapData().catch((error: unknown) => logError(error))
  if (throttleMs > 0) {
    saveGlobalConfig(current => ({ ...current, startupPrefetchedAt: Date.now() }))
  }
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

async function printLaunch(args: {
  opts: RootOptions
  commands: import('./commands.js').Command[]
  prompt: string | AsyncIterable<string> | undefined
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  mcpConfigPromise: Promise<{ sdk: Record<string, McpSdkServerConfig>; regular: Record<string, ScopedMcpServerConfig> }>
  thinkingConfig: import('./utils/thinking.js').ThinkingConfig
  userSpecifiedModel: string | undefined
  fallbackModel: string | undefined
  advisorModel: string | undefined
  mainThreadAgentDefinition: AgentDefinition | undefined
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  inputFormat: string
  outputFormat: string
  includePartialMessages: boolean
  setupTrigger: 'init' | 'maintenance' | undefined
}): Promise<void> {
  const { opts } = args

  setHeadlessOneShot(args.inputFormat !== 'stream-json')

  let tools = [...getTools(args.toolPermissionContext)]
  const jsonSchemaOpt = typedString(opts.jsonSchema)
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

  const formatted = args.outputFormat === 'stream-json' || args.outputFormat === 'json'
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
  const headlessCommands = opts.disableSlashCommands
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
          return false
        })

  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().effortLevel
  const supercodeArmed = opts.effort === undefined && Boolean(getInitialSettings().supercodeEffort)
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') process.stderr.write(`${effortEnv.sentence}\n`)
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: args.toolPermissionContext,
    verbose: Boolean(opts.verbose) || Boolean(config.verbose),
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    ...(supercodeArmed ? { supercode: true } : {}),
    ...(isAdvisorEnabled() && args.advisorModel ? { advisorModel: args.advisorModel } : {}),
  }
  const store = createStore<AppState>(initialState, ({ newState, oldState }) =>
    onChangeAppState({ newState, oldState }),
  )

  if (modeBypassesPermissions(args.permissionMode) || args.allowDangerousSkip) {
    void import('./utils/permissions/bypassPermissionsKillswitch.js')
      .then(m =>
        m.checkAndDisableBypassPermissionsIfNeeded(
          store.getState().toolPermissionContext,
          updater => store.setState(updater),
        ),
      )
      .catch(() => {})
  }

  if (opts.sessionPersistence === false) {
    setSessionPersistenceDisabled(true)
  }

  if (Array.isArray(opts.betas) && opts.betas.length > 0) {
    const { filterAllowedSdkBetas } = await import('./utils/model/capabilities.js')
    const { setSdkBetas } = await import('./bootstrap/state.js')
    setSdkBetas(filterAllowedSdkBetas(opts.betas.filter((beta): beta is string => typeof beta === 'string')))
  }

  profileCheckpoint('action_before_mcp_configs_await')
  const { sdk: sdkMcpConfigs, regular: regularMcpConfigs } = await args.mcpConfigPromise
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
          mcpNames: [...Object.keys(regularMcpConfigs), ...Object.keys(sdkMcpConfigs)],
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
  await connectClaudeAiConnectors(store)
  profileCheckpoint('after_connectMcp_claudeai')

  if (!isBareMode()) {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  }

  const { runHeadless } = await import('./cli/print.js')
  try {
    await runHeadless(
      args.prompt ?? '',
      store.getState,
      store.setState,
      headlessCommands,
      tools,
      sdkMcpConfigs,
      args.activeAgents,
      {
        continue: Boolean(opts.continue),
        resume: opts.resume as string | boolean | undefined,
        verbose: Boolean(opts.verbose) || Boolean(config.verbose),
        outputFormat: args.outputFormat,
        jsonSchema: parsedJsonSchema,
        permissionPromptToolName: typedString(opts.permissionPromptTool),
        allowedTools: (opts.allowedTools as string[] | undefined) ?? [],
        thinkingConfig: args.thinkingConfig,
        maxTurns: opts.maxTurns as number | undefined,
        maxBudgetUsd: opts.maxBudgetUsd as number | undefined,
        taskBudget: opts.taskBudget !== undefined ? { total: opts.taskBudget as number } : undefined,
        systemPrompt: args.customSystemPrompt,
        appendSystemPrompt: args.appendSystemPrompt,
        userSpecifiedModel: args.userSpecifiedModel ?? args.mainThreadAgentDefinition?.model ?? undefined,
        fallbackModel: args.fallbackModel,
        replayUserMessages: Boolean(opts.replayUserMessages),
        includePartialMessages: args.includePartialMessages,
        forkSession: Boolean(opts.forkSession),
        resumeSessionAt: typedString(opts.resumeSessionAt),
        rewindFiles: typedString(opts.rewindFiles),
        enableAuthStatus: Boolean(opts.enableAuthStatus),
        agent: typedString(opts.agent),
        workload: typedString(opts.workload),
        setupTrigger: args.setupTrigger,
        bootSessionIdPinned: Boolean(typedString(opts.sessionId)),
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

async function connectClaudeAiConnectors(store: {
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
    const connectors = await fetchClaudeAIMcpConfigsIfEligible()
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
      void countFilesRoundedRg(process.cwd(), AbortSignal.timeout(3000)).catch(() => {})
      const { getModelCapability } = (await import('./utils/model/capabilities.js')) as {
        getModelCapability?: (model: string) => unknown
      }
      getModelCapability?.(getMainLoopModel())
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
