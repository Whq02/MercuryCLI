import {
  evaluateNodeRuntime,
  nodeRefusalMessage,
} from '../utils/runtime/nodePolicy.js'

process.env.COREPACK_ENABLE_AUTO_PIN = '0'

const DEAD_SUBCOMMANDS = new Set([
  'ps',
  'logs',
  'attach',
  'kill',
  'new',
  'list',
  'reply',
  'remote-control',
  'rc',
  'remote',
  'sync',
  'bridge',
  'environment-runner',
  'self-hosted-runner',
])

async function main(): Promise<void> {
  if (!process.versions?.bun) {
    const nodeDecision = evaluateNodeRuntime(process.versions?.node)
    if (nodeDecision.verdict !== 'supported') {
      console.error(nodeRefusalMessage(nodeDecision));
      process.exit(1)
    }
  }

  const args = process.argv.slice(2)

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`Mercury ${MACRO.VERSION}`)
    return
  }

  if (args.length === 0 && process.stdout.isTTY) {
    if (
      process.platform === 'win32' &&
      process.env.MERCURY_WIN32_UTF8 !== '0' &&
      process.env.MERCURY_WIN32_UTF8_PRESET !== '1'
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

  if (process.env.MERCURY_SPLASH_HANDOFF === '1') {
    const { consumeSplashHandover } = await import('../substrate/splashHandover.js')
    consumeSplashHandover()
  }

  {
    const { applyBankedFlagSpellings, DEBUG_FLAG_SPELLINGS } = await import('../substrate/argvSpellings.js')
    applyBankedFlagSpellings(process.argv)
    applyBankedFlagSpellings(process.argv, DEBUG_FLAG_SPELLINGS)
  }

  try {
    if (
      process.env.NODE_COMPILE_CACHE === undefined &&
      process.env.NODE_DISABLE_COMPILE_CACHE === undefined &&
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
            process.env.NODE_COMPILE_CACHE = enabled.directory ?? cacheDir
          }
        }
      }
    }
  } catch {
  }

  if (
    process.platform === 'win32' &&
    process.stdout.isTTY &&
    process.env.MERCURY_WIN32_UTF8 !== '0' &&
    process.env.MERCURY_WIN32_UTF8_PRESET !== '1'
  ) {
    const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
    ensureWin32ConsoleUtf8()
  }

  if (process.env.MERCURY_ALT_HELD === '1') {
    const nonTakeover =
      !process.stdout.isTTY ||
      args.includes('-p') ||
      args.includes('--print') ||
      args.includes('-h') ||
      args.includes('--help') ||
      ['daemon', 'join', 'join-kit', 'acp'].includes(args[0] ?? '')
    if (nonTakeover) {
      const { releaseLauncherAltHoldNow } = await import('../ink/launcherAltHold.js')
      releaseLauncherAltHoldNow()
    }
  }

  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  {
    const { setupGracefulShutdown } = await import('../utils/gracefulShutdown.js')
    setupGracefulShutdown()
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
  if (process.argv[2] === '--mercury-tcp-bridge') {
    profileCheckpoint('route_tcp_bridge')
    const { runTcpBridgeEntry } = await import('../services/tcpBridge/entry.js')
    return runTcpBridgeEntry(process.argv.slice(3))
  }
  if (args[0] === 'daemon') {
    profileCheckpoint('route_daemon')
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { daemonMain } = await import('../daemon/main.js')
    return daemonMain(args.slice(1))
  }
  if (args[0] === 'join' || args[0] === 'join-kit') {
    profileCheckpoint('route_retired_verb')
    const [{ writeSync }, { RETIRED_MULTIPLAYER_REASON }] = await Promise.all([
      import('node:fs'),
      import('../commands/retired.js'),
    ])
    try {
      writeSync(2, `mercury ${args[0]} is retired — ${RETIRED_MULTIPLAYER_REASON}.\n`)
    } catch {
    }
    process.exit(2)
  }
  if (args[0] === 'acp') {
    profileCheckpoint('route_acp')
    if (!args.includes('--stdio')) {
      const { writeSync } = await import('node:fs')
      try {
        writeSync(2, 'Usage: mercury acp --stdio\n')
      } catch {
      }
      process.exit(2)
    }
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { runAcpServer } = await import('../services/acp/acpServer.js')
    return runAcpServer()
  }

  if (
    (args.includes('--tmux') || args.includes('--tmux=classic')) &&
    (args.includes('-w') ||
      args.includes('--worktree') ||
      args.some(arg => arg.startsWith('--worktree=')))
  ) {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { execIntoTmuxWorktree } = await import('../utils/worktree.js')
    const outcome = await execIntoTmuxWorktree(args)
    if (outcome.handled) return
    if (outcome.error) {
      console.error(outcome.error)
      process.exit(1)
    }
  }

  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [...process.argv.slice(0, 2), 'update']
  }

  if (args.length > 0 && DEAD_SUBCOMMANDS.has(args[0]!)) {
    const [{ binaryName }, { releaseLauncherAltHoldNow }, { writeSync }] = await Promise.all([
      import('../utils/config.js'),
      import('../ink/launcherAltHold.js'),
      import('node:fs'),
    ])
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, `'${args[0]}' is not available in this build. Run ${binaryName()} --help for the available commands.\n`)
    } catch {
    }
    process.exit(1)
  }

  if (args.includes('--bare')) {
    process.env.MERCURY_SIMPLE = '1'
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

async function resolveCompileCacheHome(): Promise<string | null> {
  const env = process.env
  const home = env.HOME || env.USERPROFILE || ''
  for (const candidate of [env.MERCURY_CONFIG_DIR, env.MERCURY_HOME]) {
    if (candidate) return candidate
  }
  if (home === '') return null
  const { join } = await import('node:path')
  return join(home, '.mercury')
}

main().catch(async (error: unknown) => {
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
