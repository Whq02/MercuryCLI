import { featureReached } from '../substrate/featureReached.js'
import {
  cwdIsMissing,
  evaluateNodeRuntime,
  MISSING_CWD_LINE,
  nodeRefusalMessage,
} from '../utils/runtime/nodePolicy.js'
import { passedOver } from '../utils/passedOver.js'
import { hostEnv } from '../utils/hostEnv.js'
import { consoleNeedsUtf8Codepage } from '../utils/platform/terminal.js'

hostEnv().COREPACK_ENABLE_AUTO_PIN = '0'

async function main(): Promise<void> {
  if (!process.versions?.bun) {
    const nodeDecision = evaluateNodeRuntime(process.versions?.node)
    if (nodeDecision.verdict !== 'supported') {
      console.error(nodeRefusalMessage(nodeDecision));
      process.exit(1)
    }
  }

  const args = process.argv.slice(2)
  if (args[0] === '--tool-shell-parent') {
    const { runShellParentGuard } = await import('../utils/shell/parentGuard.js')
    return runShellParentGuard()
  }

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V' || args[0] === 'version')) {
    featureReached('verb', args[0] === 'version' ? 'version' : '--version')
    console.log(`Mercury ${MACRO.VERSION}`)
    return
  }

  if (args[0] === '--tensorfold-adapter') {
    const { runTensorFoldAdapter } = await import('../services/tensorfold/adapter/main.js')
    const code = await runTensorFoldAdapter(args.slice(1))
    if (code !== 0) process.exitCode = code
    return
  }

  const { flagEnv, stampFlagEnv } = await import('../substrate/flagRegistry.js')
  const { inspectSessionArgs, readSessionOption } = await import('../utils/sessionArgs.js')
  const runArgs = inspectSessionArgs(args)
  const hasProjectRoot = args[0] === '--project' || args[0]?.startsWith('--project=')
  if (hasProjectRoot) {
    try {
      const { applyProjectRoot } = await import('./projectRoot.js')
      applyProjectRoot(process.argv)
      args.splice(0, args.length, ...process.argv.slice(2))
    } catch (error) {
      const message = `Project root: ${error instanceof Error ? error.message : String(error)}`
      console.error(message)
      if (runArgs.command === 'run' && (runArgs.format === 'rows' || runArgs.format === 'json')) {
        const [{ refusedOutcome }, { writeSync }] = await Promise.all([import('../cli/headless/refusalEnvelope.js'), import('node:fs')])
        writeSync(1, `${JSON.stringify(refusedOutcome([message], 'load'))}\n`)
      }
      process.exitCode = 1
      return
    }
  }

  if (cwdIsMissing()) {
    const { writeSync } = await import('node:fs')
    writeSync(2, `${MISSING_CWD_LINE}\n`)
    process.exitCode = 1
    return
  }

  if (args.length === 0 && process.stdout.isTTY && !hasProjectRoot) {
    if (
      consoleNeedsUtf8Codepage() &&
      flagEnv('MERCURY_WIN32_UTF8_PRESET') !== '1'
    ) {
      const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
      ensureWin32ConsoleUtf8()
    }
    const { runDirectSplash } = await import('../substrate/directSplash.js')
    const splash = runDirectSplash({ home: await resolveCompileCacheHome() })
    if (splash.verdict === 'cancel') {
      return
    }
  }

  if (flagEnv('MERCURY_SPLASH_HANDOFF') === '1') {
    const { consumeSplashHandover } = await import('../substrate/splashHandover.js')
    consumeSplashHandover()
  }

  {
    const { applyBankedFlagSpellings } = await import('../substrate/argvSpellings.js')
    applyBankedFlagSpellings(process.argv)
  }

  try {
    if (
      hostEnv().NODE_COMPILE_CACHE === undefined &&
      hostEnv().NODE_DISABLE_COMPILE_CACHE === undefined &&
      !process.versions?.bun
    ) {
      const cacheHome = await resolveCompileCacheHome()
      if (cacheHome) {
        const { join } = await import('node:path')
        const cacheDir = join(cacheHome, 'compile-cache')
        const { compileCacheDirUsable } = await import('../utils/runtime/compileCachePath.js')
        if (compileCacheDirUsable(cacheDir)) {
          const { mkdirSync } = await import('node:fs')
          mkdirSync(cacheDir, { recursive: true })
          const { enableCompileCache, constants: moduleConstants } = await import('node:module')
          const enabled = enableCompileCache(cacheDir)
          if (enabled.status === moduleConstants.compileCacheStatus.ENABLED) {
            hostEnv().NODE_COMPILE_CACHE = enabled.directory ?? cacheDir
          }
        }
      }
    }
  } catch (error) {
    passedOver(error)
  }

  if (!process.versions?.bun && hostEnv().NODE_DISABLE_COMPILE_CACHE === undefined) {
    const cacheHome = await resolveCompileCacheHome()
    if (cacheHome) void import('../utils/runtime/compileCachePrune.js')
      .then(({ pruneCompileCache }) => pruneCompileCache(cacheHome))
      .catch(passedOver)
  }

  if (
    consoleNeedsUtf8Codepage() &&
    process.stdout.isTTY &&
    flagEnv('MERCURY_WIN32_UTF8_PRESET') !== '1'
  ) {
    const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
    ensureWin32ConsoleUtf8()
  }

  if (flagEnv('MERCURY_ALT_HELD') === '1') {
    const { releaseLauncherAltHoldNow } = await import('../ink/launcherAltHold.js')
    const nonTakeover =
      !process.stdout.isTTY ||
      runArgs.command === 'run' ||
      args.includes('-h') ||
      args.includes('--help') ||
      ['daemon', 'acp', 'runner', 'host', 'tune', 'extension-api'].includes(args[0] ?? '')
    if (nonTakeover) releaseLauncherAltHoldNow()
  }

  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  {
    const { armImagePack } = await import('../utils/imageProcessor/imagePackArm.js')
    armImagePack()
  }

  {
    const { registerBootDoors } = await import('../services/boot/registerDoors.js')
    registerBootDoors()
  }

  {
    const { setupGracefulShutdown, setRunPreflightSignalWriter } = await import('../utils/gracefulShutdown.js')
    setupGracefulShutdown()
    if (runArgs.command === 'run' && (runArgs.format === 'rows' || runArgs.format === 'json') && runArgs.input !== 'rows' && !runArgs.outputRequest) {
      const [{ refusedOutcome }, { writeSync }] = await Promise.all([import('../cli/headless/refusalEnvelope.js'), import('node:fs')])
      setRunPreflightSignalWriter(code => {
        const signal = code === 130 ? 'SIGINT' : code === 129 ? 'SIGHUP' : 'SIGTERM'
        writeSync(1, `${JSON.stringify(refusedOutcome([`mercury run stopped before the turn (${signal})`], 'interrupt', 'interrupted'))}\n`)
      })
    }
  }

  {
    const { fluxProbeEnabled } = await import('../utils/flux/fluxProbe.js')
    fluxProbeEnabled()
  }

  if (process.argv[2] === '--lsp-ts-sidecar') {
    profileCheckpoint('route_lsp_ts_sidecar')
    const { runLspSidecarEntry } = await import('../services/lsp/tsSidecar/entry.js')
    return runLspSidecarEntry()
  }
  if (process.argv[2] === '--lsp-web-sidecar') {
    profileCheckpoint('route_lsp_web_sidecar')
    const { runWebLspSidecarEntry } = await import('../services/lsp/webSidecar/entry.js')
    return runWebLspSidecarEntry()
  }
  if (process.argv[2] === '--mercury-host-job') {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { runHostJob } = await import('../services/host/worker.js')
    await tellTheBuiltInCommands()
    return runHostJob(process.argv[3] ?? '', process.argv[4] ?? '')
  }
  if (process.argv[2] === '--mercury-tcp-bridge') {
    profileCheckpoint('route_tcp_bridge')
    const { runTcpBridgeEntry } = await import('../services/tcpBridge/entry.js')
    return runTcpBridgeEntry(process.argv.slice(3))
  }
  if (args[0] === 'host') {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { hostCommand } = await import('../commands/host/index.js')
    await tellTheBuiltInCommands()
    featureReached('verb', 'host')
    process.exitCode = await hostCommand(args.slice(1))
    return
  }
  if (args[0] === 'daemon') {
    profileCheckpoint('route_daemon')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { daemonMain } = await import('../daemon/main.js')
    await tellTheBuiltInCommands()
    featureReached('verb', 'daemon')
    return daemonMain(args.slice(1))
  }
  if (args[0] === 'acp') {
    profileCheckpoint('route_acp')
    const extra = args.slice(1)
    const stray = extra.filter(option => option !== '--login')
    if (extra.length === 1 && stray.length === 0) {
      const { enableConfigs } = await import('../utils/config.js')
      enableConfigs()
      const { runAcpLoginScreen } = await import('../services/acp/acpLoginScreen.js')
      featureReached('verb', 'acp --login')
      return runAcpLoginScreen()
    }
    if (extra.length > 0) {
      const { writeSync } = await import('node:fs')
      const help = stray[0] === '-h' || stray[0] === '--help'
      try {
        writeSync(help ? 1 : 2, help ? 'Usage: mercury acp [--login]\n\nServe an editor over the Agent Client Protocol on stdio.\n  --login   Sign in from this terminal, then exit.\n' : `error: unknown option '${stray[0] ?? extra[0]}'\n`)
      } catch (error) {
        passedOver(error)
      }
      process.exit(help ? 0 : 2)
    }
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { runAcpServer } = await import('../services/acp/acpServer.js')
    await tellTheBuiltInCommands()
    featureReached('verb', 'acp')
    return runAcpServer()
  }

  if (
    !runArgs.runner &&
    readSessionOption(args, '--multiplex').present &&
    (readSessionOption(args, '-w').present || readSessionOption(args, '--worktree').present)
  ) {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { execIntoTmuxWorktree } = await import('../services/worktree.js')
    const outcome = await execIntoTmuxWorktree(args)
    if (outcome.handled) return
    if (outcome.error) {
      console.error(outcome.error)
      process.exit(1)
    }
  }

  if (readSessionOption(args, '--lean').present) {
    stampFlagEnv('MERCURY_BARE', '1')
  }

  {
    const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
    startCapturingEarlyInput()
  }
  profileCheckpoint('before_main_import')
  const cliMainModule = await import('../main.js')
  profileCheckpoint('after_main_import')
  await cliMainModule.main()
}

async function tellTheBuiltInCommands(): Promise<void> {
  const { builtInCommandNames } = await import('../commands.js')
  const { tellSessionStorageTheBuiltInCommands } = await import('../utils/sessionStorage/builtInCommands.js')
  tellSessionStorageTheBuiltInCommands(builtInCommandNames)
}

async function resolveCompileCacheHome(): Promise<string | null> {
  const { flagEnv } = await import('../substrate/flagRegistry.js')
  const env = hostEnv()
  const home = env.HOME || env.USERPROFILE || ''
  for (const candidate of [flagEnv('MERCURY_CONFIG_DIR', env), flagEnv('MERCURY_HOME', env)]) {
    if (candidate) return candidate
  }
  if (home === '') return null
  const { join } = await import('node:path')
  return join(home, '.mercury')
}

main().catch(async (error: unknown) => {
  try {
    const { inspectRunArgs } = await import('../cli/runArgs.js')
    const run = inspectRunArgs(process.argv.slice(2))
    if (run.command === 'run' && (run.format === 'rows' || run.format === 'json') && run.input !== 'rows' && !run.outputRequest) {
      const [{ refusedOutcome }, { writeSync }] = await Promise.all([import('../cli/headless/refusalEnvelope.js'), import('node:fs')])
      writeSync(1, `${JSON.stringify(refusedOutcome([error instanceof Error ? error.message : String(error)], 'internal', 'failed'))}\n`)
    }
  } catch (error) { passedOver(error) }
  try {
    const { failLoud } = await import('../utils/gracefulShutdown.js')
    failLoud(error, 'boot')
  } catch {
    process.stderr.write(
      `MERCURY COULD NOT START\ncause: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exit(1)
  }
})
