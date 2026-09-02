// ============================================================================
//  src/main.tsx — the process entry after the thin launcher: builds the whole
//  CLI grammar, resolves settings/permissions/model/agent/MCP, then branches
//  to either the interactive launch or the headless print path.
//
//  This module is the deliberate EAGER FRONT of the import graph (the
//  boot-contract prover counts its static value imports so every deferral is
//  a conscious act); the paint surface (App/REPL) is reachable only through
//  dynamic import inside replLauncher.
// ============================================================================
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
import { applyBootMenuEnv } from './substrate/startupMenu.js'
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

// ── module-evaluation side effects (boot-order contract) ───────────────────
profileCheckpoint('main_tsx_entry')
startMdmRawRead();
startKeychainPrefetch();
profileCheckpoint('main_tsx_imports_loaded')

// Refuse to run under a debugger: argv evidence, NODE_OPTIONS evidence, or a
// live inspector URL. Bun does not support the legacy --debug spellings and
// leaks application argv into exec argv, so they are only checked under Node.
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
    // Probed through the global CommonJS require; a throw falls back to the
    // argv and env evidence alone.
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

/** The merged config environment: settings-supplied env entries applied to
 *  the process (git executable, PATH additions from project settings). */
function applyMergedConfigEnv(): void {
  const env = getInitialSettings().env ?? {}
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = String(value)
  }
}

// A saved key applies only when it names an existing registry row; values
// are validated against the row; a variable already present in the real
// environment is never overwritten. All owned by the startup-menu module.

const MIGRATION_VERSION = 11

/** The fixed ordered synchronous migration set behind the version counter.
 *  `resetAutoModeOptInForDefaultOffer` is deliberately NOT called (or
 *  imported) in this build. A throwing migration must never take the CLI
 *  down — before this guard the failure mode was a swallowed pre-action
 *  rejection and an indefinite hang with nothing on stdout or stderr. */
function runMigrationsIfNeeded(): void {
  try {
    const config = getGlobalConfig()
    if (config.migrationVersion === MIGRATION_VERSION) return
    // Each settings-relocating migration reports whether its write landed
    // (release-hardening audit rank 17): a refused settings write keeps the
    // source of truth in place, and an incomplete set leaves the version
    // stamp unwritten so it retries on a later boot instead of losing the
    // relocated value for good.
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
      // Written back only if still not current, so concurrent writers do
      // not clobber.
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
  // The async changelog migration is fired and forgotten; it retries next
  // start.
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

/** True when this invocation asked for the stream-json envelope: preflight
 *  refusals must ride it too (FC-079) — a stream-json consumer parses
 *  envelopes, not stderr prose beside a zero-byte stdout. Raw-argv read
 *  because refusals fire before (and sometimes from) the option parse. */
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
  // FC-079: the stream-json road's refusals ride the envelope — the same
  // error_during_execution result frame emitLoadError renders for load
  // failures, INLINE because failCli is synchronous and the bundled world
  // has no relative require (a lazy import cannot finish before exit).
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
      // writeSync: an async stdout write can be discarded by the exit on
      // win32 — the envelope must land before the process ends.
      writeSync(1, `${JSON.stringify(envelope)}\n`)
      process.exit(1)
    } catch {
      /* the envelope door failed — the prose fallback below still refuses */
    }
  }
  writeErr(chalk.red(message))
  process.exit(1)
}

/** TASK-017 F-1 (the silent exit-1 boot): when the interactive launch is
 *  ABANDONED because a shutdown was already initiated, the operator must
 *  not be left with a bare prompt and a non-zero $? and no words. One
 *  honest stderr line, written at process exit — after the shutdown path's
 *  terminal restoration, so the released alternate screen cannot swallow
 *  it — and only for a non-zero exit (a deliberate clean quit stays quiet). */
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
      /* stderr gone — nothing more an exit hook can say */
    }
  })
}

// ── the entry function ─────────────────────────────────────────────────────
export async function main(): Promise<void> {
  profileCheckpoint('main_function_start')

  // 1 — bypass-flag aliasing, before parsing AND before any raw-argv scan,
  // so exactly one spelling reaches every consumer.
  process.argv = process.argv.map(arg => BYPASS_ALIASES[arg] ?? arg)

  // 2–5 — the early seams, in pinned order.
  applyBootMenuEnv();
  ensurePrivateConfigHome();
  collectLauncherNotes();

  // 6 — surface dump escape hatch: the effective command-surface catalogue
  // as one pretty-printed JSON document, before any UI mounts.
  const surfaceDumpPath = flagEnv('MERCURY_SURFACE_DUMP')
  if (surfaceDumpPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(surfaceDumpPath, JSON.stringify(surfaceDumpDocument(), null, 2))
    process.exit(0)
  }

  // 7 — Windows PATH-hijack defence before any command execution can occur.
  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  // 8 — warning handler, terminal hand-back, SIGINT posture.
  const { initializeWarningHandler } = await import('./utils/warningHandler.js')
  initializeWarningHandler()
  process.on('exit', () => {
    // Restore the cursor and hand the terminal's own background colour back
    // (a no-op unless this process set it). Guarded on a real terminal so
    // JSON/pipe consumers never receive control bytes.
    if (!process.stderr.isTTY) return
    process.stderr.write('\x1b[?25h')
    process.stderr.write('\x1b]111\x07')
  })
  if (!isPrintModeArgv()) {
    // In print mode the print path owns its own interrupt handling and this
    // listener must stand down.
    process.on('SIGINT', () => process.exit(0))
  }
  profileCheckpoint('main_warning_handler_initialized')

  // 9 — interactivity decision.
  const printFlag = isPrintModeArgv()
  const initOnlyFlag = process.argv.includes('--init-only')
  const stdoutTty = Boolean(process.stdout.isTTY)
  const isNonInteractive = printFlag || initOnlyFlag || !stdoutTty
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }
  setIsInteractive(!isNonInteractive)
  if (!stdoutTty && !printFlag && !initOnlyFlag && process.stdin.isTTY) {
    // Advisory only — never changes the routing decision.
    writeErr(
      'stdout is not attached to a terminal, so this run is non-interactive. Pass -p to silence this note, or attach a terminal to get the interactive session.',
    )
  }

  // 10 — entrypoint stamping (MERCURY_ENTRYPOINT is the one spelling; a
  // parent Mercury process may have stamped the child already).
  if (!process.env.MERCURY_ENTRYPOINT) {
    const mcpIndex = process.argv.indexOf('mcp')
    const mcpServe = mcpIndex >= 0 && process.argv[mcpIndex + 1] === 'serve'
    process.env.MERCURY_ENTRYPOINT = mcpServe ? 'mcp' : isNonInteractive ? 'sdk' : 'cli'
  }

  // 11 — client type, derived once from the Mercury entrypoint vocabulary
  // (mcp · sdk · cli · local-agent).
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  const clientType = isEnvTruthy(process.env.GITHUB_ACTIONS)
    ? 'github-action'
    : entrypoint === 'sdk'
      ? 'sdk'
      : entrypoint === 'local-agent'
        ? 'local-agent'
        : 'cli'
  setClientType(clientType)

  // 12 — question preview format.
  if (clientType !== 'sdk' && clientType !== 'local-agent') {
    setQuestionPreviewFormat('markdown')
  }
  profileCheckpoint('main_client_type_determined')

  // 13 — settings flags, then run.
  eagerLoadSettings()
  profileCheckpoint('main_before_run')
  await run();
  profileCheckpoint('main_after_run')
}

// ── the two eager settings flags ──────────────────────────────────────
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  const argv = process.argv
  // Both option spellings read identically (FC-028): the = form was
  // accepted by the option table and silently ignored by this eager layer —
  // no layer loaded, no source restriction applied.
  //
  // Scan only the option region and take the LAST occurrence (W6 flags-and-argv:
  // settings= inert, residuals). The `--` end-of-options sentinel stops the
  // scan, exactly as substrate/argvSpellings does — without it this scan read a
  // flag the parser had already placed beyond options as an operand. And a
  // repeated flag follows commander's own last-wins precedence rather than
  // indexOf's first-wins.
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
        // Re-serialise, then escape every C1 control character as \uXXXX so
        // the content hash is independent of how the invoking shell handled
        // raw control bytes; the path derives from the content hash because
        // it ends up inside a tool description sent to the model, and a
        // random path per subprocess would invalidate the provider's prompt
        // cache on every call.
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

// ── the CLI ─────────────────────────────────────────────────────
async function run(): Promise<void> {
  profileCheckpoint('run_function_start')
  const cliName = binaryName()
  const program = new CommanderCommand()
  // FC-137: the activity ledger declared a verb:<name> kind with NO
  // construction site anywhere — six mercury health runs read verbs 0 ·
  // no headless activity recorded. One producer at the dispatch seam
  // covers every subcommand, nested (mcp serve → verb:mcp:serve) and
  // future alike; the bare default action stays classified in print.ts
  // (print/sdk), and the ledger is fail-soft by contract.
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
        // Dynamic import: a relative require does not resolve inside the
        // single-file bundle, and a static import would move the
        // boot-contract ledger for bookkeeping. Configs must be enabled
        // before the ledger can persist — the idempotent latch every verb
        // flips in its own handler moments later.
        const { enableConfigs } = await import('./utils/config/globalConfig.js')
        enableConfigs()
        const { noteHeadlessActivity } = await import('./utils/activityLedger.js')
        noteHeadlessActivity(`verb:${names.join(':')}`)
      }
    } catch {
      // the ledger is bookkeeping — a failed stamp never blocks the verb
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
      // Both writers first release any alternate-screen hold the launcher is
      // holding, or usage/help text paints into a discarded buffer.
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
      // FC-078: Number alone admitted 0 (cap removed), NaN (cap removed)
      // and negatives (fired on the first turn) — refuse junk at the door.
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
      // Help advertises ONLY the new mode ids (.choices), while the parser
      // decodes retired external spellings through the bounded alias first
      // (scripts and muscle memory keep working; the session runs the new id).
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
      // An InvalidArgumentError is commander's HARD refusal (it prints and
      // exits 1). parseCliEffort's warning is written for the env door, which
      // genuinely ignores the value and runs — "ignoring it in favour of the
      // default" is the opposite of what a hard refusal did, so an operator
      // was told the run went ahead on the default when it never started (W6
      // flags-and-argv: effort refusal claims it ignored the value). Refuse
      // honestly, naming the ladder the description also now names — the help
      // line was the only value-taking root flag that listed none. The
      // parser keeps the one normalizer (a plain spelling or alias is its
      // ladder word); the env door's ignoring is said at boot (the effort
      // owner's describeEffortEnvOverride), never in this sentence.
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
    // The two lifecycle switches (the operator's word).
    // Both spellings admit: the banked `-chat` / `-concourse-off` /
    // `-concourse-on` rewrite to these at cli entry (substrate/argvSpellings).
    .option('--chat', 'Boot the plain world: the Boot face and a chat, nothing else on the strip — no concourse in this boot; ↵ New Session on the menu starts the chat (the classic feel; `-chat` is the same switch)')
    .option('--concourse-off', 'Turn the session concourse off for this and every future boot (persisted; the strip is the boot face and the chat alone; the boot face\'s Session Concourse row keeps a plain live view of your sessions; `-concourse-off` is the same switch)')
    .option('--concourse-on', 'Turn the session concourse back on for this and every future boot (persisted; the default is on; `-concourse-on` is the same switch)')
    .option('--agents <json>', 'Extra agent definitions (JSON)')
    .option('--setting-sources <sources>', 'Comma-separated allowed setting sources')
    // Single-valued and repeatable — a variadic form would swallow a
    // following subcommand name.
    .option('--extension <path>', 'An extension folder approved for this session only (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
    .option('--disable-slash-commands', 'Disable all slash commands')
    .option('--file <specs...>', 'Attach files (file_id:relative_path pairs)')
    .option('-v, --version', 'Print the version')
    .option('-w, --worktree [name]', 'Run inside a managed worktree')
    .option('--tmux', 'Create a tmux session for the worktree')

  // Advisor is gated behind a constantly-false table pin in this build: the
  // --advisor option is never registered and the advisor block never runs.

  // Teammate identity options, all hidden and type-guarded at read time.
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

  // -V is registered separately with its own listener: the parser keeps only
  // one short and one long flag per option, and a three-flag form silently
  // drops --version.
  program.addOption(new Option('-V', 'Print the version').hideHelp())
  program.on('option:V', () => {
    releaseLauncherAltHoldNow()
    // writeSync: an async TTY write on win32 can be discarded by the exit
    // (the failLoud discipline — same class as the git-bash refusal).
    try {
      // The same banner the other two spellings print: the zero-import fast
      // path (entrypoints/cli) and the -v/--version slow path both write
      // `Mercury <version>`, and -V is documented as the identical spelling.
      // It used to write `<version> (<binary>)` — a different string the
      // moment a second token was on the command line (W6 flags-and-argv: -V
      // prints two different version strings). writeSync stays: an async TTY
      // write on win32 can be discarded by the exit.
      writeSync(1, `Mercury ${MERCURY_VERSION}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(0)
  })
  profileCheckpoint('run_main_options_built')

  // Pre-parse root-argument interception.
  if (process.argv[2] === '--rollback' || process.argv[2] === '-rollback') {
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, 'Rollback is an update operation — run `mercury update --rollback`\n')
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(2)
  }

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    profileCheckpoint('preAction_start')
    // The module-evaluation subprocess prefetches must land before the
    // first settings read. A slow keychain or MDM read here blocked the
    // boot for up to 10s with a BLANK terminal and no word — one unref'd
    // line names the wait when it crosses ~1.5s (cleared by the next paint;
    // TTY-only so pipelines stay byte-clean).
    const slowBootNote = setTimeout(() => {
      if (process.stderr.isTTY) process.stderr.write('checking the system keychain and managed settings…\n')
    }, 1_500)
    slowBootNote.unref?.()
    // The policy tier is PARSED into its caches here, not merely awaited
    // (release-hardening audit rank 22): the startup raw read's result was
    // discarded, so a registry- or plist-delivered policy served an EMPTY
    // tier until the 30-minute poll set the cache — sessions shorter than
    // that never saw it, longer ones saw permissions change under them, and
    // bare and remote modes (no poll) never saw it at all. The load reuses
    // the in-flight startup read; a failed read degrades to no policy tier
    // exactly as before and never stops the boot. The settings caches are
    // reset so the first merged read includes the tier. (A dynamic import
    // on purpose: the module is already in the boot graph through
    // settings.ts, so this is a cache hit — and main.tsx's eager static
    // import front stays exactly as the boot contract pins it.)
    const { ensureMdmSettingsLoaded, mdmBootAwaitsRawRead, getMdmSettings, getHkcuSettings } = await import('./utils/settings/mdm/settings.js')
    if (mdmBootAwaitsRawRead()) {
      await ensureMdmSettingsLoaded().catch((error: unknown) => {
        logForDebugging(`MDM settings load failed at boot; no policy tier applies: ${String(error)}`, { level: 'error' })
      })
    } else {
      // FN-020 row 4: the memo says the last completed registry read found
      // no policy value on this machine — the merge proceeds without the
      // tier exactly as it did here before, and the read lands in the
      // background, rewriting the memo for the next boot. Four awaited
      // reg.exe spawns leave the pre-paint path; the spawns still fire.
      // The common outcome (no value, again) changes nothing the merge
      // produced. A value that landed after the merge applies the way the
      // MDM poll applies one: the settings cache resets and every
      // subscriber hears 'policySettings'.
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
    // The API warm-up belongs to the ROOT action alone (the cockpit and
    // print-mode boots, the ones that make a model request): its socket is
    // the one handle a headless subcommand would otherwise wait on after
    // its own work is done — `extensions add` sat 10–30 s on a stalled
    // origin it never used. After init, so CA certs and agents are set.
    if (actionCommand === program) {
      // A signed-out boot has no request to warm up for and must stay
      // silent on the wire (the ledger's MA6).
      preconnectAnthropicApi({ credentialed: hasFirstPartyCredential() })
      profileCheckpoint('init_preconnect_dispatched')
    }
    if (resolveTerminalExperience().terminalTitle.effective) {
      process.title = 'mercury'
    }
    // Idempotent — subcommand handlers never call session setup and would
    // otherwise drop queued events at exit.
    initSinks()
    profileCheckpoint('preAction_after_sinks')
    // The hook is attached before the option is declared, so a runtime
    // guard is required.
    const extensionPaths = program.opts().extension as unknown
    if (Array.isArray(extensionPaths) && extensionPaths.length > 0 && extensionPaths.every(entry => typeof entry === 'string')) {
      // C15: a nonexistent --extension path was accepted bare — the session
      // simply had no such extension and nothing said why. Refuse loudly.
      const { existsSync: extensionDirExists } = require('node:fs') as typeof import('node:fs')
      const missing = (extensionPaths as string[]).filter(entry => !extensionDirExists(entry))
      if (missing.length > 0) {
        failCli(`--extension path${missing.length === 1 ? ' does' : 's do'} not exist: ${missing.join(', ')}`)
      }
      setSessionExtensions(extensionPaths)
    }
    runMigrationsIfNeeded()
    profileCheckpoint('preAction_after_migrations')
    // Both fail open.
    void loadRemoteManagedSettings().catch(() => {})
    profileCheckpoint('preAction_after_remote_settings')
    void loadPolicyLimits().catch(() => {})
    profileCheckpoint('preAction_after_settings_sync')
  })

  program.action(async (prompt: string | undefined) => {
    await defaultAction(prompt, program.opts())
  })

  // Print-mode short circuit: none of the subcommands are reachable in
  // print mode, and the startup-profile report is emitted only on the
  // non-print path.
  const hasControlUri = process.argv.some(arg => arg.startsWith('cc://') || arg.startsWith('cc+unix://'))
  if (isPrintModeArgv() && !hasControlUri) {
    profileCheckpoint('run_before_parse')
    // FC-079: under -p + stream-json the option table's OWN refusals
    // (unknown option, invalid argument) must ride the envelope like every
    // product-composed refusal (failCli above); exitOverride turns
    // commander's exit into a throw this arm re-shapes. Help/version output
    // has already been written when their sentinel codes arrive.
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
  // The add and IdP commands are registered by their owning modules (they
  // declare their own option surfaces), so the import must SETTLE before
  // parse: left unawaited, parseAsync's synchronous command lookup ran
  // first and `mercury mcp add` — the verb four shipped surfaces name —
  // read as an unknown command (TASK-014 W4). Loaded only when argv names
  // mcp, so the general boot pays nothing for it.
  if (process.argv.includes('mcp')) {
    try {
      const { registerMcpAddCommand } = await import('./commands/mcp/addCommand.js')
      // Bridge: those two modules type against @commander-js/extra-typings;
      // this file uses plain commander over the same runtime object.
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
        // Real dispatch happens in the launcher's argv fast path; reaching
        // this action means the fast path did not fire.
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
    .description('Update to the latest private-channel release')
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

// ── the health presentation ladder (`doctor` stays the CLI alias) ─────
async function healthAction(options: {
  json: boolean
  deep: boolean
  fix: boolean
  only?: string
  yes: boolean
}): Promise<void> {
  // Presentation resolves at ingress, before any renderer, raw-mode or
  // alternate-screen module loads — a piped invocation that mounts the
  // renderer first crashes in raw-mode setup.
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
    // --only rides the json seam too (it was dropped here — dead outside
    // --fix): the record narrows to the one check.
    await runHealthJsonCli({ deep: options.deep, only: options.only })
    return
  }
  // --only on the plain path prints the ONE check and exits — never the
  // interactive view (the flag was silently ignored there).
  if (presentation.output === 'text' || presentation.depth === 'deep' || options.only !== undefined) {
    const { runAndRecordHealthReport } = await import('./utils/healthReport.js')
    let completed = 0
    const cert = await runAndRecordHealthReport({
      depth: options.deep ? 'deep' : 'fast',
      // Per-check progress goes to STDERR so a pipe is never contaminated.
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
      // FAULT exits 3 on the plain seam too (FC-044) — one exit vocabulary
      // with the --json seam.
      writeOutAndExit(renderPlainCertificate(filtered), filtered.verdict === 'fault' ? 3 : 0)
      return
    }
    writeOutAndExit(renderPlainCertificate(cert), cert.verdict === 'fault' ? 3 : 0)
    return
  }
  const { healthHandler } = await import('./cli/handlers/util.js')
  const { createRoot } = await import('./ink.js')
  await healthHandler(await createRoot())
}

// ── show <image> ──────────────────────────────────────────────────────
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
    // INPUT validity is the verb's own question (FC-099): the renderer's
    // link tier deliberately degrades when a TERMINAL or native binding
    // cannot render — but a NON-IMAGE file rode the same fallback and
    // exited 0 with a bare [link] line, a success for a user error. The
    // magic sniff refuses non-image bytes loudly before any render.
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
    // The write is awaited to drain — an unflushed pipe write truncates
    // silently.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stdout.write(`${payload}\n`, error => (error ? rejectPromise(error) : resolvePromise()))
    })
    try {
      writeSync(2, `[${rendered.protocol}] ${imagePath}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(0)
  } catch (error) {
    writeErr(`Failed to display the image: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// ── the default action ──────────────────────────────────────────
type RootOptions = Record<string, unknown>

async function defaultAction(inputPromptArg: string | undefined, opts: RootOptions): Promise<void> {
  // The -v/--version OPTION reaches here on the slow path (the bootstrap's
  // zero-import fast path answers the lone-flag form); same banner, then out.
  if ((opts as { version?: boolean }).version) {
    console.log(`Mercury ${MACRO.VERSION}`)
    process.exit(0)
  }
  // The launch spine's FIRST rung stamps at the action's entry (FC-093):
  // it used to stamp deep inside the action, 0.35–4.2 s AFTER the setup
  // screens could arm raw mode — input-live fired first and the spine
  // printed in reverse. Telemetry only; a throw is silent.
  try {
    recordLaunchMilestone('runtime-entry')
  } catch {
    /* telemetry only */
  }
  const cliName = binaryName()
  const isNonInteractiveSession = !getIsInteractive()
  const printMode = Boolean(opts.print)

  // ── validations (each exits 1) ───────────────────────────────────────
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

  // C15: the resume dispatch checks --continue FIRST, so giving both flags
  // silently discarded --resume (the operator's named session lost to
  // "whatever ran last"). A contradiction refuses loudly, like its siblings.
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

  // ── derived option state ─────────────────────────────────────────────
  if (opts.bare) {
    // Before setup or any gated work runs.
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
    // The prefill seeds the early-input buffer consumed by the composer.
    process.stdin.unshift?.(Buffer.from(String(opts.prefill)))
  }

  // Permission bypass: the CLI flag OR the registry consent — the latter
  // restricted to interactive boots so the worker permission floor stays
  // intact under -p.
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
    // Only the rule rewrite happens here; the permission owner arms any
    // active auto-mode state.
    toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext)
  }
  // The workspace/instruction-roots list comes from the SAME admission pass
  // that built the permission context: the flag directories PLUS the
  // remembered `permissions.additionalDirectories`, resolved — not the raw
  // flag values (a remembered directory previously returned to neither the
  // workspace nor the instruction roots at the next boot).
  setAddedDirectories(permissionInit.admittedDirectories)

  // The assistant boot constant is false in this build, mirrored into
  // the shared shell-tool seam exactly once so the foreground blocking
  // budget arms honestly; the bootstrap assistant setter is never called.
  const assistantBootActive = false
  setAssistantModeActive(assistantBootActive)

  // Worktree name/PR split.
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

  // Thinking.
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
  // The effort surfaces read the same answer the request builders read
  // from their options (the thinking-gated lanes send no effort dial while
  // thinking is off, and the surfaces must say so).
  noteSessionThinkingConfig(thinkingConfig)

  // Agents.
  const agentInfo = await getAgentDefinitionsWithOverrides()
  let activeAgents = agentInfo.activeAgents
  let allAgents = agentInfo.allAgents
  if (typedString(opts.agents)) {
    try {
      // TWO stacked faults made every --agents definition vanish silently:
      // (1) the RAW argv string went straight into parseAgentsFromJson,
      // whose record-schema safeParse rejects strings — parse the JSON
      // first (a malformed value lands in the existing catch); (2) the
      // parsed agents' source was remapped to 'flag', a spelling outside
      // the AgentSource union (hidden by an array cast), which
      // getActiveAgentsFromList drops. Keep the parser's own
      // 'flagSettings' — the value both precedence tables know.
      const cliAgents = parseAgentsFromJson(JSON.parse(typedString(opts.agents)!) as unknown)
      allAgents = [...allAgents, ...cliAgents]
      // Recomputed through the same filter that honours operator-disabled
      // agents — concatenating active lists would re-enable them.
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
      // A named agent that does not resolve is a REFUSAL, not a shrug
      // (FC-068): the composed sentence went only to the --debug log and an
      // ordinary session started, exit 0 — an operator whose agent silently
      // did not load had no signal at all. An EXPLICIT --agent flag fails
      // the boot; a settings-borne agent (the flag absent) degrades loudly
      // on stderr but boots, so one stale settings key cannot brick every
      // session.
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

  // Model.
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

  // Advisor: the whole block is gated on the advisor being enabled, which
  // is never the case at the snapshot (the constant-false table pin).
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

  // Teammate role prompts + identity.
  if (teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process') {
    // Pushed before setup captures its snapshot.
    setCliTeammateModeOverride(teammateMode)
  }
  if (agentId && agentName && teamName && agentTypeOpt) {
    // Some built-in roles can only build their prompt against a live tool
    // context; no substitute text is ever synthesised.
    let rolePrompt: string | undefined
    const roleDefinition = findRoleDefinition(agentTypeOpt, activeAgents)
    if (!roleDefinition) {
      logForDebugging(`unknown teammate role '${agentTypeOpt}'; nothing appended`)
    } else {
      // The shared role resolver owns definition-kind differences: built-in
      // roles that demand a live tool context resolve to undefined here
      // (custom and extension roles compose directly).
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

  // ── the prompt (argv + piped stdin) ──────────────────────────────────
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

  // A print run with NO input anywhere, where a VARIADIC list flag captured
  // several values, almost always means the trailing positional prompt was
  // swallowed by the list (`-p --allowedTools "Bash" "do the thing"` puts
  // the prompt INSIDE allowedTools). The generic "input must be provided"
  // line sent operators hunting stdin; refuse here with the named remedy
  // instead. Guarded to the already-failing shape only — resume/continue
  // print runs and piped-stdin runs are untouched.
  if (
    // The explicit -p AND the inferred print shape (a piped stdout with no
    // TTY): the ledger's own repro ran without -p and still landed on the
    // generic misdirecting line, because the guard keyed on the flag alone
    // (TASK-014 w4-f12-01).
    (printMode || !process.stdout.isTTY) &&
    prompt === undefined &&
    !opts.resume &&
    !opts.continue &&
    !opts.fromPr &&
    inputFormat !== 'stream-json' &&
    // An agent whose definition carries an initialPrompt DRIVES the run on
    // its own — that shape ran before this guard and must keep running.
    mainThreadAgentDefinition?.initialPrompt == null
  ) {
    const variadicCandidates: Array<[string, unknown]> = [
      ['--allowedTools', opts.allowedTools],
      ['--disallowedTools', opts.disallowedTools],
      ['--tools', opts.tools],
      ['--mcp-config', opts.mcpConfig],
      ['--add-dir', opts.addDir],
      ['--betas', opts.betas],
      // The seventh variadic flag, missing from the list (w4-f12-02).
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

  // Agent initial prompt: prepended so a leading slash command still runs.
  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof prompt === 'string') {
      prompt = `${mainThreadAgentDefinition.initialPrompt}\n${prompt}`
    } else if (prompt === undefined) {
      prompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  // ── MCP configuration ─────────────────────────────────────────
  // The session-kit pin, consumed ONCE and first: before the
  // MCP resolution below and the command load, so every membership and
  // catalogue read in this process sees the latched kit — and the env
  // spelling is scrubbed before any tool child could inherit it.
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
      // An explicit stderr write plus exit: in stream-json mode the entry
      // function has no awaiting caller and a thrown error would surface
      // only as an unhandled rejection with no visible output.
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

  // Local config resolution starts early — file reads only, no execution —
  // so it overlaps setup, command loading and the trust dialog. The print
  // path is its only consumer: the interactive cockpit's servers are owned
  // by the REPL's connection registry (useManageMCPConnections), which
  // discovers, connects and reconnects after the first paint.
  const strictOrBare = Boolean(opts.strictMcpConfig) || isBareMode()
  const mcpResolutionStartedAt = Date.now()
  // getMercuryMcpConfigs answers {servers, errors} — spreading the wrapper
  // itself would otherwise plant phantom 'servers'/'errors' entries in the batch and
  // drop every configured server from the headless connect.
  const discoveredMcpPromise: Promise<Record<string, ScopedMcpServerConfig>> = strictOrBare
    ? Promise.resolve({})
    : getMercuryMcpConfigs(dynamicMcpConfig).then(resolved => resolved.servers)
  const mcpConfigPromise = discoveredMcpPromise.then(discovered => {
    const merged = { ...discovered, ...dynamicMcpConfig }
    // Null-prototype: keyed by user-supplied server names ('__proto__'-safe).
    const sdk: Record<string, McpSdkServerConfig> = Object.create(null) as Record<string, McpSdkServerConfig>
    const regular: Record<string, ScopedMcpServerConfig> = Object.create(null) as Record<string, ScopedMcpServerConfig>
    for (const [name, config] of Object.entries(merged)) {
      if (config.type === 'sdk') sdk[name] = config
      else regular[name] = config
    }
    logForDebugging(`MCP config resolution took ${Date.now() - mcpResolutionStartedAt}ms`)
    return { sdk, regular }
  })
  // The --mcp-config servers the interactive registry seeds (sdk-type entries
  // ride the SDK control transport, never a TTY session).
  const regularDynamicMcpConfig: Record<string, ScopedMcpServerConfig> = Object.fromEntries(
    Object.entries(dynamicMcpConfig).filter(([, config]) => config.type !== 'sdk'),
  )

  // ── shared preparation (tail) ──────────────────────────────────
  if (process.env.MERCURY_ENTRYPOINT !== 'local-agent') {
    // In-memory registrations the bundled-skill reader consumes
    // synchronously — before the parallel command load memoizes. The
    // bundled workflows register here too: the registry is process-local
    // and nothing else populates it, so without this call the built-in
    // workflows never exist in a live session. Their module pulls the
    // workflow compiler (and its parser) in, so it loads here, awaited in
    // order, rather than riding main.tsx's static front where every route
    // (sidecar, daemon, headless) would pay for it.
    initBundledSkills()
    const { initBundledWorkflows } = await import('./tools/WorkflowTool/bundled/index.js')
    initBundledWorkflows()
  }
  const { getProjectRoot, getOriginalCwd } = await import('./bootstrap/state.js')
  const cwd = process.cwd()
  if (!worktreeEnabled && !isNonInteractiveSession && checkHasTrustDialogAccepted()) {
    // Warm the memoized instruction walk so its directory scan overlaps
    // setup; never under --worktree (the directory changes and the warm
    // would poison the memo).
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
    // The worktree path changes directory; both loads are keyed on cwd.
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

  // `--concourse-off` / `--concourse-on`: a REGISTERED persisted field, set by
  // this CLI switch and /config only, never heal-repainted — it holds for THIS
  // boot and every future one until the symmetric switch flips it back. The
  // sole CLI writer used to sit inside interactiveLaunch, so `--help`'s
  // unconditional "persisted … for this and every future boot" promise was
  // kept only on the interactive road: a headless `-p … --concourse-off` was
  // accepted at exit 0 and wrote nothing anywhere (W6 flags-and-argv: concourse
  // switches inert off the interactive road). Persisted here, before the fork,
  // so the print road honours it too — still exactly one CLI writer. Both on
  // one line: the later one wins, the way a shell reads it.
  if (opts.concourseOff === true || opts.concourseOn === true) {
    const { setConcourseEnabled } = await import('./services/concourse/concourseEnabled.js')
    const lastSwitch = [...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')
    setConcourseEnabled(lastSwitch === '--concourse-on')
  }

  // ── the interactive/print fork ───────────────────────────────────────
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

// ── stdin helpers ──────────────────────────────────────────────────────────
/** Stream-json stdin: RAW utf8 chunks with the newline framing intact — the
 *  StructuredIO layer owns line splitting and classifies a frame at each
 *  '\n'. A readline-based reader here (the S33 root-3 rewrite) stripped the
 *  terminators, so no streamed frame could classify until stdin EOF: every
 *  ACP/SDK/daemon stream-json child sat on an unread first prompt forever
 *  (LANE ACP root cause, proven live — the parked frame classified
 *  the instant the pipe EOF'd). Lazy generator on purpose: stdin stays
 *  untouched until the engine's stdin loop first pulls. */
async function* readStdinChunks(): AsyncIterable<string> {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) yield chunk as string
}

/** Read stdin fully; a bounded peek waits up to `timeoutMs` for the first
 *  byte. `null` means the peek timed out with no data. The peek always runs
 *  — an inherited pipe nobody writes to is indistinguishable from a slow
 *  producer at decision time. */
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
    // An item that parses as JSON is an inline document; anything else is a
    // file path. Both parsers report through their error list, never throw.
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
    // Later items override earlier ones by name.
    Object.assign(servers, parsed.config?.mcpServers ?? {})
  }
  return { servers, errors }
}

// ── interactive launch ───────────────────────────────────────────────
async function interactiveLaunch(args: {
  opts: RootOptions
  commands: import('./commands.js').Command[]
  prompt: string | undefined
  permissionMode: PermissionMode
  toolPermissionContext: AppState['toolPermissionContext']
  allowDangerousSkip: boolean
  /** The --mcp-config servers (non-sdk), seeded into the REPL's connection
   *  registry — the one interactive MCP owner. */
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

  // --init-only: config env, setup + session-start hooks synchronously,
  // shut down 0.
  if (opts.initOnly) {
    applyMergedConfigEnv()
    await processSetupHooks('init', { forceSyncExecution: true })
    await processSessionStartHooks('startup', { forceSyncExecution: true })
    await gracefulShutdown(0)
    return
  }

  profileCheckpoint('action_before_create_root')
  // exitOnCtrlC MUST be false for the interactive root (exit-grammar fix
  // restoring the pre-rewrite value the S33 spine rewrite
  // flipped): with true, the ink App layer hard-exits on the FIRST \x03 and
  // use-input starves every handler of ctrl+c — no interrupt, no exit chord,
  // no selection copy. Mercury owns the whole ctrl+c grammar itself.
  const { renderOptions, getFpsMetrics, stats } = getRenderContext(false)
  const { createRoot } = await import('./ink.js')
  const root = await createRoot(renderOptions)
  profileCheckpoint('action_after_create_root')

  // Startup-time measurement ahead of any blocking dialog, so trust/logins/
  // onboarding decision time never counts.
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
    // The user cache resets BEFORE gates refresh, so gates see fresh
    // credentials.
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
    // A graceful shutdown was already initiated (e.g. trust rejected).
    // Nothing that could execute code may run past this point — but the
    // abandonment itself must not be wordless: an interactive boot that
    // returns here dies with a non-zero code and NOTHING on the screen
    // (the field's "exit 1 with zero output" class, TASK-017 F-1). The
    // honest line rides a process-exit hook so it lands AFTER the shutdown
    // path's terminal restoration, on the terminal the operator keeps.
    announceAbandonedLaunch()
    logForDebugging('graceful shutdown already initiated; abandoning interactive launch')
    return
  }
  if (isShuttingDown()) {
    // The same abandonment inside the shutdown's own stamp window (the
    // exit code lands only after two awaits); the hook reads the FINAL
    // code, so a deliberate clean quit stays quiet on its own.
    announceAbandonedLaunch()
    logForDebugging('shutdown in progress; abandoning interactive launch')
    return
  }

  // Background discovery: startup work not required before render is
  // REGISTERED, not executed; trust is established before the graph arms.
  registerBackgroundNode('lsp-manager', async () => {
    initializeLspServerManager()
  })
  registerBackgroundNode('startup-prefetch-batch', async () => {
    await runStartupPrefetchBatch()
  })
  registerBackgroundNode('example-commands', async () => {
    await refreshExampleCommands()
  })
  // MCP is deliberately NOT a node here: the REPL's MCPConnectionManager
  // (useManageMCPConnections) is the one interactive owner — it discovers,
  // connects, reconnects and toggles through its registry after the first
  // paint. A second connect from this graph spawned every stdio server twice
  // and left the --mcp-config servers outside the registry (no reconnect, no
  // toggle), while the registry ignored --strict-mcp-config.
  registerBackgroundNode('session-registry', async () => {
    await registerSession()
    if (args.sessionTitle) await updateSessionName(args.sessionTitle)
  })
  registerBackgroundNode('session-telemetry', async () => {
    // The one telemetry shell with a real side effect: the initial-model
    // resolve (result unused) and the extensions load (local files only).
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

  // Settings validation errors (MCP-metadata errors do not block settings
  // loading) in a blocking dialog whose exit is a graceful shutdown 1.
  const settingsErrors = getSettingsWithErrors().errors.filter(
    error => error.mcpErrorMetadata === undefined,
  )
  if (settingsErrors.length > 0) {
    await launchInvalidSettingsDialog(root, {
      settingsErrors,
      onExit: () => void gracefulShutdown(1),
    })
  }

  // Initial notifications.
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

  // Effective permission context: a teammate that requires strategy mode
  // forces 'strategy' when swarms are on.
  const { isAgentSwarmsEnabled } = await import('./utils/agentSwarmsEnabled.js')
  let effectiveContext = args.toolPermissionContext
  if (isAgentSwarmsEnabled() && args.teammateContext.planModeRequired) {
    effectiveContext = { ...effectiveContext, mode: 'strategy' }
  }

  // The initial application state.
  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().effortLevel
  const supercodeArmed = opts.effort === undefined && Boolean(getInitialSettings().supercodeEffort)
  // The env door ignores a word off the ladder; the ignoring is said on the
  // boot surface (a note — never a raw stderr line above the first frame).
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') addBootNote('warn', effortEnv.sentence)
  // Synchronously computed so no state update happens during render; also
  // published as the dynamic team context for hooks and permissions.
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
    // The store key is effortValue (a conditional spread bypasses excess
    // checks, so a wrong key here would seed a dead field silently).
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    ...(supercodeArmed ? { supercode: true } : {}),
    ...(isAdvisorEnabled() && args.advisorModel ? { advisorModel: args.advisorModel } : {}),
    // The roster the REPL and every tool-use context read from app state:
    // without this seed the store keeps the default empty roster and every
    // agent spawn fails as unknown.
    agent: args.mainThreadAgentDefinition?.agentType,
    agentDefinitions: { activeAgents: args.activeAgents, allAgents: args.allAgents },
    // Teammate identity: the dynamic context was set from spawn args just
    // above; the initial team context computes synchronously from the
    // roster. Not a teammate ⇒ no key (the leader's context comes from
    // replLauncher's projection, which fills only when this left it unset).
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

  // Startup counter: first-render readers read the config cache, so the
  // increment lands there synchronously — while the locked, backed-up,
  // fsync'd disk publish it used to pay in front of the first paint rides
  // the launch graph's background class instead (FN-020 row 5), with the
  // invocation record beside it (no first-frame reader; a read-modify-
  // write plus rename). Any config save in between folds the increment
  // into its own write. Named trade: a crash before the node runs loses
  // one startup count and one invocation row — telemetry-grade.
  saveGlobalConfigDeferred(current => ({ ...current, numStartups: (current.numStartups ?? 0) + 1 }))
  // Reaching the increment means an interactive boot completed — the one
  // place the launcher's failed-attempt record may be erased. This stays
  // synchronous on purpose: one unlink, and a boot quit before the
  // background class ran must never read as a failed attempt (the brick
  // signature doctor names).
  clearBootAttempts()
  // from here on, every session switch reconciles the abandoned
  // previous id's provisional boot artifacts. Armed BEFORE the resume
  // processing below so the boot-minted id is the first "previous".
  armProvisionalSessionReconcile()
  registerBackgroundNode('startup-records', () => {
    flushDeferredGlobalConfigSaves()
    try {
      // runtime-entry stamped at the action's entry (FC-093); the invocation
      // record keeps its settled home here.
      recordInvocation()
    } catch {
      // Telemetry failure is silent.
    }
  })

  // CLOSE-ALL AT THE QUIT (the control-plane model, law 3): quitting this
  // screen parks every session it was running — armed once for every
  // interactive boot, fired from the shutdown cleanup.
  {
    const { armQuitParksAll } = await import('./services/switchboard/quitParksAll.js')
    armQuitParksAll()
  }
  if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {
    // The launcher shows the same splash for these boots as for a bare
    // launch; the mark is how the surface resolver tells them apart. `--chat`
    // is NOT one of them: it lands on the boot face like a bare boot (L15).
    markExplicitBootJourney()
  }
  if (opts.chat === true) {
    // `--chat` is THE PLAIN WORLD for this boot: it lands on the boot face
    // like a bare boot (the landing rule), the strip is [boot face] ⇄ [chat]
    // with no concourse stop between them (the same world the persisted
    // switch off gives every boot), and ↵ New Session is the door — no
    // session is born at boot (the operator's L15). The router reads the
    // one fact from this mark and the switch; no third flag exists.
    const { markChatBoot } = await import('./context/surfaceRoute.js')
    markChatBoot()
  }

  const appProps = {
    getFpsMetrics,
    stats,
    initialState,
  }
  // Session-start hooks belong to the SESSION: the managed session's runner
  // fires them when its process boots (the first message creates it), so a
  // boot fires none in the screen.
  // The screen takes only what the FACE needs: the command table, the tool
  // table (for the dialogs' readouts), the debug and slash-command switches.
  // Everything that shapes an ENGINE (the thinking config, the MCP configs,
  // the agent definition, the strict-MCP posture) rides into the session
  // the first message creates through the runner argv table.
  const replProps: REPLProps = {
    commands,
    initialTools: [...getTools(effectiveContext)],
    debug: Boolean(opts.debug),
    disableSlashCommands: Boolean(opts.disableSlashCommands),
  }

  if (!getIsInteractive()) return

  // Arm background discovery before the launch site; interactive-only.
  armBackgroundDiscovery();

  try {
    // ONE resume path for every door — --continue, --resume <id>, --resume
    // <title>: the session comes back as a MANAGED session. Its transcript
    // paints on the first frame from its file; the daemon admits the SAME
    // durable session behind the paint (the first message waits for it).
    type ResumeLog = { fullPath?: string; customTitle?: string; agentName?: string }
    const resumeAtBoot = async (sessionId: string, log: ResumeLog): Promise<boolean> => {
      if (opts.forkSession) {
        writeErr('--fork-session: a managed resume continues the session as itself — the flag is ignored')
      }
      const { focusResumedSession } = await import('./services/switchboard/hopIntoSession.js')
      const outcome = await focusResumedSession(sessionId, log.fullPath, {
        ...(log.customTitle ?? log.agentName ? { title: (log.customTitle ?? log.agentName) as string } : {}),
        // The boot's resolved posture rides the resume (parity with the
        // blank chat's first message).
        permissionMode: args.permissionMode,
      })
      if (outcome.ok) return true
      await exitWithError(root, `Failed to resume session ${sessionId}: ${outcome.reason}`)
      return false
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
        // The CLI-supplied id is a plain string; the store keys on the
        // branded form.
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
        // The interactive resume chooser owns its own post-selection launch —
        // the one deliberate exception to the single launch site.
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
      // A fresh boot has NO chat (Law 9, rule 1). The boot's own facts —
      // the title (-n), the effort, the RESOLVED permission posture (the
      // CLI flag, else the settings' default, else `default` — the same
      // posture the screen's own readouts show), and every runner-side
      // option (the one table in switchboard/runnerArgv.ts) — park for the
      // sessions this screen births, so each is the same compute as a
      // separately launched Mercury with these options, never the seat's
      // own convention.
      const facts = await import('./services/switchboard/bootBirthFacts.js')
      const { runnerArgvFromBoot } = await import('./services/switchboard/runnerArgv.js')
      facts.setBootBirthFacts({
        title: args.sessionTitle ?? null,
        effort: typeof opts.effort === 'string' ? opts.effort : null,
        permissionMode: args.permissionMode,
        runnerArgv: runnerArgvFromBoot(process.argv.slice(2)),
      })
      // THE CHAT-FORWARD BOOTS: an argv prompt (words for the model) and an
      // inline boot (MERCURY_FULLSCREEN=0 — no boot face to enter from) are
      // explicit chat journeys, so the session is born at boot (born =
      // registered, rule 2) and focused; the boot face is one shift+← away.
      // `--chat` is NOT one: it lands on the boot face and births at ↵ New
      // Session (L15) — the menu's mount warms the daemon and its runner
      // beneath the face, so that ↵ is the warm road. A slash line on argv
      // (the splash's Doctor splice) is a screen command, not words — no
      // birth. A refused birth leaves the slot resting; the root REPL then
      // yields to the boot face.
      const promptIsWords = typeof inputPrompt === 'string' && inputPrompt.trim() !== '' && !inputPrompt.trimStart().startsWith('/')
      const { isFullscreenEnvEnabled } = await import('./utils/fullscreen.js')
      if (promptIsWords || !isFullscreenEnvEnabled()) {
        const { bornSession } = await import('./services/switchboard/bornSession.js')
        // STARTED, never awaited here: awaiting gated the FIRST PAINT on a
        // daemon round-trip — on a box where the daemon is absent (a first
        // run is exactly that) or bound but unresponsive, the terminal sat
        // on the launcher's splash hold frame through the whole handshake
        // ladder with nothing painted. The call arms the landing gate on
        // this tick (bornSession routes through withLanding), so the screen
        // mounts held rather than yielding to the face, and the armed words
        // wait for the landing the way the frame does not.
        const birth = bornSession({ workspaceDir: getCwd(), model: null })
        void birth.then(async born => {
          if (born.ok) return
          logForDebugging(`[boot] the chat-forward birth was refused: ${born.reason}`)
          // No chat exists to land on: the journey retracts so the first
          // frame is the Boot face itself — never a settle-long flash of
          // the empty chat before the REPL's yield hands the frame over.
          retractExplicitBootJourney()
          // …and the reason SPEAKS. It names the remedy (`mercury daemon
          // stop` for a daemon that holds the pipe but never answers), and
          // it reached only the debug log, which returns immediately unless
          // --debug was passed. The receipt seam queues until the screen
          // subscribes, so a refusal that settles before the mount is not
          // lost. Imported at fire time: a cold path never joins the boot's
          // static surface.
          const { mintImmediateReceipt } = await import('./utils/model/seatReceipts.js')
          mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning')
        })
      }
    }

    // Every interactive mode reduces to the SINGLE launch site; sequencing
    // lives solely in replLauncher.launchRepl. The MCP seed rides beside the
    // face's own props: the launcher mounts the ONE interactive MCP owner
    // with the --mcp-config servers and the strict flag.
    await launchRepl(root, appProps, replProps, renderAndRun, {
      dynamicMcpConfig: args.dynamicMcpConfig,
      isStrictMcpConfig: Boolean(args.opts.strictMcpConfig),
      ...(args.opts.ide !== undefined ? { ideAutoConnect: Boolean(args.opts.ide) } : {}),
    })
  } catch (error) {
    // A failure past this point exits loudly and non-zero: the error frame
    // painted inside the launcher-held alternate screen disappears when the
    // screen is released — stderr is what remains. The same catch receives
    // a later render failure (wait-until-exit rejection), so the wording
    // must not presume boot.
    logError(error)
    // Consequence + next action only: the stack (bundle file:line:col) lives
    // in the crash report and the log, never on the terminal the operator is
    // left looking at.
    const detail = error instanceof Error ? error.message : String(error)
    writeErr(`Mercury exited on an error: ${detail}`)
    const crashPath = lastCrashReportPath()
    if (crashPath) writeErr(`Crash report: ${crashPath}`)
    writeErr(`Run ${binaryName()} health for diagnostics.`)
    // The bounded crash-shutdown (prove-crash-shutdown): the cleanup
    // registry, the named exit-cliff drains and the resume hint land under
    // the ruled cap — a bare exit here discarded the transcript writer's
    // in-flight appends while the crash card said "preserved". The road
    // exits from inside; the exit below is the double-shutdown belt only.
    await crashShutdown(1)
    process.exit(1)
  }

  void startupMeasuredAt
}

function assistantBridgeSeed(): boolean {
  // The assistant boot constant is false in this build; it is OR-ed
  // into the bridge-enabled seed.
  return false
}

// the startup network prefetch batch. The gate keys are contract
// data: the feature-gate service is an owned static table with no remote
// path, so both resolve to their inline defaults at the snapshot.
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

// Print-mode connection sequence.
async function connectMcpBatch(
  configs: Record<string, ScopedMcpServerConfig>,
  setAppState: (updater: (previous: AppState) => AppState) => void,
): Promise<void> {
  // The runner road consults the membership owner like every other connect
  // road: excluded entries surface as truthful 'disabled' roster rows (the
  // same seed the interactive registry performs — disabled included,
  // connections absent) and are never dialed. Before this consult the
  // headless batch connected disk-disabled servers, and /mcp status then
  // reported them 'connected'.
  //
  // The normalized-prefix collision fence runs first, before anything is
  // spawned — the one verdict the interactive walk reads (FC-023). Without
  // it the headless batch spawned both colliders, reported both connected,
  // dropped the second namespace at the name-dedupe and let a grant for one
  // name execute the other (FN-015 rank 35). A collider is a failed roster
  // row carrying the reason; it is never dialed.
  const { survivors, collided } = fenceMcpPrefixCollisions(configs)
  const { members, excluded } = partitionMcpConfigsByMembership(survivors)
  if (members.length === 0 && excluded.length === 0 && collided.length === 0) return
  // Pending first, so pending-aware tool surfaces see every configured
  // server; each member entry is replaced as it settles.
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
        // Discovery payload comes from the per-client fetchers, not the
        // connection object.
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
        // The failed row carries the connect failure's own sentence — a
        // re-mark without it painted a bare "(failed)" on /mcp.
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

// ── the print path ───────────────────────────────────────────────────
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

  // A one-shot print run (text input) never starts the self-pacing scheduler,
  // so the scheduling tools must not be in the pool. Record it BEFORE the pool
  // is assembled — a stream-json INPUT run keeps them (it schedules).
  setHeadlessOneShot(args.inputFormat !== 'stream-json')

  // 1 — the headless tool pool; the synthetic structured-output tool is
  // appended after normal filtering (deliberately exempt from it).
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
        // A tool-construction failure yields no tool and no error.
      }
    }
  }
  profileCheckpoint('action_tools_loaded')

  const formatted = args.outputFormat === 'stream-json' || args.outputFormat === 'json'
  void formatted

  // 3 — print mode is trusted; the help text documents it.
  applyMergedConfigEnv()

  // 4 — session-start hooks overlap MCP connect and module import; the
  // rejection is pre-caught so the global handler stays quiet while the
  // downstream await still observes it.
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

  // 6 — the command table. A SESSION's runner (a concourse-managed session
  // — the daemon stamps MERCURY_CONCOURSE_WORKER on it) executes every
  // command of the screen's table whose seat is the session: one table, one
  // dispatch rule (commandSeat). A plain print run keeps the headless
  // subset — no operator sits behind it.
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

  // 7/8 — the headless app state and store.
  const config = getGlobalConfig()
  const effortLevel = (opts.effort as EffortLevel | undefined) ?? getInitialSettings().effortLevel
  const supercodeArmed = opts.effort === undefined && Boolean(getInitialSettings().supercodeEffort)
  // The env door ignores a word off the ladder; a headless run says so on
  // stderr (the run itself proceeds as if the variable were unset).
  const effortEnv = describeEffortEnvOverride()
  if (effortEnv.state === 'ignored') process.stderr.write(`${effortEnv.sentence}\n`)
  const initialState: AppState = {
    ...getDefaultAppState(),
    toolPermissionContext: args.toolPermissionContext,
    verbose: Boolean(opts.verbose) || Boolean(config.verbose),
    // The store key is effortValue (a conditional spread bypasses excess
    // checks, so a wrong key here would seed a dead field silently).
    ...(effortLevel !== undefined ? { effortValue: effortLevel } : {}),
    ...(supercodeArmed ? { supercode: true } : {}),
    ...(isAdvisorEnabled() && args.advisorModel ? { advisorModel: args.advisorModel } : {}),
  }
  const store = createStore<AppState>(initialState, ({ newState, oldState }) =>
    onChangeAppState({ newState, oldState }),
  )

  // 9 — the organisation-policy bypass check corrects state in parallel.
  // The posture predicate covers autopilot too, so an org kill dethrones an
  // autopilot boot as well; the killswitch operates on the permission
  // context, so the setter is scoped down to it.
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

  // 11 — SDK betas through the allowlist.
  if (Array.isArray(opts.betas) && opts.betas.length > 0) {
    const { filterAllowedSdkBetas } = await import('./utils/model/capabilities.js')
    const { setSdkBetas } = await import('./bootstrap/state.js')
    setSdkBetas(filterAllowedSdkBetas(opts.betas.filter((beta): beta is string => typeof beta === 'string')))
  }

  // 12 — MCP connect, inline: a single-turn run needs the configured tools
  // at turn 1.
  profileCheckpoint('action_before_mcp_configs_await')
  const { sdk: sdkMcpConfigs, regular: regularMcpConfigs } = await args.mcpConfigPromise
  profileCheckpoint('action_mcp_configs_loaded')
  // THE KIT COMPLETION: an UNRESOLVED latch (the daemon's
  // derived stamp — deltas + provisional lists) completes HERE, where both
  // the resolved MCP config and the post-overlay command table are in hand
  // and BEFORE the partition below reads membership: the runner composes
  // the RESOLVED snapshot from its own roster and flips the latch; the
  // session_facts answer then reports it and the daemon stamps the record
  // — the only road from provisional to resolved.
  {
    // The refused-pin receipt row (ruling 2's second half): identity is
    // bound by this step on every daemon road — the durable sidecar gets
    // the same typed sentence stderr carried at consume time. Once.
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
  // Bounded (FN-015 rank 39): the batch was awaited whole with no outer
  // bound — one dead or stalling server held the first output for its full
  // connect deadline plus an unbounded discovery, and Promise.all made every
  // other server's tools wait for it. The launch now waits as long as one
  // connect may take (the MCP_TIMEOUT deadline); a server still settling
  // then serves later calls — the headless tool pool reads the store live.
  if ((await withMcpLaunchBudget(connectMcpBatch(regularMcpConfigs, store.setState), mcpLaunchBudgetMs())) === 'timeout') {
    logForDebugging(`MCP servers were not all ready within ${mcpLaunchBudgetMs()}ms; continuing — late servers serve later calls`)
  }
  profileCheckpoint('after_connectMcp')
  await connectClaudeAiConnectors(store)
  profileCheckpoint('after_connectMcp_claudeai')

  // 13 — a scripted run has no idle interval to hide these in.
  if (!isBareMode()) {
    startDeferredPrefetches()
    startBackgroundHousekeeping()
  }

  // 14 — the headless runner.
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
        // The warm-runner discriminator: a concourse worker booted WITHOUT
        // this pin (and without resume) parks identityless awaiting the
        // daemon's claim_session control (daemon/warmRunner.ts).
        bootSessionIdPinned: Boolean(typedString(opts.sessionId)),
        sessionStartHooksPromise,
      },
    )
  } catch (error) {
    // Only unexpected rejections land here; the runner settles its own
    // expected failures. Without this catch the process-wide handler only
    // logs and the process ends 0 with nothing on stderr.
    writeErr(`Error: ${error instanceof Error ? error.message : String(error)}`)
    if (!isShuttingDown()) {
      await gracefulShutdown(1)
    }
  }
}

// Steps 3–6 — claude.ai connectors (print mode only).
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
    // Extension-sourced servers lose to a matching connector; only servers
    // already CONNECTED are actively disconnected (the cache clear would
    // otherwise open a connection just to close it).
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
    // Connectors that duplicate an enabled MANUAL server by URL signature —
    // considering only non-extension entries — are themselves suppressed.
    const manualSignatures = new Set(
      store
        .getState()
        .mcp.clients.filter(
          client => !client.name.startsWith('ext:') && !suppressed.includes(client.name),
        )
        .map(client => getMcpServerSignature(client.config)),
    )
    // Null-prototype: keyed by user-supplied server names ('__proto__'-safe).
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
    // The run proceeds; servers that finish later serve later turns.
    logForDebugging('claude.ai connectors were not ready within 5s; continuing')
  }
}

// ── deferred prefetches ──────────────────────────────────────────────
export function startDeferredPrefetches(): void {
  // (No exit-after-first-render short-circuit exists.)
  if (isBareMode()) return
  void (async () => {
    try {
      void getCoreUserData()
      void getUserContext().catch(() => {})
      // Git commands can execute arbitrary code through hooks and config:
      // the system context is prefetched only when trust is implicit
      // (print) or already accepted.
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
