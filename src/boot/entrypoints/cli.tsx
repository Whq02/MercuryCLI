import { mkdirSync, writeSync } from 'node:fs'
import { constants, enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { featureReached } from '../../platform/substrate/featureReached.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { consoleNeedsUtf8Codepage } from '../../platform/host-os/terminal.js'
import { MISSING_CWD_LINE, cwdIsMissing, evaluateNodeRuntime, nodeRefusalMessage } from '../../platform/node-runtime/nodePolicy.js'
import type { inspectSessionArgs } from '../sessionArgs.js'

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
    const { compileCacheDirUsable } = await import('../../platform/node-runtime/compileCachePath.js')
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
  const { enableConfigs } = await import('../../platform/settings/config.js')
  enableConfigs()
}

async function tellTheBuiltInCommands(): Promise<void> {
  const { builtInCommandNames } = await import('../../commands/catalogue/commands.js')
  const { tellSessionStorageTheBuiltInCommands } = await import('../../sessions/transcripts/builtInCommands.js')
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
    const { runShellParentGuard } = await import('../../platform/shell/parentGuard.js')
    return runShellParentGuard()
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V' || args[0] === 'version')) {
    featureReached('verb', args[0] === 'version' ? 'version' : '--version')
    console.log(`Mercury ${MACRO.VERSION}`)
    return
  }
  if (args[0] === '--tensorfold-adapter') {
    const { runTensorFoldAdapter } = await import('../../models/tensorfold/adapter/main.js')
    const code = await runTensorFoldAdapter(args.slice(1))
    if (code !== 0) process.exitCode = code
    return
  }

  const { inspectSessionArgs, isInstallDryRunArgv, readSessionOption } = await import('../sessionArgs.js')
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
        const { refusedOutcome } = await import('../../daemon/runner/refusalEnvelope.js')
        writeSync(1, `${JSON.stringify(refusedOutcome([message], 'load'))}\n`)
      }
      process.exitCode = 1
      return
    }
    args = process.argv.slice(2)
  }
  if (cwdIsMissing()) {
    writeSync(2, `${MISSING_CWD_LINE}\n`)
    process.exitCode = 1
    return
  }

  const { flagEnv, stampFlagEnv } = await import('../../platform/substrate/flagRegistry.js')
  const env = hostEnv()
  const userHome = env.HOME || env.USERPROFILE
  const home = flagEnv('MERCURY_CONFIG_DIR', env) || flagEnv('MERCURY_HOME', env) || (userHome ? join(userHome, '.mercury') : null)
  const consoleWantsUtf8 = consoleNeedsUtf8Codepage() && flagEnv('MERCURY_WIN32_UTF8_PRESET', env) !== '1'
  if (args.length === 0 && process.stdout.isTTY && !projectGiven) {
    if (consoleWantsUtf8) {
      const { ensureWin32ConsoleUtf8 } = await import('../../platform/node-runtime/win32Console.js')
      ensureWin32ConsoleUtf8()
    }
    const { runDirectSplash } = await import('../../platform/substrate/directSplash.js')
    if (runDirectSplash({ home }).verdict === 'cancel') return
  }
  if (flagEnv('MERCURY_SPLASH_HANDOFF', env) === '1') {
    const { consumeSplashHandover } = await import('../../platform/substrate/splashHandover.js')
    consumeSplashHandover()
  }

  const { applyBankedFlagSpellings } = await import('../../platform/substrate/argvSpellings.js')
  applyBankedFlagSpellings(process.argv)
  if (underNode && home !== null && !isInstallDryRunArgv()) {
    await armCompileCache(home)
    if (env.NODE_DISABLE_COMPILE_CACHE === undefined) {
      void import('../../platform/node-runtime/compileCachePrune.js')
        .then(({ pruneCompileCache }) => pruneCompileCache(home))
        .catch(passedOver)
    }
  }
  if (consoleWantsUtf8 && process.stdout.isTTY) {
    const { ensureWin32ConsoleUtf8 } = await import('../../platform/node-runtime/win32Console.js')
    ensureWin32ConsoleUtf8()
  }
  const takesTheTerminalOver =
    process.stdout.isTTY &&
    invocation.command !== 'run' &&
    !args.includes('-h') &&
    !args.includes('--help') &&
    !['daemon', 'acp', 'runner', 'host', 'tune', 'extension-api'].includes(args[0])
  if (flagEnv('MERCURY_ALT_HELD') === '1' && !takesTheTerminalOver) {
    const { releaseLauncherAltHoldNow } = await import('../../screen/renderer/launcherAltHold.js')
    releaseLauncherAltHoldNow()
  }
  const { profileCheckpoint } = await import('../startupProfiler.js')
  profileCheckpoint('cli_entry')
  const { armImagePack } = await import('../../platform/images/imagePackArm.js')
  armImagePack()
  const { registerBootDoors } = await import('../doors/registerDoors.js')
  registerBootDoors()
  const { setRunPreflightSignalWriter, setupGracefulShutdown } = await import('../../platform/processes/gracefulShutdown.js')
  setupGracefulShutdown()
  if (answersInRows(invocation)) {
    const { refusedOutcome } = await import('../../daemon/runner/refusalEnvelope.js')
    setRunPreflightSignalWriter(code => {
      const signal = code === 130 ? 'SIGINT' : code === 129 ? 'SIGHUP' : 'SIGTERM'
      const outcome = refusedOutcome([`mercury run stopped before the turn (${signal})`], 'interrupt', 'interrupted')
      writeSync(1, `${JSON.stringify(outcome)}\n`)
    })
  }
  const { fluxProbeEnabled } = await import('../../integrations/media-flux/fluxProbe.js')
  fluxProbeEnabled()

  if (process.argv[2] === '--lsp-ts-sidecar') {
    profileCheckpoint('route_lsp_ts_sidecar')
    const { runLspSidecarEntry } = await import('../../integrations/lsp/ts-sidecar/entry.js')
    return runLspSidecarEntry()
  }
  if (process.argv[2] === '--lsp-web-sidecar') {
    profileCheckpoint('route_lsp_web_sidecar')
    const { runWebLspSidecarEntry } = await import('../../integrations/lsp/web-sidecar/entry.js')
    return runWebLspSidecarEntry()
  }
  if (process.argv[2] === '--mercury-host-job') {
    await configsOn()
    await tellTheBuiltInCommands()
    const { runHostJob } = await import('../../models/hosting/worker.js')
    return runHostJob(process.argv[3] ?? '', process.argv[4] ?? '')
  }
  if (process.argv[2] === '--mercury-tcp-bridge') {
    profileCheckpoint('route_tcp_bridge')
    const { runTcpBridgeEntry } = await import('../../daemon/tcp-bridge/entry.js')
    return runTcpBridgeEntry(process.argv.slice(3))
  }
  if (args[0] === 'host') {
    await configsOn()
    await tellTheBuiltInCommands()
    featureReached('verb', 'host')
    const { hostCommand } = await import('../../commands/host/index.js')
    process.exitCode = await hostCommand(args.slice(1))
    return
  }
  if (args[0] === 'daemon') {
    profileCheckpoint('route_daemon')
    const { daemonControlEnabled, parseDaemonVerb } = await import('../../daemon/control/verbs.js')
    if (parseDaemonVerb(args.slice(1)).kind === 'run' && daemonControlEnabled()) {
      const { getProcessStartInstantAsync, getProcessStartTokenAsync } = await import('../../daemon/control/ownerWatch.js')
      void getProcessStartTokenAsync(process.pid)
      void getProcessStartInstantAsync(process.pid)
    }
    await configsOn()
    await tellTheBuiltInCommands()
    featureReached('verb', 'daemon')
    const { daemonMain } = await import('../../daemon/control/main.js')
    return daemonMain(args.slice(1))
  }
  if (args[0] === 'acp') {
    profileCheckpoint('route_acp')
    const given = args.slice(1)
    if (given.length === 0) {
      await configsOn()
      await tellTheBuiltInCommands()
      featureReached('verb', 'acp')
      const { runAcpServer } = await import('../../integrations/acp/acpServer.js')
      return runAcpServer()
    }
    if (given.length === 1 && given[0] === '--login') {
      await configsOn()
      featureReached('verb', 'acp --login')
      const { runAcpLoginScreen } = await import('../../integrations/acp/acpLoginScreen.js')
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
    const { execIntoTmuxWorktree } = await import('../../platform/git/worktree/worktree.js')
    const outcome = await execIntoTmuxWorktree(args)
    if (outcome.handled) return
    if (outcome.error) {
      console.error(outcome.error)
      process.exit(1)
    }
  }
  if (readSessionOption(args, '--lean').present) stampFlagEnv('MERCURY_BARE', '1')
  const { startCapturingEarlyInput } = await import('../earlyInput.js')
  const settleDepth = startCapturingEarlyInput(invocation.command === undefined && !invocation.outputRequest)
  profileCheckpoint('before_main_import')
  const session = await import('../main.js')
  profileCheckpoint('after_main_import')
  await settleDepth()
  profileCheckpoint('terminal_depth_settled')
  await session.main()
}

async function startupFailed(error: unknown): Promise<void> {
  try {
    const { inspectRunArgs } = await import('../../daemon/runner/runArgs.js')
    if (answersInRows(inspectRunArgs(process.argv.slice(2)))) {
      const { refusedOutcome } = await import('../../daemon/runner/refusalEnvelope.js')
      const outcome = refusedOutcome([error instanceof Error ? error.message : String(error)], 'internal', 'failed')
      writeSync(1, `${JSON.stringify(outcome)}\n`)
    }
  } catch (failure) {
    passedOver(failure)
  }
  try {
    const { failLoud } = await import('../../platform/processes/gracefulShutdown.js')
    failLoud(error, 'boot')
  } catch (failure) {
    passedOver(failure)
    process.stderr.write(`MERCURY COULD NOT START\ncause: ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exit(1)
  }
}

await main().catch(startupFailed)
