import { Command as CommanderCommand, Option } from 'commander'
import { existsSync, writeSync } from 'node:fs'
import {
  getIsInteractive,
  getSessionId,
  setClientType,
  setInitialEngineModel,
  setSessionExtensions,
  setIsInteractive,
  setEngineModelOverride,
  setMainThreadAgentType,
  setQuestionPreviewFormat,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { surfaceDumpDocument } from './commands/effectiveCatalogue.js'
import { MERCURY_VERSION } from './constants/product.js'
import { getSystemContext, getUserContext } from './context.js'
import { initBundledSkills } from './skills/bundled/index.js'
import { getInstructionFiles } from './services/instructions/engine.js'
import { consumeSessionKitPin } from './services/mcp/sessionKitPin.js'
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMercuryMcpConfigs,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from './services/mcp/config.js'
import { isMercuryServerEnabled, mercuryServerConfig, MERCURY_SERVER_NAME } from './services/mcp/mercuryServer.js'
import { addBootNote, collectLauncherNotes } from './substrate/bootNotes.js'
import { flagEnv, setFlagEnv } from './substrate/flagRegistry.js'
import { recordLaunchMilestone } from './substrate/launchMilestones.js'
import { applyBootMenuEnv, recordBootAdmissionSnapshot, resolveEffectiveSettingsSnapshot } from './substrate/startupMenu.js'
import { getAgentDefinitionsWithOverrides, computeActiveAgents, parseAgentsFromJson, type AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { init } from './entrypoints/init.js'
import { releaseLauncherAltHoldNow } from './ink/launcherAltHold.js'
import { resolveTerminalExperience } from './ink/session/terminalExperience.js'
import { binaryName } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { startCapturingEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js'
import { isBareMode, isEnvTruthy, ensurePrivateConfigHome } from './utils/envUtils.js'
import { logError } from './utils/log.js'
import { getDefaultEngineModelSetting, getEngineModel } from './utils/model/model.js'
import {
  initializeToolPermissionContext,
  stripDangerousPermissionsForFlow,
} from './utils/permissions/permissionSetup.js'
import { modeBypassesPermissions, type PermissionMode } from './utils/permissions/PermissionMode.js'
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'
import { settingsChangeDetector } from './utils/settings/changeDetector.js'
import { getInitialSettings } from './utils/settings/settings.js'
import { parseSettingSourcesFlag } from './utils/settings/constants.js'
import { resetSettingsCache } from './utils/settings/settingsCache.js'
import { setFlagSettingsInline, setFlagSettingsPath, setAllowedSettingSources } from './bootstrap/state.js'
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch, startWaitNote } from './utils/secureStorage/keychainPrefetch.js'
import { sessionIdExists } from './utils/sessionStorage.js'
import { checkHasTrustDialogAccepted } from './utils/config.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import { initSinks } from './utils/sinks.js'
import { setup } from './setup.js'
import type { ScopedMcpServerConfig } from './services/mcp/types.js'
import chalk from 'chalk'
import { inspectSessionArgs as inspectRunArgs, isSessionRunArgv as isRunArgv, readSessionOption } from './cli/sessionArgs.js'
import { applyMergedConfigEnv, exitForCommanderError, failCli, INTERACTIVE_BOOT_OPTIONS, PRINT_ONLY_VERBS, RUN_OUTPUT_OPTIONS, typedString, USAGE_ERROR_CODES, UUID_SHAPE, wantsOutcomeEnvelope, writeErr, type RootOptions } from './main/cli.js'
import { addRootOptions } from './main/rootOptions.js'
import { registerSubcommands } from './main/subcommands.js'
import { interactiveLaunch } from './main/interactiveLaunch.js'
import { runLaunch } from './main/runLaunch.js'
export { startDeferredPrefetches } from './main/deferredPrefetches.js'

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
  profileCheckpoint('main_warning_handler_initialized')

  const runFlag = isRunArgv()
  const stdoutTty = Boolean(process.stdout.isTTY)
  const isNonInteractive = runFlag || !stdoutTty
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }
  setIsInteractive(!isNonInteractive)

  if (!flagEnv('MERCURY_ENTRYPOINT')) {
    const mcpIndex = process.argv.indexOf('mcp')
    const mcpServe = mcpIndex >= 0 && process.argv[mcpIndex + 1] === 'serve'
    setFlagEnv('MERCURY_ENTRYPOINT', mcpServe ? 'mcp' : isNonInteractive ? 'headless' : 'cli')
  }

  const entrypoint = flagEnv('MERCURY_ENTRYPOINT')
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
    if (actionCommand === (program as unknown) || actionCommand.name() === 'run' || PRINT_ONLY_VERBS.has(actionCommand.name())) return
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

  addRootOptions(program)
  profileCheckpoint('run_main_options_built')

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    if (PRINT_ONLY_VERBS.has(actionCommand.name())) return
    profileCheckpoint('preAction_start')
    const slowBootNote = setTimeout(() => {
      if (process.stderr.isTTY) process.stderr.write(`${startWaitNote(process.platform)}\n`)
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
    .argument('[prompt]', 'The prompt; - or no prompt reads it from stdin to the end; with a prompt, anything piped in is added as context — the pipe is read until it closes or has been silent for 1 s')
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

  const mcpServerCommand = program.command('mcp-server')
    .description('Serve Mercury tools over MCP (stdio or authenticated HTTP)')
    .addOption(new Option('--transport <transport>', 'stdio or HTTP').choices(['stdio', 'http']).default('stdio'))
    .option('--bind <address>', 'HTTP listen address (default: 127.0.0.1)')
    .option('--port <port>', 'HTTP listen port (default: 8787)', Number)
    .option('--token-file <file>', 'Read client tokens and their reach from a private JSON file')
    .option('--client <name>', 'Choose the stdio client named in the token file')
    .option('--lead <session-id>', 'The session addressed by lead')
    .option('--coordinator <session-id>', 'The session addressed by coordinator')
    .addOption(new Option('--max-mode <mode>', 'Permission ceiling for client-owned sessions').choices(['default', 'dontAsk', 'implement', 'sovereign', 'flow', 'apollo']))
    .option('--origin <url>', 'Allow this HTTPS tunnel origin')
    .action(async (options, command) => {
      const { mcpServerCli } = await import('./cli/mcpServer.js')
      const session = sessionOptions(command)
      try {
        await mcpServerCli({ ...options, transport: options.transport as 'stdio' | 'http', model: session.model, effort: session.effort, allowSovereign: session.allowSovereign })
      } catch (error) { failCli(error instanceof Error ? error.message : String(error)) }
    })
  for (const option of program.options) {
    if (['--model', '--effort', '--allow-sovereign'].includes(option.long ?? '')) mcpServerCommand.addOption(option)
  }

  const parseProgram = () => program.parseAsync(process.argv)

  if (isRunArgv()) {
    profileCheckpoint('run_before_parse')
    if (wantsOutcomeEnvelope()) {
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
        emitLoadError(String(commanderError.message ?? error), inspectRunArgs(process.argv.slice(2)).format)
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

  if (!runMode && !runnerDoor && !process.stdout.isTTY && process.stdin.isTTY) {
    writeErr(
      'stdout is not attached to a terminal, so this run is non-interactive. Pass run to silence this note, or attach a terminal to get the interactive session.',
    )
  }
  if (!runMode && !process.stdin.isTTY) {
    if (!isNonInteractiveSession) {
      failCli(`Mercury needs a terminal: stdin is not one, so a chat cannot take your keys; for scripts use ${cliName} run -- "<prompt>"`)
    }
    const bareWord = process.argv.slice(2)
    if (bareWord.length === 1 && bareWord[0] === inputPromptArg && /^[A-Za-z][A-Za-z0-9_-]*$/.test(inputPromptArg ?? '')) {
      failCli(`unknown command: ${inputPromptArg} — ${cliName} --help lists every command; to send it as a prompt: ${cliName} run -- "${inputPromptArg}"`)
    }
  }

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
    failCli('mercury run: apollo needs a host that answers its asks — serve the session to one over mercury runner (mercury runner --help), or run apollo in the cockpit')
  }
  if (opts.backupModel && opts.backupModel === opts.model) {
    failCli('--backup-model cannot equal --model')
  }
  if (opts.brief && opts.briefFile) failCli('Use either --brief or --brief-file, not both')
  if (opts.defaultBrief === true && (opts.brief !== undefined || opts.briefFile !== undefined)) failCli('Use either --brief or --default-brief, not both')
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
  const schemaFlag = runMode ? typedString(opts.schema) : undefined
  if (schemaFlag !== undefined) {
    const { schemaFlagRefusal } = await import('./cli/structuredIO.js')
    const refusal = schemaFlagRefusal(schemaFlag)
    if (refusal !== null) failCli(refusal)
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
  const sovereignAvailable = allowDangerousSkip || !isRunArgv()
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
    allowDangerouslySkipPermissions: sovereignAvailable,
  })
  let toolPermissionContext = permissionInit.toolPermissionContext
  for (const warning of permissionInit.warnings) console.error(warning)
  if (permissionInit.dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForFlow(toolPermissionContext)
  }

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
  const { lspAgentNote } = await import('./services/lsp/toolFamily.js')
  for (const agent of activeAgents) {
    if (agent.tools?.includes('LSP')) console.error(lspAgentNote(agent.agentType))
    if (agent.disallowedTools?.includes('LSP')) console.error(lspAgentNote(agent.agentType, true))
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
  if (userSpecifiedModel !== undefined && userSpecifiedModel !== 'default') {
    const { matchReachableModelName, modelNameHeadlessRefusal } = await import('./utils/model/modelNameRoad.js')
    const matched = matchReachableModelName(userSpecifiedModel, 'pass')
    if (matched?.kind === 'match') {
      addBootNote('info', `--model ${matched.said}`)
      userSpecifiedModel = matched.id
    } else if (matched?.kind === 'exact') {
      userSpecifiedModel = matched.id
    } else if (matched !== null && (matched.kind === 'ambiguous' || matched.kind === 'none')) {
      if (runMode) failCli(modelNameHeadlessRefusal(matched, '--model'), 1)
      addBootNote('warn', `${modelNameHeadlessRefusal(matched, '--model')} The session starts on its default model; /model picks another.`)
      userSpecifiedModel = undefined
    }
  }
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
    const debugFilter = typeof opts.debug === 'string' && /\s/.test(opts.debug.trim()) ? opts.debug : null
    const usage = debugFilter !== null
      ? `No prompt reached run: --debug took ${JSON.stringify(debugFilter)} as its category filter. Put the prompt before --debug, or use -d: mercury run ${JSON.stringify(debugFilter)} --debug`
      : 'Usage: mercury run "<prompt>" or pipe a prompt to mercury run -'
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

  if (isMercuryServerEnabled() && Object.keys(dynamicMcpConfig).includes(MERCURY_SERVER_NAME)) {
    writeErr(
      `The MCP server name '${MERCURY_SERVER_NAME}' is reserved while Mercury's in-process MCP server is enabled (MERCURY_COORDINATION_MCP).`,
    )
    process.exit(1)
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
    if (opts.onlyMcp) failCli('--only-mcp is not available when an enterprise MCP configuration exists', 1)
    const allowedCheck = areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)
    if (allowedCheck !== true) {
      failCli('Dynamic MCP servers are not allowed when an enterprise MCP configuration exists', 1)
    }
  }
  if (isMercuryServerEnabled()) {
    dynamicMcpConfig = {
      ...dynamicMcpConfig,
      ...Object.fromEntries(
        Object.entries(mercuryServerConfig()).map(([name, config]) => [
          name,
          { ...config, scope: 'dynamic' as const },
        ]),
      ),
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

  if (flagEnv('MERCURY_ENTRYPOINT') !== 'local-agent') {
    initBundledSkills()
  }
  const { getProjectRoot } = await import('./bootstrap/state.js')
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
    toolPermissionContext,
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

  if (opts.concourseOff === true || opts.concourseOn === true) {
    const { setConcourseEnabled } = await import('./services/concourse/concourseEnabled.js')
    const lastSwitch = [...process.argv].reverse().find(a => a === '--concourse-off' || a === '--concourse-on')
    setConcourseEnabled(lastSwitch === '--concourse-on')
  }
  if (opts.coordinatorOff === true || opts.coordinatorOn === true) {
    process.stderr.write('The Concourse coordinator has been removed, so --coordinator-on and --coordinator-off change nothing: n on the board starts a session.\n')
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const armSilence = (): void => {
      if (timeoutMs < 0) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => finish(null), timeoutMs)
    }
    const onData = (chunk: string): void => {
      chunks.push(chunk)
      armSilence()
    }
    const finish = (empty: string | null): void => {
      if (timer !== undefined) clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      resolvePeek(chunks.length > 0 ? chunks.join('') : empty)
    }
    const onEnd = (): void => finish('')
    const onError = (): void => finish(null)
    armSilence()
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
    let jsonFault = ''
    try {
      inlineObject = JSON.parse(item)
      isInline = true
    } catch (error) {
      isInline = false
      jsonFault = error instanceof Error ? error.message : String(error)
    }
    if (!isInline && (item.startsWith('{') || item.startsWith('['))) {
      errors.push(`--mcp ${item.length > 60 ? `${item.slice(0, 60)}…` : item}: not valid JSON — ${jsonFault}`)
      continue
    }
    if (!isInline && !existsSync(item)) {
      errors.push(`--mcp ${item}: no such file — pass the path of a JSON file with mcpServers, or the JSON itself`)
      continue
    }
    const parsed = isInline
      ? parseMcpConfig({ configObject: inlineObject, expandVars: true, scope: 'dynamic' })
      : parseMcpConfigFromFilePath({ filePath: item, expandVars: true, scope: 'dynamic' })
    for (const entry of parsed.errors) errors.push(`${entry.path}: ${entry.message}`)
    Object.assign(servers, parsed.config?.mcpServers ?? {})
  }
  return { servers, errors }
}
