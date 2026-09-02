// ============================================================================
//  src/entrypoints/cli.tsx — the bundle's single entrypoint: the stage-1
//  bootstrap router. Discipline: EVERY import except one is dynamic, so a
//  fast path evaluates the minimum number of modules. The one static import
//  is the zero-import, side-effect-free Node support policy.
// ============================================================================
import {
  evaluateNodeRuntime,
  nodeRefusalMessage,
} from '../utils/runtime/nodePolicy.js'

// Workaround: corepack adds a package-manager pin to user package files.
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

/** Retired subcommand words (contract data): matched against the FIRST
 *  argument only — without this guard a retired word parses as a one-word
 *  prompt and silently launches the REPL. `daemon` is deliberately absent. */
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
  // 1 — the runtime gate. Bun is exempt BY NAME: it is the build and
  // verification runtime, and its node-compat shim version is not the
  // product's runtime claim. This is the single owner of the floor.
  if (!process.versions?.bun) {
    const nodeDecision = evaluateNodeRuntime(process.versions?.node)
    if (nodeDecision.verdict !== 'supported') {
      console.error(nodeRefusalMessage(nodeDecision));
      process.exit(1)
    }
  }

  // 2 — the argv snapshot, taken BEFORE any later splicing: fast-path
  // routing reads the operator's original argv; the argument parser and the
  // REPL read the spliced array.
  const args = process.argv.slice(2)

  // 3 — zero-import --version: the banner is duplicated inline rather than
  // imported, specifically to preserve the zero-import guarantee.
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`Mercury ${MACRO.VERSION}`)
    return
  }

  // 4 — splash handover: validates the JSON receipt the splash wrote and
  // applies the operator's choice (cd + argv splice). Ordering: the version
  // fast path has already answered by now (flag boots never arm the splash
  // env), and everything that routes or reads cwd runs after this point.
  if (process.env.MERCURY_SPLASH_HANDOFF === '1') {
    const { consumeSplashHandover } = await import('../substrate/splashHandover.js')
    consumeSplashHandover()
  }

  // 4b — the banked single-dash spellings (`-chat` · `-concourse-off` ·
  // `-concourse-on`) take their estate `--` form here, before commander and
  // before anything reads argv (a single dash would otherwise combine into
  // short switches: `-chat` = -c -h -a -t).
  {
    const { applyBankedFlagSpellings, DEBUG_FLAG_SPELLINGS } = await import('../substrate/argvSpellings.js')
    applyBankedFlagSpellings(process.argv)
    // 4c — the operator's short debug flag `-d2e` admits the same way, as
    // its canonical `--d2e` (commander ≥13 refuses a multi-character short
    // flag in the option table; the flag the operator types keeps parsing).
    applyBankedFlagSpellings(process.argv, DEBUG_FLAG_SPELLINGS)
  }

  // 5 — the V8 compile cache: a lever, never a boot dependency (Node
  // silently no-ops on unwritable directories). The launchers set the env
  // themselves — only that can cache the main bundle's own parse; this arm
  // covers env-less boots and everything loaded after this point.
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
        // A long Windows home is the one directory Node does NOT no-op on:
        // past the path bound the cache machinery spun at 100% and the
        // product never started (TASK-014 w1-f15-01). Skip the lever.
        const { compileCacheDirUsable } = await import('../utils/runtime/compileCachePath.js')
        if (compileCacheDirUsable(cacheDir)) {
          // Existence probe (FC-012): a config home on an UNAVAILABLE volume
          // (Q:\ never mounted) is the second directory Node does not no-op
          // on — the cache machinery spun one core forever and the product
          // never started. A cache dir that cannot be created right now is
          // the lever skipped (the mkdir throw lands in this arm's catch),
          // never the boot risked.
          const { mkdirSync } = await import('node:fs')
          mkdirSync(cacheDir, { recursive: true })
          const { enableCompileCache, constants: moduleConstants } = await import('node:module')
          const enabled = enableCompileCache(cacheDir)
          // FN-020 row 6: the runtime enables the cache for THIS process
          // only — enableCompileCache reads NODE_COMPILE_CACHE and never
          // sets it (node v24.20.0, read at the source) — so every child of
          // an env-less boot (the owned daemon and every runner it spawns
          // for its detached lifetime, both LSP sidecars) re-parsed the
          // whole bundle uncached. The directory the enable actually took
          // is exported so children inherit the same cache; the guards
          // above keep an operator's own setting and the disable switch in
          // charge.
          if (enabled.status === moduleConstants.compileCacheStatus.ENABLED) {
            process.env.NODE_COMPILE_CACHE = enabled.directory ?? cacheDir
          }
        }
      }
    }
  } catch {
    // Never a boot dependency.
  }

  // 6 — Windows console UTF-8, before any frame bytes. The outer guard
  // keeps non-Windows and non-TTY boots at zero work and zero module load;
  // the preset env lets a launcher that already set the codepage skip both.
  if (
    process.platform === 'win32' &&
    process.stdout.isTTY &&
    process.env.MERCURY_WIN32_UTF8 !== '0' &&
    process.env.MERCURY_WIN32_UTF8_PRESET !== '1'
  ) {
    const { ensureWin32ConsoleUtf8 } = await import('../utils/runtime/win32Console.js')
    ensureWin32ConsoleUtf8()
  }

  // 7 — launcher alternate-buffer release, forced early so its exit-release
  // net covers pre-REPL exits (flag typos, headless runs under the
  // launcher, quitting a setup screen) that would otherwise strand the
  // terminal on the splash frame. Non-takeover: no TTY, -p/--print/-h/
  // --help, or a non-screen first subcommand. A positional prompt IS a
  // takeover.
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

  // 8 — the startup profiler.
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  // 9 — crash handlers (uncaught exception, unhandled rejection, the
  // interrupt/terminate/hangup signals) before any fast path does async
  // work; memoized, so the later call inside init() coalesces. After the
  // version return, preserving that path's guarantee.
  {
    const { setupGracefulShutdown } = await import('../utils/gracefulShutdown.js')
    setupGracefulShutdown()
  }

  // 10 — latch the probe ring (and arm its shutdown tee) at boot: headless
  // paths may never reach a probe site, and the tee must be armed before
  // any exit path can fire. No-op when its env is unset.
  {
    const { fluxProbeEnabled } = await import('../utils/flux/fluxProbe.js')
    fluxProbeEnabled()
  }

  // 11 — fast-path subcommands. The three sidecar routes key on the RAW
  // argv third element; every remaining route keys on the pre-splice
  // snapshot. A sidecar must never touch the renderer or configs.
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
    // The old multiplayer's guest verbs are RETIRED doors: the names stay
    // recognized here so a typed verb answers its reason (never an unknown
    // verb), before auth and onboarding exactly where they used to run.
    // Dynamic on purpose (the entry stays statically light); writeSync
    // because a win32 TTY stream write is async and the exit can discard it.
    profileCheckpoint('route_retired_verb')
    const [{ writeSync }, { RETIRED_MULTIPLAYER_REASON }] = await Promise.all([
      import('node:fs'),
      import('../commands/retired.js'),
    ])
    try {
      writeSync(2, `mercury ${args[0]} is retired — ${RETIRED_MULTIPLAYER_REASON}.\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(2)
  }
  if (args[0] === 'acp') {
    profileCheckpoint('route_acp')
    if (!args.includes('--stdio')) {
      // Dynamic on purpose: this entry stays statically light (the boot
      // contract pins its one static value import); writeSync because a
      // win32 TTY stream write is async and the exit can discard it.
      const { writeSync } = await import('node:fs')
      try {
        writeSync(2, 'Usage: mercury acp --stdio\n')
      } catch {
        /* a closed fd must not mask the exit */
      }
      process.exit(2)
    }
    // Config reads THROW until enabled (getConfig's boot guard); the sibling
    // sidecar routes (daemon, join) enable first — the acp route missed it,
    // so any config-reading handler (session/list, the _mercury surfaces)
    // would die mid-protocol (LANE ACP quick-win).
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { runAcpServer } = await import('../services/acp/acpServer.js')
    return runAcpServer()
  }

  // 12 — the tmux worktree fast path.
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
    // Fall through to the normal CLI.
  }

  // 13 — a lone --update/--upgrade rewrites to the update subcommand form.
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [...process.argv.slice(0, 2), 'update']
  }

  // 14 — the dead-subcommand guard (config imported only on a match, so an
  // ordinary boot never evaluates the config graph here).
  if (args.length > 0 && DEAD_SUBCOMMANDS.has(args[0]!)) {
    // The refusal must REACH the terminal: under a launcher alternate-screen
    // hold it painted into a buffer discarded at exit, so the verb exited 1
    // with no output at all. Release the hold first, then writeSync — a
    // win32 TTY stream write is async and the exit can discard it.
    const [{ binaryName }, { releaseLauncherAltHoldNow }, { writeSync }] = await Promise.all([
      import('../utils/config.js'),
      import('../ink/launcherAltHold.js'),
      import('node:fs'),
    ])
    releaseLauncherAltHoldNow()
    try {
      writeSync(2, `'${args[0]}' is not available in this build. Run ${binaryName()} --help for the available commands.\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(1)
  }

  // 15 — bare mode, set EARLY so gates fire during module evaluation and
  // option construction, not only inside the action handler.
  if (args.includes('--bare')) {
    process.env.MERCURY_SIMPLE = '1'
  }

  // 16 — capture early keyboard input, then the full CLI.
  {
    const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
    startCapturingEarlyInput()
  }
  profileCheckpoint('before_main_import')
  const cliMainModule = await import('../main.js')
  profileCheckpoint('after_main_import')
  await cliMainModule.main()
}

/** The compile-cache home resolution — an inline duplicate of the one home
 *  resolver, kept inline for the zero-import guarantee; it must stay in
 *  lockstep with the resolver. First non-empty wins. */
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

// Invoked at module scope. The promise is not left dangling: a rejection
// that escapes main() — a module the artifact cannot load, a throwing boot
// seam inside the commander preAction hook — has nothing above it but the
// process-level rejection listener, which only logs, and the ref'd raw-mode
// stdin then keeps the process alive with no frame ever painted (the
// deployed-runtime hang). The catch is the loud exit: restored
// terminal, the card, exit 1.
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
