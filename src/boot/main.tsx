import { featureReached } from '../platform/substrate/featureReached.js'
import { Command as CommanderCommand } from 'commander'
import {
  getSessionId,
  setClientType,
  setSessionExtensions,
  setIsInteractive,
  setQuestionPreviewFormat,
} from './process-state/processState.js'
import { surfaceDumpDocument } from '../commands/catalogue/effectiveCatalogue.js'
import { addBootNote, collectLauncherNotes } from '../platform/substrate/bootNotes.js'
import { flagEnv, setFlagEnv } from '../platform/substrate/flagRegistry.js'
import { applyBootMenuEnv, recordBootAdmissionSnapshot, resolveEffectiveSettingsSnapshot } from '../platform/substrate/startupMenu.js'
import { init } from './entrypoints/init.js'
import { releaseLauncherAltHoldNow } from '../screen/renderer/launcherAltHold.js'
import { resolveTerminalExperience } from '../screen/renderer/terminal-session/terminalExperience.js'
import { binaryName } from '../platform/settings/config.js'
import { logForDebugging } from '../platform/logs/debugLog.js'
import { stopCapturingEarlyInput } from './earlyInput.js'
import { ensurePrivateConfigHome } from '../platform/environment/envUtils.js'
import { logError } from '../platform/logs/errorLog.js'
import { profileCheckpoint, profileReport } from './startupProfiler.js'
import { settingsChangeDetector } from '../platform/settings/changeDetector.js'
import { parseSettingSourcesFlag } from '../platform/settings/settingSources.js'
import { resetSettingsCache } from '../platform/settings/settingsCache.js'
import { setFlagSettingsInline, setFlagSettingsPath, setAllowedSettingSources } from './process-state/processState.js'
import { startMdmRawRead } from '../platform/settings/mdm/rawRead.js'
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch, startWaitNote } from '../platform/secure-storage/keychainPrefetch.js'
import { initSinks } from './sinks.js'
import { inspectSessionArgs as inspectRunArgs, isSessionRunArgv as isRunArgv, readSessionOption } from './sessionArgs.js'
import { exitForCommanderError, failCli, PRINT_ONLY_VERBS, USAGE_ERROR_CODES, wantsOutcomeEnvelope, type RootOptions } from './main/cli.js'
import { addRootOptions } from './main/rootOptions.js'
import { registerSubcommands } from './main/subcommands.js'
import { registerSessionDoors } from './main/sessionDoors.js'
import { passedOver } from '../platform/errors/passedOver.js'
import { hostEnv } from '../platform/environment/hostEnv.js'
import { startTimeout, stopTimeout } from '../platform/async/timers.js'
import { getProcessStartTokenAsync } from '../daemon/control/ownerWatch.js'
export { startDeferredPrefetches } from './main/deferredPrefetches.js'

profileCheckpoint('main_tsx_entry')
startMdmRawRead();
startKeychainPrefetch();
if (isRunArgv()) void getProcessStartTokenAsync(process.pid)
profileCheckpoint('main_tsx_imports_loaded')

function refuseDebugger(): void {
  const isBun = typeof (process as { isBun?: boolean }).isBun !== 'undefined' || process.versions.bun !== undefined
  const flags = isBun
    ? [/^--inspect(-brk)?(=|$)/]
    : [/^--inspect(-brk)?(=|$)/, /^--debug(-brk)?(=|$)/]
  const argvHit = process.execArgv.some(arg => flags.some(re => re.test(arg)))
  const nodeOptions = hostEnv().NODE_OPTIONS ?? ''
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
  const { registerBootDoors } = await import('./doors/registerDoors.js')
  registerBootDoors()
  profileCheckpoint('main_function_start')

  applyBootMenuEnv();
  recordBootAdmissionSnapshot(resolveEffectiveSettingsSnapshot({ sessionId: getSessionId() }));
  try {
    ensurePrivateConfigHome();
  } catch (error) {
    addBootNote('warn', error instanceof Error ? error.message : String(error));
  }
  collectLauncherNotes();

  const surfaceDumpPath = flagEnv('MERCURY_SURFACE_DUMP')
  if (surfaceDumpPath) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(surfaceDumpPath, JSON.stringify(surfaceDumpDocument(), null, 2))
    process.exit(0)
  }

  hostEnv().NoDefaultCurrentDirectoryInExePath = '1'

  const { initializeWarningHandler } = await import('./warningHandler.js')
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

let mdmLoadFailureNoted = false

function noteMdmLoadFailure(error: unknown, where: 'at boot' | 'in the background'): void {
  logForDebugging(`MDM settings load failed ${where}; no policy tier applies: ${String(error)}`, { level: 'error' })
  if (mdmLoadFailureNoted) return
  mdmLoadFailureNoted = true
  const detail = error instanceof Error ? error.message : String(error)
  addBootNote('warn', `the managed policy could not be loaded (${detail}), so it is not applied in this session`)
}
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
    if (actionCommand === program || actionCommand.name() === 'run' || PRINT_ONLY_VERBS.has(actionCommand.name())) return
    try {
      const names: string[] = []
      let node: CommanderCommand | null = actionCommand
      while (node !== null && node !== program) {
        names.unshift(node.name())
        node = node.parent
      }
      if (names.length > 0) {
        const { enableConfigs } = await import('../platform/config/globalConfig.js')
        enableConfigs()
        const { noteHeadlessActivity } = await import('../platform/logs/activityLedger.js')
        noteHeadlessActivity(`verb:${names.join(':')}`)
      }
    } catch (error) {
      passedOver(error)
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
    const slowBootNote = startTimeout(() => {
      if (process.stderr.isTTY) process.stderr.write(`${startWaitNote(process.platform)}\n`)
    }, 1_500)
    slowBootNote.unref?.()
    const { ensureMdmSettingsLoaded, mdmBootAwaitsRawRead, getMdmSettings, getHkcuSettings } = await import('../platform/settings/mdm/settings.js')
    if (mdmBootAwaitsRawRead()) {
      await ensureMdmSettingsLoaded().catch((error: unknown) => {
        noteMdmLoadFailure(error, 'at boot')
      })
    } else {
      void ensureMdmSettingsLoaded()
        .then(() => {
          if (Object.keys(getMdmSettings().settings).length === 0 && Object.keys(getHkcuSettings().settings).length === 0) return
          settingsChangeDetector.notifyChange('policySettings')
        })
        .catch((error: unknown) => {
          noteMdmLoadFailure(error, 'in the background')
        })
    }
    resetSettingsCache()
    profileCheckpoint('preAction_after_mdm')
    await ensureKeychainPrefetchCompleted()
    stopTimeout(slowBootNote)
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

  program.hook('preAction', (_, action) => featureReached('verb', action === program ? 'interactive' : action.parent === program ? action.name() : `${action.parent!.name()} ${action.name()}`))
  const runCommand = registerSessionDoors(program, sessionOptions)

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
        const { emitLoadError } = await import('../daemon/runner/resume.js')
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
