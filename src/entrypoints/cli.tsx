import { mkdirSync, writeSync } from 'node:fs'
import { constants, enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { featureReached } from '../substrate/featureReached.js'
import { hostEnv } from '../utils/hostEnv.js'
import { passedOver } from '../utils/passedOver.js'
import { consoleNeedsUtf8Codepage } from '../utils/platform/terminal.js'
import { MISSING_CWD_LINE, cwdIsMissing, evaluateNodeRuntime, nodeRefusalMessage } from '../utils/runtime/nodePolicy.js'
import type { inspectSessionArgs } from '../utils/sessionArgs.js'

hostEnv().COREPACK_ENABLE_AUTO_PIN = '0'

type Invocation = ReturnType<typeof inspectSessionArgs>

function answersInRows(invocation: Invocation): boolean {
  return (
    invocation.command === 'run' &&
    (invocation.format === 'rows' || invocation.format === 'json') &&
    invocation.input !== 'rows' &&
    !invocation.outputRequest
  )
}

async function armCompileCache(home: string): Promise<void> {
  if (hostEnv().NODE_COMPILE_CACHE !== undefined || hostEnv().NODE_DISABLE_COMPILE_CACHE !== undefined) return
  try {
    const { compileCacheDirUsable } = await import('../utils/runtime/compileCachePath.js')
    const dir = join(home, 'compile-cache')
    if (!compileCacheDirUsable(dir)) return
    mkdirSync(dir, { recursive: true })
    const enabled = enableCompileCache(dir)
    if (enabled.status === constants.compileCacheStatus.ENABLED) hostEnv().NODE_COMPILE_CACHE = enabled.directory ?? dir
  } catch (error) {
    passedOver(error)
  }
}

async function configsOn(): Promise<void> {
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()
}

async function tellTheBuiltInCommands(): Promise<void> {
  const { builtInCommandNames } = await import('../commands.js')
  const { tellSessionStorageTheBuiltInCommands } = await import('../utils/sessionStorage/builtInCommands.js')
  tellSessionStorageTheBuiltInCommands(builtInCommandNames)
}

function refuseAcpArguments(given: string[]): never {
  const named = given.find(argument => argument !== '--login') ?? '--login'
  const help = named === '-h' || named === '--help'
  try {
    if (help) writeSync(1, 'Usage: mercury acp [--login]\n\nServe an editor over the Agent Client Protocol on stdio.\n  --login   Sign in from this terminal, then exit.\n')
    else writeSync(2, `error: unknown option '${named}'\n`)
  } catch (error) {
    passedOver(error)
  }
  process.exit(help ? 0 : 2)
}

async function main(): Promise<void> {
  const underNode = process.versions.bun === undefined
  if (underNode) {
    const decision = evaluateNodeRuntime(process.versions.node)
    if (decision.verdict !== 'supported') {
      console.error(nodeRefusalMessage(decision))
      process.exit(1)
    }
  }
  let args = process.argv.slice(2)
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

  const { inspectSessionArgs, readSessionOption } = await import('../utils/sessionArgs.js')
  const invocation = inspectSessionArgs(args)
  const projectGiven = args[0] === '--project' || args[0]?.startsWith('--project=') === true
  if (projectGiven) {
    try {
      const { applyProjectRoot } = await import('./projectRoot.js')
      applyProjectRoot(process.argv)
    } catch (error) {
      const message = `Project root: ${error instanceof Error ? error.message : String(error)}`
      console.error(message)
      if (invocation.command === 'run' && (invocation.format === 'rows' || invocation.format === 'json')) {
        const { refusedOutcome } = await import('../cli/headless/refusalEnvelope.js')
        writeSync(1, `${JSON.stringify(refusedOutcome([message], 'load'))}\n`)
      }
      process.exitCode = 1
      return
    }
    args = process.argv.slice(2)
  }
  if (cwdIsMissing()) {
    process.stderr.write(`${MISSING_CWD_LINE}\n`)
    process.exitCode = 1
    return
  }

  const { flagEnv, stampFlagEnv } = await import('../substrate/flagRegistry.js')
  const userHome = hostEnv().HOME || hostEnv().USERPROFILE
  const home = flagEnv('MERCURY_CONFIG_DIR') || flagEnv('MERCURY_HOME') || (userHome ? join(userHome, '.mercury') : null)
  const consoleWantsUtf8 = consoleNeedsUtf8Codepage() && flagEnv('MERCURY_WIN32_UTF8_PRESET') !== '1'
  if (args.length === 0 && process.stdout.isTTY && !projectGiven) {
    if (consoleWantsUtf8) {
      const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
      ensureWin32ConsoleUtf8()
    }
    const { runDirectSplash } = await import('../substrate/directSplash.js')
    if (runDirectSplash({ home }).verdict === 'cancel') return
  }
  if (flagEnv('MERCURY_SPLASH_HANDOFF') === '1') {
    const { consumeSplashHandover } = await import('../substrate/splashHandover.js')
    consumeSplashHandover()
  }

  const { applyBankedFlagSpellings } = await import('../substrate/argvSpellings.js')
  applyBankedFlagSpellings(process.argv)
  args = process.argv.slice(2)
  if (underNode && home !== null) {
    await armCompileCache(home)
    if (hostEnv().NODE_DISABLE_COMPILE_CACHE === undefined) {
      const { pruneCompileCache } = await import('../utils/runtime/compileCachePrune.js')
      void pruneCompileCache(home).catch(passedOver)
    }
  }
  if (consoleWantsUtf8 && process.stdout.isTTY) {
    const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
    ensureWin32ConsoleUtf8()
  }
  const takesTheTerminalOver =
    process.stdout.isTTY &&
    invocation.command !== 'run' &&
    !args.includes('-h') &&
    !args.includes('--help') &&
    !['daemon', 'acp', 'runner', 'host', 'tune', 'extension-api'].includes(args[0])
  if (flagEnv('MERCURY_ALT_HELD') === '1' && !takesTheTerminalOver) {
    const { releaseLauncherAltHoldNow } = await import('../ink/launcherAltHold.js')
    releaseLauncherAltHoldNow()
  }
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')
  const { armImagePack } = await import('../utils/imageProcessor/imagePackArm.js')
  armImagePack()
  const { registerBootDoors } = await import('../services/boot/registerDoors.js')
  registerBootDoors()
  const { setRunPreflightSignalWriter, setupGracefulShutdown } = await import('../utils/gracefulShutdown.js')
  setupGracefulShutdown()
  if (answersInRows(invocation)) {
    const { refusedOutcome } = await import('../cli/headless/refusalEnvelope.js')
    setRunPreflightSignalWriter(code => {
      const signal = code === 130 ? 'SIGINT' : code === 129 ? 'SIGHUP' : 'SIGTERM'
      const outcome = refusedOutcome([`mercury run stopped before the turn (${signal})`], 'interrupt', 'interrupted')
      writeSync(1, `${JSON.stringify(outcome)}\n`)
    })
  }
  const { fluxProbeEnabled } = await import('../utils/flux/fluxProbe.js')
  fluxProbeEnabled()

  if (args[0] === '--lsp-ts-sidecar') {
    profileCheckpoint('route_lsp_ts_sidecar')
    const { runLspSidecarEntry } = await import('../services/lsp/tsSidecar/entry.js')
    return runLspSidecarEntry()
  }
  if (args[0] === '--lsp-web-sidecar') {
    profileCheckpoint('route_lsp_web_sidecar')
    const { runWebLspSidecarEntry } = await import('../services/lsp/webSidecar/entry.js')
    return runWebLspSidecarEntry()
  }
  if (args[0] === '--mercury-host-job') {
    await configsOn()
    await tellTheBuiltInCommands()
    const { runHostJob } = await import('../services/host/worker.js')
    return runHostJob(args[1] ?? '', args[2] ?? '')
  }
  if (args[0] === '--mercury-tcp-bridge') {
    profileCheckpoint('route_tcp_bridge')
    const { runTcpBridgeEntry } = await import('../services/tcpBridge/entry.js')
    return runTcpBridgeEntry(args.slice(1))
  }
  if (args[0] === 'host') {
    await configsOn()
    await tellTheBuiltInCommands()
    featureReached('verb', 'host')
    const { hostCommand } = await import('../commands/host/index.js')
    process.exitCode = await hostCommand(args.slice(1))
    return
  }
  if (args[0] === 'daemon') {
    profileCheckpoint('route_daemon')
    await configsOn()
    await tellTheBuiltInCommands()
    featureReached('verb', 'daemon')
    const { daemonMain } = await import('../daemon/main.js')
    return daemonMain(args.slice(1))
  }
  if (args[0] === 'acp') {
    profileCheckpoint('route_acp')
    const given = args.slice(1)
    if (given.length === 0) {
      await configsOn()
      await tellTheBuiltInCommands()
      featureReached('verb', 'acp')
      const { runAcpServer } = await import('../services/acp/acpServer.js')
      return runAcpServer()
    }
    if (given.length === 1 && given[0] === '--login') {
      await configsOn()
      featureReached('verb', 'acp --login')
      const { runAcpLoginScreen } = await import('../services/acp/acpLoginScreen.js')
      return runAcpLoginScreen()
    }
    refuseAcpArguments(given)
  }

  const multiplexedWorktree =
    !invocation.runner &&
    readSessionOption(args, '--multiplex').present &&
    (readSessionOption(args, '-w').present || readSessionOption(args, '--worktree').present)
  if (multiplexedWorktree) {
    await configsOn()
    const { execIntoTmuxWorktree } = await import('../services/worktree.js')
    const outcome = await execIntoTmuxWorktree(args)
    if (outcome.handled) return
    if (outcome.error) {
      console.error(outcome.error)
      process.exit(1)
    }
  }
  if (readSessionOption(args, '--lean').present) stampFlagEnv('MERCURY_BARE', '1')
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
  startCapturingEarlyInput()
  profileCheckpoint('before_main_import')
  const session = await import('../main.js')
  profileCheckpoint('after_main_import')
  await session.main()
}

async function startupFailed(error: unknown): Promise<void> {
  try {
    const { inspectRunArgs } = await import('../cli/runArgs.js')
    if (answersInRows(inspectRunArgs(process.argv.slice(2)))) {
      const { refusedOutcome } = await import('../cli/headless/refusalEnvelope.js')
      const outcome = refusedOutcome([error instanceof Error ? error.message : String(error)], 'internal', 'failed')
      writeSync(1, `${JSON.stringify(outcome)}\n`)
    }
  } catch (failure) {
    passedOver(failure)
  }
  try {
    const { failLoud } = await import('../utils/gracefulShutdown.js')
    failLoud(error, 'boot')
  } catch (failure) {
    passedOver(failure)
    console.error(`MERCURY COULD NOT START\ncause: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  }
}

await main().catch(startupFailed)
