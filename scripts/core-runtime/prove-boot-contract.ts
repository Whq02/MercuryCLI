#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-boot-contract.ts —
//  launch-graph boot contract (the characterization laws
//  implementation-blind,
//  green on the OLD bodies first. Cold-boot WALL-CLOCK receipts stay with
//  bench-baseline.ts — this prover pins what an IN-PROCESS harness can pin:
//
//    • PROFILER-CHECKPOINT — the startupProfiler recording laws: env-latched
//      detailed mode, call-order preservation, duplicate names allowed (the
//      memory-snapshot ordering rationale, startupProfiler.ts:39-46),
//      monotonic mark times, the report file path/shape bench tooling reads,
//      the once-only report latch.
//    • PHASE-NAMES — the cross-file contract between PHASE_DEFINITIONS
//      (startupProfiler.ts:49-54) and the checkpoints the entry chain
//      actually emits (cli.tsx / main.tsx / entrypoints/init.ts).
//    • PAINT-ENTRY-DYNAMIC + EAGER-FRONT — the import-graph structure truth:
//      cli.tsx (the process entry) has ZERO static imports — no heavy module
//      is statically reachable from it; main.tsx is TODAY'S eager front (154
//      static value imports incl. tools/commands/MCP/extensions/skills), pinned
//      exactly so every deferral flips a law consciously; the App/REPL
//      paint surface is reached ONLY via replLauncher's dynamic imports.
//    • EARLY-SEAM ORDER — boot-env → private-home → auth-scope →
//      launcher-notes → run(), and the deliberate prefetch-early ordering
//      (main_tsx_entry → startMdmRawRead → startKeychainPrefetch → imports
//      loaded). This order was UNPINNED — pinned here.
//    • MCP-NEVER-GATES-RENDER — no awaited connectMcpBatch precedes the one
//      interactive launchRepl site; the REPL's connection registry is the
//      interactive MCP owner (seeded with --mcp-config + the strict flag),
//      and the print path alone keeps its inline connect.
//    • RESUME-IDENTITY — the --resume <uuid> / title-match branches hand the
//      resolved session id through as sessionIdOverride, and the restore owner
//      adopts it first (a full log has no top-level sessionId).
//    • BOOT-ENV APPLIER — applyBootMenuEnv via its injected path+env params:
//      no-file/flag-off byte-identical null, anti-smuggling refusals, value
//      validation, explicit-env-wins, applied-keys attribution, the
//      writeBootEnvChoice round-trip.
//    • EARLY-INPUT — the exported capture seam: non-TTY no-op (print-mode
//      safety), seed→consume trim round-trip, one-shot consume.
//    • LAUNCH-REPL — launchRepl via its injected renderAndRun: renders
//      exactly once with App-wrapping-REPL, forwards appProps/replProps/root
//      untouched on a hermetic (empty) home, never fabricates a teamContext,
//      preserves a pre-set one.
//    • RECOVERY-BUDGET (structural) — BOOT_RECOVERY_BUDGET_MS=3000 + the
//      Promise.race + render-anyway catch + the never-override projection
//      guard. (Driving a HUNG recovery needs the disk fault seam — the
//      behavioral leg lands with the cut; the wedged-disk
//      render-anyway path is NOT exercised here.)
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-boot-contract.ts
// ============================================================================
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── hermetic env, latched BEFORE any src import (all src imports below are
//    dynamic so these latches win the module-load races) ─────────────────────
const HERMETIC = mkdtempSync(join(tmpdir(), 'native-core-boot-'))
process.env.MERCURY_PROFILE_STARTUP = '1'
process.env.MERCURY_CONFIG_DIR = join(HERMETIC, 'config')
process.env.MERCURY_DAEMON_DIR = join(HERMETIC, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HERMETIC, 'teams')
for (const k of ['MERCURY_HOME', 'MERCURY_ENTER_MENU', 'MERCURY_THEMIS']) {
  delete process.env[k]
}
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

const SRC = join(import.meta.dir, '..', '..', 'src')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('native-core T15 — launch-graph boot contract')

// ── LAW PROFILER-CHECKPOINT (in-process, env latched above) ─────────────────
{
  const p = await import('../../src/utils/startupProfiler.js')
  const { getPerformance } = await import('../../src/utils/profilerBase.js')

  p.profileCheckpoint('t15_probe_a')
  p.profileCheckpoint('t15_probe_b')
  p.profileCheckpoint('t15_probe_a') // duplicates are ALLOWED (some fire twice)

  const names = getPerformance()
    .getEntriesByType('mark')
    .map(m => m.name)
  check(
    'profiler: module-load checkpoint recorded first',
    names[0] === 'profiler_initialized',
    names[0] ?? '(none)',
  )
  const ia = names.indexOf('t15_probe_a')
  const ib = names.indexOf('t15_probe_b')
  const ia2 = names.lastIndexOf('t15_probe_a')
  check('profiler: call order preserved', ia >= 0 && ib > ia, `${ia},${ib}`)
  check('profiler: duplicate names both recorded', ia2 > ib, `${ia2}`)
  const marks = getPerformance().getEntriesByType('mark')
  check(
    'profiler: mark times monotonic non-decreasing',
    marks.every((m, i) => i === 0 || m.startTime >= marks[i - 1]!.startTime),
  )
  check('profiler: detailed mode latched from env', p.isDetailedProfilingEnabled())

  const logPath = p.getStartupPerfLogPath()
  check(
    'profiler: log path under the pinned config home',
    logPath.startsWith(process.env.MERCURY_CONFIG_DIR!),
    logPath,
  )
  check(
    'profiler: log path shape startup-perf/<sessionId>.txt',
    /startup-perf[/\\][0-9a-f-]{36}\.txt$/.test(logPath),
    logPath,
  )

  p.profileReport()
  check('profiler: report file written', existsSync(logPath))
  const report = readFileSync(logPath, 'utf8')
  check(
    'profiler: report carries the banner',
    report.includes('STARTUP PROFILING REPORT'),
  )
  check(
    'profiler: report lists checkpoints in mark order',
    report.indexOf('profiler_initialized') >= 0 &&
      report.indexOf('t15_probe_a') > report.indexOf('profiler_initialized') &&
      report.indexOf('t15_probe_a') !== -1 && report.indexOf('t15_probe_b') > report.indexOf('t15_probe_a'),
  )
  rmSync(logPath)
  p.profileReport() // once-latch: reported=true — must NOT rewrite
  check('profiler: report is once-only (latched)', !existsSync(logPath))
}

// ── LAW PHASE-NAMES (cross-file text contract) ──────────────────────────────
{
  const profilerSrc = readFileSync(join(SRC, 'utils/startupProfiler.ts'), 'utf8')
  const phaseBlock = /PHASE_DEFINITIONS = \{[\s\S]*?\} as const/.exec(profilerSrc)?.[0] ?? ''
  const phases: Array<[string, string, string]> = [
    ['import_time', 'cli_entry', 'main_tsx_imports_loaded'],
    ['init_time', 'init_function_start', 'init_function_end'],
    ['settings_time', 'eagerLoadSettings_start', 'eagerLoadSettings_end'],
    ['total_time', 'cli_entry', 'main_after_run'],
  ]
  for (const [phase, start, end] of phases) {
    check(
      `phase-names: ${phase} = [${start}, ${end}]`,
      phaseBlock.includes(`${phase}: ['${start}', '${end}']`),
    )
  }
  const cliSrc = readFileSync(join(SRC, 'entrypoints/cli.tsx'), 'utf8')
  const mainSrc = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const initSrc = readFileSync(join(SRC, 'entrypoints/init.ts'), 'utf8')
  const emitters: Array<[string, string]> = [
    ['cli_entry', cliSrc],
    ['main_tsx_entry', mainSrc],
    ['main_tsx_imports_loaded', mainSrc],
    ['main_function_start', mainSrc],
    ['main_before_run', mainSrc],
    ['main_after_run', mainSrc],
    ['eagerLoadSettings_start', mainSrc],
    ['eagerLoadSettings_end', mainSrc],
    ['init_function_start', initSrc],
    ['init_function_end', initSrc],
  ]
  for (const [name, src] of emitters) {
    check(
      `phase-names: emitter profileCheckpoint('${name}') exists`,
      src.includes(`profileCheckpoint('${name}')`),
    )
  }
}

// ── the static-import scanner (value vs type-only vs bare side-effect) ──────
function staticImports(src: string): {
  value: string[]
  typeOnly: string[]
  bare: string[]
} {
  const value: string[] = []
  const typeOnly: string[] = []
  const bare: string[] = []
  const fromRe = /(?:^|\n)(import\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"])/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(src))) {
    if (/^import\s+type\s/.test(m[1]!)) typeOnly.push(m[2]!)
    else value.push(m[2]!)
  }
  const bareRe = /(?:^|\n)import\s*['"]([^'"]+)['"]/g
  while ((m = bareRe.exec(src))) bare.push(m[1]!)
  return { value, typeOnly, bare }
}

// ── LAW PAINT-ENTRY-DYNAMIC + the EAGER-FRONT characterization ──────────────
{
  const cliSrc = readFileSync(join(SRC, 'entrypoints/cli.tsx'), 'utf8')
  const cli = staticImports(cliSrc)
  // ONE sanctioned static value import: the Node
  // runtime gate must fire before any dispatch, so cli.tsx imports the
  // zero-import, side-effect-free policy owner statically. Anything beyond
  // that singleton still fails the law.
  check(
    'entry: cli.tsx static value imports = the nodePolicy singleton (fully dynamic otherwise)',
    cli.value.length === 1 && cli.value[0] === '../utils/runtime/nodePolicy.js',
    JSON.stringify(cli.value),
  )
  check('entry: cli.tsx has ZERO bare side-effect imports', cli.bare.length === 0)
  const dynCount = (cliSrc.match(/await import\(/g) ?? []).length
  check('entry: cli.tsx routes every path via dynamic import (≥15 sites)', dynCount >= 15, String(dynCount))
  check(
    'entry: --version fast-path answers before the first dynamic import',
    cliSrc.indexOf('MACRO.VERSION') > 0 &&
      cliSrc.indexOf('MACRO.VERSION') < cliSrc.indexOf('await import('),
  )

  const mainSrc = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const main = staticImports(mainSrc)
  // THE EAGER FRONT — pinned exactly so every change is a conscious act.
  // 154 → 155 (cut): main.tsx's raw foreign USE_* boot prefetch
  // gates moved behind utils/model/providers.js — a module already in
  // main's transitive boot graph (zero added eager evaluation weight).
  // +1 (S2): the launch-graph owner itself (./boot/launchGraph.js —
  // featherweight, imports only utils/debug.js, long since eager). The S2
  // win is SCHEDULING (the background-discovery class + the
  // mcpConfigPromise await leaving the render path), not import slimming.
  // +1 (S2): the instruction-walk owner (getInstructionFiles — already
  // eager via interactiveHelpers; imported for the trusted-boot walk WARM
  // that overlaps setup(); since facade fold the import is
  // services/instructions/engine.js directly — a path swap, count
  // unchanged). Merged expectation: 157.
  // −1: the /passes referral eligibility prefetch DIED with the
  // depromotion — main.tsx sheds the referral.js import. 157 → 156.
  // Adjudicated members: ink/launcherAltHold.js (releaseLauncherAltHoldNow
  // — the commander output writer must release the held alt buffer BEFORE a
  // usage error prints; import-free module, zero graph weight);
  // utils/crashReport.js (lastCrashReportPath — the loud exit line names the
  // retained report; static because the crash path must not depend on a
  // dynamic import succeeding mid-crash); the
  // flag-registry alias reader (main.tsx reads
  // registered flags through flagEnv);
  // setAssistantModeActive — the assistant boot
  // seam mirroring assistant mode into the shell-task owner so the shared
  // foreground budget arms honestly
  // (LocalShellTask is in main's transitive boot graph already, so this is
  // zero added eager evaluation weight).
  // -3: the in-Chrome removal
  // dropped the three claudeInChrome/* static imports (prompt.js, setup.js,
  // common.js) from the eager front. 160 → 157.
  // -2: the telemetry estate's structural
  // delete sheds main.tsx's analytics facade + gate-warmup imports
  // (logEvent from analytics/index.js, initializeAnalyticsGates from
  // sink.js). Fewer eager imports — the ratchet's good direction. 157 → 155.
  // -2: the OTel estate deletion sheds
  // main.tsx's two telemetry imports (both were
  // husks feeding deleted sinks). 155 → 153.
  check(
    // 3.6.1: +1 — the terminal-experience resolver (the boot title gate
    // consumes the ONE resolution surface; the count moves WITH that ruling).
    // /REC-4: +1 — substrate/bootBeacon.js
    // (clearBootAttempts beside the numStartups increment: the completed-
    // startup half of the boot-completion beacon; featherweight — fs + path
    // + envUtils, all long since eager).
    // -5: the
    // imports that fed those estates left with them. 153 → 148.
    // -1: main.tsx imports no MCP-registry prefetch — Mercury asks no
    // vendor which MCP servers are "official" (scripts/mcp/
    // prove-no-registry-phonehome.ts drives the built binary). 105 → 104.
    // The eager-front LAW (no heavy module named below may appear) is the
    // teeth; the exact count pins main.tsx's static import surface so any
    // new eager import must be adjudicated here by name.
    // -1: the added-directories rename dropped the dead alias import.
    // -2: the extensions model sheds main.tsx's two static roster imports
    // (the command catalogue reads the active set lazily). 105 → 102.
    // +1: utils/apiPreconnect.js — the root action's API socket warm-up is a
    // boot-path owner by design (the cockpit's first request rides a warm
    // connection); featherweight (oauth constants · debug · proxy ·
    // userAgent, all long since eager). 102 → 103.
    // -2: the unification retires the static resume-restore imports
    // (processResumedConversation · cacheSessionTitle) — a resume paints
    // from its transcript file through the focused connector and the
    // session's runner owns the restore. 103 → 101.
    // +1: utils/cwd.js — the one-door birth (New Session born on Enter)
    // hands bornSession its workspaceDir at the menu's ↵;
    // featherweight (the cwd owner is long eager on every path). 101 → 102.
    // +1: node:fs — the version/rollback exits speak through writeSync
    // (win32 TTY streams are async and process.exit can discard the queued
    // line; the failLoud discipline, TASK-017 S1 class). 102 → 103.
    // +1: services/mcp/membership.js — the runner road honors the disable
    // record: connectMcpBatch partitions by the
    // membership owner at boot; featherweight (flagRegistry · mcp config ·
    // the kit pin, all long since eager). 103 → 104.
    // +1: services/mcp/sessionKitPin.js — the kit rides to the runner:
    // MERCURY_SESSION_KIT is consumed ONCE and
    // FIRST at boot into the process latch (before MCP resolution and the
    // command load — the pin's own law); featherweight (flagRegistry ·
    // sessionReceipts · debug). 104 → 105.
    // +1: node:crypto — failCli's stream-json refusal envelope carries a
    // message uuid (FC-079); the writer is inline because failCli is
    // synchronous and the bundled world has no relative require. Node
    // builtin, zero cost. 105 → 106.
    'eager-front: main.tsx static value imports = 106',
    main.value.length === 106,
    String(main.value.length),
  )
  check(
    'eager-front: main.tsx imports the launch-graph owner',
    main.value.some(s => s.endsWith('boot/launchGraph.js')),
  )
  check(
    // REWRITE RE-CUT: 9 → 6 with the same fold.
    'eager-front: main.tsx type-only imports = 6 (erased at runtime)',
    main.typeOnly.length === 6,
    String(main.typeOnly.length),
  )
  const heavy = [
    'tools.js',
    'commands.js',
    'replLauncher.js',
    'entrypoints/init.js',
    'services/mcp/client.js',
    'interactiveHelpers.js',
    'skills/bundled/index.js',
    'services/analytics/featureGates.js',
  ]
  for (const h of heavy) {
    check(
      `eager-front: main.tsx statically imports ${h} today (a T15 deferral flips this)`,
      main.value.some(s => s.endsWith(`/${h}`) || s === `./${h}`),
    )
  }
  check(
    'paint-surface: main.tsx does NOT statically import screens/REPL.js',
    !main.value.some(s => s.endsWith('screens/REPL.js')),
  )
  check(
    'paint-surface: main.tsx does NOT statically import components/App.js',
    !main.value.some(s => s.endsWith('components/App.js')),
  )

  const launcherSrc = readFileSync(join(SRC, 'replLauncher.tsx'), 'utf8')
  const launcher = staticImports(launcherSrc)
  check(
    "paint-surface: replLauncher's only static value import is react",
    launcher.value.length === 1 && launcher.value[0] === 'react',
    JSON.stringify(launcher.value),
  )
  for (const dyn of [
    './components/App.js',
    './screens/REPL.js',
    './substrate/recoveryOrchestrator.js',
    './bootstrap/state.js',
  ]) {
    check(
      `paint-surface: replLauncher reaches ${dyn} only dynamically`,
      launcherSrc.includes(`import('${dyn}')`),
    )
  }
}

// ── LAW STAGE-1 SHUTDOWN CLOSURE — cli.tsx step 9 evaluates the shutdown
//    installer BEFORE any routing (LSP sidecars, daemon and join fast paths
//    included), so its static value closure must stay featherweight.
//    Measured (packaged dist, warm compile cache, isolated home):
//    the pre-split closure — config barrel + ink/termio + sessionStorage
//    reached statically from gracefulShutdown.ts — cost 160-205ms on EVERY
//    process class. The heavy exit-restoration half lives in
//    shutdownRestoration.ts, reached ONLY at fire time (synchronous require
//    on the exit paths; idle prefetch on interactive boots). ────────────────
{
  const shutdownSrc = readFileSync(join(SRC, 'utils/gracefulShutdown.ts'), 'utf8')
  const sh = staticImports(shutdownSrc)
  // Pinned exactly (the eager-front discipline): every addition to the
  // installer's static closure is a conscious act. Everything listed is
  // either already evaluated by stage 1 (bootstrap/state, debug,
  // startupProfiler ride the step-8 profiler import) or import-free
  // (cleanupRegistry, deadline, diagLogs, log, signal-exit, node builtins).
  const expected = [
    '../bootstrap/state.js',
    './cleanupRegistry.js',
    './deadline.js',
    './debug.js',
    './diagLogs.js',
    './log.js',
    './startupProfiler.js',
    'node:fs',
    'signal-exit',
  ].sort()
  check(
    'stage1-shutdown: installer static value imports pinned (the light set only)',
    JSON.stringify([...sh.value].sort()) === JSON.stringify(expected),
    JSON.stringify(sh.value),
  )
  check('stage1-shutdown: installer has ZERO bare side-effect imports', sh.bare.length === 0)
  // Belt for renames: the heavy world stays out by predicate, not only by
  // the exact-set pin.
  const heavyPredicates: Array<[string, (s: string) => boolean]> = [
    ['the config barrel', s => s.endsWith('/config.js') || s === './config.js'],
    ['ink/*', s => s.includes('/ink/')],
    ['sessionStorage', s => s.includes('sessionStorage')],
    ['warmBackground', s => s.includes('warmBackground')],
    ['chalk', s => s === 'chalk'],
    ['lodash-es', s => s === 'lodash-es'],
  ]
  for (const [label, hit] of heavyPredicates) {
    check(`stage1-shutdown: static closure excludes ${label}`, !sh.value.some(hit))
  }
  check(
    'stage1-shutdown: exit paths reach the restoration half by synchronous require',
    shutdownSrc.includes("require('./shutdownRestoration.js')"),
  )
  check(
    'stage1-shutdown: interactive boots prefetch the restoration half (idle import)',
    shutdownSrc.includes("import('./shutdownRestoration.js')") &&
      shutdownSrc.includes('RESTORATION_PREFETCH_DELAY_MS'),
  )
  check(
    'stage1-shutdown: the bytes fallback exists for a failed at-exit resolve (catch arm only)',
    shutdownSrc.includes('FALLBACK_EXIT_ALT_SCREEN') &&
      shutdownSrc.includes('FALLBACK_SHOW_CURSOR'),
  )
  const restorationSrc = readFileSync(join(SRC, 'utils/shutdownRestoration.ts'), 'utf8')
  check(
    'stage1-shutdown: the restoration half owns cleanupTerminalModes + printResumeHint + the exit drain',
    restorationSrc.includes('export function cleanupTerminalModes') &&
      restorationSrc.includes('export function printResumeHint') &&
      restorationSrc.includes('export function drainStdinForExit'),
  )
}

// ── LAW RESUME-IDENTITY (text over main.tsx + sessionRestore.ts) ───────────
//    The guarded drop: a --resume <uuid> path that omits
//    `sessionIdOverride`. sessionRestore adopts
//    `opts.sessionIdOverride ?? result.sessionId`, and a FULL log carries no
//    top-level sessionId (logs.ts getSessionIdFromLog reads the first message
//    for those) — so every resumed session ran with getSessionId() ===
//    undefined: draft saves skipped on their guard, hooks keyed "undefined",
//    ownerKey.replace threw, the scheduler wrote an owner-less lock, the
//    debug log landed at <home>/debug/undefined.txt.
{
  const mainSrc = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const restoreSrc = readFileSync(join(SRC, 'utils/sessionRestore.ts'), 'utf8')
  const resumeBlock = mainSrc.slice(
    mainSrc.indexOf('} else if (opts.resume || opts.fromPr) {'),
    mainSrc.indexOf('launchPayload = {', mainSrc.indexOf('} else if (opts.resume || opts.fromPr) {')),
  )
  check('resume-identity: the --resume branch exists', resumeBlock.length > 0)
  check(
    'resume-identity: the uuid branch hands the CLI uuid through as the resumed id',
    /resumeLog = log as ResumeLog\s*\n\s*resumeSessionId = resumeValue/.test(resumeBlock),
  )
  check(
    'resume-identity: the title-match branch hands the matched log\'s own id through',
    /resumeSessionId = getSessionIdFromLog\(/.test(resumeBlock),
  )
  // The managed-resume owner: the CLI-provided id IS the session's id —
  // resumeAtBoot hands it to the one resume door, the admit request names
  // the SAME durable id, and the runner boots as it (--resume <id>). The
  // screen's own boot-minted id never substitutes.
  check(
    'resume-identity: resumeAtBoot hands the id to the one resume door',
    /const resumeAtBoot = async \(sessionId: string, log: ResumeLog\)/.test(mainSrc) &&
      /await focusResumedSession\(sessionId, log\.fullPath, \{/.test(mainSrc),
  )
  check(
    'resume-identity: the admit request carries the SAME durable id and the runner boots as it',
    readFileSync(join(SRC, 'services/switchboard/hopIntoSession.ts'), 'utf8').includes('resumeSessionId: sessionId') &&
      readFileSync(join(SRC, 'daemon/concourseSupervisor.ts'), 'utf8').includes("? ['--resume', args.sessionId!,"),
  )
  check(
    'resume-identity: the restore owner adopts the override first',
    /opts\.sessionIdOverride \?\?\s*(?:\n\s*)?result\.sessionId/.test(restoreSrc),
  )
}

// ── LAW EARLY-SEAM ORDER + MCP-GATES-RENDER (text over main.tsx) ────────────
{
  const mainSrc = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const at = (needle: string): number => {
    const i = mainSrc.indexOf(needle)
    check(`seam-order: anchor present — ${needle}`, i >= 0)
    return i
  }
  const bootEnv = at('applyBootMenuEnv();')
  const privHome = at('ensurePrivateConfigHome();')
  const notes = at('collectLauncherNotes();')
  const run = at('await run();')
  check('seam-order: boot-env before private-home', bootEnv < privHome)
  check('seam-order: private-home before launcher-notes', privHome < notes)
  check('seam-order: all three early seams before run()', notes < run)

  const entry = at("profileCheckpoint('main_tsx_entry')")
  const mdm = at('startMdmRawRead();')
  const keychain = at('startKeychainPrefetch();')
  const loaded = at("profileCheckpoint('main_tsx_imports_loaded')")
  check('seam-order: entry mark before MDM prefetch start', entry < mdm)
  check(
    'seam-order: deliberate prefetches fire before the import front settles',
    mdm < keychain && keychain < loaded,
  )

  // S2 FLIPPED the pre-cut law here ("awaited MCP connect precedes every
  // launchRepl site" over THREE sites), and the boot lane moved
  // the interactive owner once more: the REPL's MCPConnectionManager
  // (useManageMCPConnections + its registry) is the ONE interactive MCP
  // owner — it discovers, connects, reconnects and toggles AFTER the first
  // paint; main.tsx seeds it with the --mcp-config servers and the strict
  // flag and never awaits a connect before launchRepl. The former
  // 'mcp-discovery' background node connected the same servers a second
  // time (two stdio spawns per server) and left the --mcp-config servers
  // outside the registry. The print path keeps its awaited inline connect
  // (single-turn -p needs MCP tools at turn 1). The three interactive
  // launch call sites collapsed to ONE (fresh/continue/resume all reduce to a
  // payload; sequencing lives solely in replLauncher.launchRepl).
  const launchSites = [...mainSrc.matchAll(/await launchRepl\(/g)].map(m => m.index!)
  check('launch-graph: ONE interactive launchRepl call site (T15 collapse)', launchSites.length === 1, String(launchSites.length))
  // The print path's inline connect survives — since FN-015 rank 39 it is
  // awaited THROUGH the launch budget (the run proceeds at the connect
  // deadline; late servers serve later calls), same seam, same order.
  at('await withMcpLaunchBudget(connectMcpBatch(regularMcpConfigs')
  check(
    'launch-graph: interactive MCP never rides a background-node connect (the REPL registry owns it)',
    !mainSrc.includes("registerBackgroundNode('mcp-discovery'"),
  )
  const batchCalls = [...mainSrc.matchAll(/connectMcpBatch\((regularMcpConfigs|surviving)/g)].map(m => m.index!)
  check(
    'launch-graph: every connectMcpBatch call sits AFTER the interactive launch site (print-path only)',
    batchCalls.length > 0 && launchSites[0] !== undefined && batchCalls.every(i => i > launchSites[0]!),
    String(batchCalls.length),
  )
  // The --mcp-config servers ride the runner argv table into the session
  // the first message creates (the session's runner owns its MCP servers);
  // the screen seeds no registry of its own. Re-cut: the argv table parks in
  // bootBirthFacts now (one-door birth) — the birth facts hand it to every
  // session this screen births, same law, one owner earlier.
  at('runnerArgv: runnerArgvFromBoot(process.argv.slice(2)),')
  // The resolver answers {servers, errors}; the print batch must consume the
  // SERVERS record (the spread-the-wrapper shape planted phantom entries).
  at('getMercuryMcpConfigs(dynamicMcpConfig).then(resolved => resolved.servers)')
  const managerSrc = readFileSync(join(SRC, 'services/mcp/MCPConnectionManager.tsx'), 'utf8')
  check(
    'launch-graph: MCPConnectionManager forwards --strict-mcp-config into the registry hook',
    managerSrc.includes('useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)'),
  )
  const armAt = at('armBackgroundDiscovery();')
  check(
    'launch-graph: background discovery arms before the launch site',
    armAt >= 0 && launchSites[0] !== undefined && armAt < launchSites[0],
  )
  check(
    'launch-graph: arming is interactive-only (print keeps inline sequencing)',
    /if \(!getIsInteractive\(\)\) return\b[\s\S]{0,220}armBackgroundDiscovery\(\);/.test(mainSrc),
  )

  // renderAndRun is now render-only: the deferred prefetches + MINERVA moved
  // to background nodes (they would otherwise fire AT render, spawning subprocesses
  // into the render→arm window).
  const helpersSrc = readFileSync(join(SRC, 'interactiveHelpers.tsx'), 'utf8')
  check(
    'launch-graph: renderAndRun no longer fires startDeferredPrefetches inline',
    !/startDeferredPrefetches\(\)/.test(helpersSrc),
  )
  check(
    'launch-graph: renderAndRun no longer fires the MINERVA boot pass inline',
    !helpersSrc.includes('maybeRunMinervaOnBoot'),
  )
  for (const node of [
    'startup-prefetch-batch',
    'example-commands',
    'lsp-manager',
    'session-registry',
    'session-telemetry',
    'deferred-prefetches',
    'minerva',
  ]) {
    check(
      `launch-graph: background node '${node}' is declared`,
      mainSrc.includes(`registerBackgroundNode('${node}'`),
    )
  }

  // The input-live signal rides the owned Ink runtime's raw-mode arm — the
  // exact statement where the app's readable handler takes stdin.
  const inkAppSrc = readFileSync(join(SRC, 'ink/components/App.tsx'), 'utf8')
  const armIdx = inkAppSrc.indexOf("stdin.addListener('readable', this.handleReadable)")
  const signalIdx = inkAppSrc.indexOf('signalInputLive();')
  check(
    'launch-graph: signalInputLive fires at the raw-mode arm (owned Ink runtime)',
    armIdx > 0 && signalIdx > armIdx && signalIdx - armIdx < 400,
    `${armIdx},${signalIdx}`,
  )
}

// ── LAW LAUNCH-GRAPH (behavioral, in-process): background discovery starts
//    only after input-live (+settle), runs in order, tolerates a failing
//    node, and late registration still runs. ────────────────────────────────
{
  const g = await import('../../src/boot/launchGraph.js')
  const ran: string[] = []
  const events: string[] = []
  g.registerBackgroundNode('t15-a', () => {
    ran.push('a')
  })
  g.registerBackgroundNode('t15-boom', () => {
    ran.push('boom')
    throw new Error('background nodes are best-effort')
  })
  g.registerBackgroundNode('t15-b', async () => {
    ran.push('b')
  })
  // Store-foundation fix 6: two genuinely-ASYNC independent nodes. The old
  // drain `await`ed each node's completion, so the slow one head-of-line
  // blocked the quick one registered after it — serializing exactly the
  // I/O its own comment claimed it never touched.
  g.registerBackgroundNode('t15-slow', async () => {
    events.push('slow-start')
    await new Promise(r => setTimeout(r, 300))
    events.push('slow-end')
  })
  g.registerBackgroundNode('t15-quick', async () => {
    events.push('quick-start')
    await new Promise(r => setTimeout(r, 40))
    events.push('quick-end')
  })
  check('launch-graph: nodes are inert before arming', ran.length === 0 && events.length === 0)
  g.armBackgroundDiscovery()
  await new Promise(r => setTimeout(r, 80))
  check(
    'launch-graph: armed nodes do NOT start before input-live',
    ran.length === 0,
    ran.join(','),
  )
  check('launch-graph: input-live starts false', g.isInputLive() === false)
  g.signalInputLive()
  check('launch-graph: signal latches', g.isInputLive() === true)
  g.signalInputLive() // idempotent
  await new Promise(r => setTimeout(r, 400)) // settle (250ms) + margin
  check(
    'launch-graph: after input-live + settle, nodes ran IN ORDER',
    ran.join(',') === 'a,boom,b',
    ran.join(','),
  )
  await new Promise(r => setTimeout(r, 400)) // the slow node's 300ms tail
  check(
    'launch-graph: async node KICKS stay in registration order',
    events.indexOf('slow-start') !== -1 &&
      events.indexOf('slow-start') < events.indexOf('quick-start'),
    events.join(','),
  )
  check(
    'launch-graph: an independent async node is NOT head-of-line blocked (runs overlap in the bounded lane)',
    events.indexOf('quick-end') !== -1 &&
      events.indexOf('quick-end') < events.indexOf('slow-end'),
    events.join(','),
  )
  g.registerBackgroundNode('t15-late', () => {
    ran.push('late')
  })
  await new Promise(r => setTimeout(r, 20))
  check(
    'launch-graph: late registration runs immediately (never dropped)',
    ran[ran.length - 1] === 'late',
    ran.join(','),
  )
}

// ── LAW BOOT-ENV APPLIER (in-process, injected path + env) ──────────────────
{
  const menu = await import('../../src/substrate/startupMenu.js')
  const dir = join(HERMETIC, 'boot-env')
  mkdirSync(dir, { recursive: true })

  // bootEnvPath rides THE config-home resolver
  // (getMercuryHome — one home for every config surface). Pin the
  // TOP-precedence selector so ambient MERCURY_CONFIG_DIR/MERCURY_HOME in the
  // harness can't shadow the fixture.
  const savedPin = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = dir
  check(
    'boot-env: bootEnvPath = <configHome>/boot-env.json',
    menu.bootEnvPath() === join(dir, 'boot-env.json'),
  )
  if (savedPin === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = savedPin

  const p = (name: string): string => join(dir, name)
  check('boot-env: missing file ⇒ null (byte-identical no-op)', menu.applyBootMenuEnv(p('absent.json'), {}) === null)

  // A real registered row + a declared choice, from the live registry.
  const row = menu.STARTUP_MENU[0]!
  const choice = menu.menuRowChoices(row).find(c => c.value !== null)!
  writeFileSync(
    p('valid.json'),
    JSON.stringify({ version: menu.BOOT_ENV_VERSION, env: { [row.env]: choice.value } }),
  )

  process.env.MERCURY_ENTER_MENU = '0'
  check(
    'boot-env: MERCURY_ENTER_MENU=0 ⇒ null even with a valid file (live flag read)',
    menu.applyBootMenuEnv(p('valid.json'), {}) === null,
  )
  delete process.env.MERCURY_ENTER_MENU

  writeFileSync(p('garbage.json'), 'not json {')
  const garbage = menu.applyBootMenuEnv(p('garbage.json'), {})
  check(
    'boot-env: invalid JSON ⇒ refused (file), nothing applied',
    garbage !== null &&
      garbage.applied.length === 0 &&
      garbage.refused.length === 1 &&
      garbage.refused[0]!.key === '(file)' &&
      garbage.refused[0]!.reason === 'not valid JSON',
    JSON.stringify(garbage),
  )

  writeFileSync(p('badver.json'), JSON.stringify({ version: 99, env: {} }))
  const badver = menu.applyBootMenuEnv(p('badver.json'), {})
  check(
    'boot-env: wrong version ⇒ refused shape',
    badver !== null && badver.refused.length === 1 && badver.refused[0]!.key === '(file)',
    JSON.stringify(badver),
  )

  writeFileSync(p('badenv.json'), JSON.stringify({ version: menu.BOOT_ENV_VERSION, env: [] }))
  const badenv = menu.applyBootMenuEnv(p('badenv.json'), {})
  check(
    'boot-env: env as array ⇒ refused shape',
    badenv !== null && badenv.refused.length === 1 && badenv.refused[0]!.key === '(file)',
  )

  writeFileSync(
    p('smuggle.json'),
    JSON.stringify({ version: menu.BOOT_ENV_VERSION, env: { PATH: '/evil', [row.env]: choice.value } }),
  )
  const smuggleEnv: Record<string, string | undefined> = {}
  const smuggle = menu.applyBootMenuEnv(p('smuggle.json'), smuggleEnv as never)
  check(
    'boot-env: unregistered key ⇒ refused (anti-smuggling), never applied',
    smuggle !== null &&
      smuggle.refused.some(r => r.key === 'PATH') &&
      smuggleEnv.PATH === undefined,
    JSON.stringify(smuggle),
  )
  check(
    'boot-env: the registered key beside the smuggle still applies',
    smuggle !== null &&
      smuggle.applied.length === 1 &&
      smuggle.applied[0]!.env === row.env &&
      smuggleEnv[row.env] === choice.value,
  )

  writeFileSync(
    p('badvalue.json'),
    JSON.stringify({ version: menu.BOOT_ENV_VERSION, env: { [row.env]: '__not_a_declared_choice__' } }),
  )
  const badvalue = menu.applyBootMenuEnv(p('badvalue.json'), {})
  check(
    "boot-env: a value outside the row's declared choices ⇒ refused",
    badvalue !== null && badvalue.applied.length === 0 && badvalue.refused.length === 1,
    JSON.stringify(badvalue),
  )

  const winsEnv: Record<string, string> = { [row.env]: 'operator-set' }
  const wins = menu.applyBootMenuEnv(p('valid.json'), winsEnv as never)
  check(
    'boot-env: explicit real env ALWAYS outranks the file',
    wins !== null &&
      wins.envWins.length === 1 &&
      wins.envWins[0] === row.env &&
      winsEnv[row.env] === 'operator-set',
    JSON.stringify(wins),
  )

  const freshEnv: Record<string, string | undefined> = {}
  const applied = menu.applyBootMenuEnv(p('valid.json'), freshEnv as never)
  check(
    'boot-env: registered key + declared choice applies into the env',
    applied !== null &&
      applied.applied.length === 1 &&
      freshEnv[row.env] === choice.value,
  )
  check(
    'boot-env: bootEnvAppliedKeys attributes the last apply',
    menu.bootEnvAppliedKeys().has(row.env),
  )

  check(
    'boot-env: writeBootEnvChoice refuses an unregistered key',
    menu.writeBootEnvChoice('NOT_A_ROW', 'x', p('w.json')).ok === false,
  )
  check(
    'boot-env: writeBootEnvChoice refuses an undeclared value',
    menu.writeBootEnvChoice(row.env, '__not_a_declared_choice__', p('w.json')).ok === false,
  )
  const wrote = menu.writeBootEnvChoice(row.env, choice.value as string, p('w.json'))
  const readBack = menu.readBootEnvChoices(p('w.json'))
  const roundEnv: Record<string, string | undefined> = {}
  const roundApply = menu.applyBootMenuEnv(p('w.json'), roundEnv as never)
  check(
    'boot-env: writeBootEnvChoice → read → apply round-trips',
    wrote.ok === true &&
      readBack?.[row.env] === choice.value &&
      roundApply !== null &&
      roundEnv[row.env] === choice.value,
  )
}

// ── LAW EARLY-INPUT (the exported capture seam; stdin here is not a TTY) ────
{
  const ei = await import('../../src/utils/earlyInput.js')
  ei.startCapturingEarlyInput()
  check(
    'early-input: non-TTY start is a no-op (print-mode safety gate)',
    ei.isCapturingEarlyInput() === false,
  )
  ei.seedEarlyInput('  draft text \n')
  check('early-input: seeded buffer reads as available', ei.hasEarlyInput())
  check('early-input: consume trims the seed', ei.consumeEarlyInput() === 'draft text')
  check('early-input: consume is one-shot', ei.consumeEarlyInput() === '' && !ei.hasEarlyInput())
  ei.seedEarlyInput('   \n ')
  check('early-input: whitespace-only seed is not "available"', !ei.hasEarlyInput())
  ei.consumeEarlyInput()
}

// ── LAW LAUNCH-REPL (injected renderAndRun; hermetic empty home) ────────────
{
  const { launchRepl } = await import('../../src/replLauncher.js')
  const { App } = await import('../../src/components/App.js')
  const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
  const { REPL } = await import('../../src/screens/REPL.js')
  const { SeededMCPConnectionManager } = await import('../../src/services/mcp/MCPConnectionManager.js')

  const calls: Array<{ root: unknown; element: React.ReactElement }> = []
  const fakeRender = async (root: unknown, element: never): Promise<void> => {
    calls.push({ root, element })
  }

  const initialState = { teamContext: undefined, __t15: 'state-1' }
  const root = { __t15root: true }
  const replProps = { __t15repl: true }
  // Store-foundation fix 6: the 3s recovery budget timer must be CLEARED
  // once the race settles (recovery wins fast in this hermetic home) —
  // pre-fix the loser sat live for the rest of the budget on every boot.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const budgetTimers = new Set<unknown>()
  const clearedBudgetTimers = new Set<unknown>()
  globalThis.setTimeout = ((fn: never, ms?: number, ...args: never[]) => {
    const t = realSetTimeout(fn, ms, ...args)
    if (ms === 3_000) budgetTimers.add(t)
    return t
  }) as never
  globalThis.clearTimeout = ((t: never) => {
    if (budgetTimers.has(t)) clearedBudgetTimers.add(t)
    return realClearTimeout(t)
  }) as never
  try {
    await launchRepl(
      root as never,
      { getFpsMetrics: () => undefined, initialState: initialState as never },
      replProps as never,
      fakeRender as never,
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  check('launch: renderAndRun called exactly once', calls.length === 1, String(calls.length))
  check(
    'launch: the 3s recovery budget timer is CLEARED when the race settles (no stray boot timer)',
    budgetTimers.size >= 1 && [...budgetTimers].every(t => clearedBudgetTimers.has(t)),
    `created=${budgetTimers.size} cleared=${clearedBudgetTimers.size}`,
  )
  const el = calls[0]?.element as never as {
    type: unknown
    props: { initialState?: unknown; children?: { type: unknown; props: Record<string, unknown> } }
  }
  check('launch: element is App', el?.type === App)
  // the ONE interactive MCP owner mounts between App and the route owner —
  // <App><MCPConnectionManager><SurfaceRouter><REPL/></SurfaceRouter></MCPConnectionManager></App>
  // (connections survive route flips; the REPL stays the always-mounted
  // child of the router).
  check('launch: App wraps the MCP owner', el?.props?.children?.type === SeededMCPConnectionManager)
  const mcpOwned = el?.props?.children?.props as { children?: { type: unknown; props: Record<string, unknown> } }
  check('launch: the MCP owner wraps SurfaceRouter', mcpOwned?.children?.type === SurfaceRouter)
  const routed = mcpOwned?.children?.props as { children?: { type: unknown; props: Record<string, unknown> } }
  check('launch: SurfaceRouter wraps REPL', routed?.children?.type === REPL)
  check(
    'launch: replProps forwarded untouched',
    (routed?.children?.props as { __t15repl?: boolean })?.__t15repl === true,
  )
  check('launch: root forwarded untouched', (calls[0]?.root as { __t15root?: boolean })?.__t15root === true)
  check(
    'launch: empty home ⇒ initialState forwarded by REFERENCE (no fabricated projection)',
    el?.props?.initialState === initialState,
  )

  // A pre-set teamContext must survive (the never-override guard; the
  // leaderProjection-from-disk override case needs a recovery fixture and
  // lands with the cut — recorded as a gap, not faked here).
  const preset = { teamContext: { teamName: '__t15-preset' }, __t15: 'state-2' }
  await launchRepl(
    root as never,
    { getFpsMetrics: () => undefined, initialState: preset as never },
    replProps as never,
    fakeRender as never,
  )
  const el2 = calls[1]?.element as never as { props: { initialState?: { teamContext?: { teamName?: string } } } }
  check(
    'launch: a pre-set teamContext is forwarded unchanged',
    el2?.props?.initialState?.teamContext?.teamName === '__t15-preset',
  )
}

// ── LAW RECOVERY-BUDGET (structural — the behavioral leg needs a fault seam) ─
{
  const launcherSrc = readFileSync(join(SRC, 'replLauncher.tsx'), 'utf8')
  check(
    'recovery: budget constant is 3,000ms',
    launcherSrc.includes('BOOT_RECOVERY_BUDGET_MS = 3_000'),
  )
  check(
    'recovery: recovery is raced against the budget',
    /Promise\.race\(\[\s*recovery,/.test(launcherSrc) &&
      launcherSrc.includes('BOOT_RECOVERY_BUDGET_MS)'),
  )
  check(
    'recovery: a thrown recovery never stops the render (catch + render after)',
    launcherSrc.indexOf('} catch {') > 0 &&
      launcherSrc.indexOf('await renderAndRun(') > launcherSrc.indexOf('} catch {'),
  )
  check(
    'recovery: the projection seed never overrides an existing teamContext',
    launcherSrc.includes('report?.leaderProjection && !appProps.initialState.teamContext'),
  )
  // Store-foundation fix 6: a recovery that LOSES the 3s race is not
  // dropped — its late-settling leaderProjection reaches the mounted app
  // through the boot-recovery store, applied inside AppStateProvider by
  // App's LateBootProjectionSeed under the same never-override guard.
  const appSrc = readFileSync(join(SRC, 'components/App.tsx'), 'utf8')
  check(
    'recovery: App mounts the late-projection seed inside AppStateProvider',
    /<AppStateProvider[^>]*><LateBootProjectionSeed \/>/.test(appSrc),
  )
  check(
    'recovery: the late seed subscribes to the boot-recovery store and applies on done',
    appSrc.includes('subscribeBootRecovery(') &&
      appSrc.includes('getBootRecovery()') &&
      appSrc.includes("if (s.phase !== 'done') return false"),
  )
  check(
    'recovery: the late seed keeps the never-override guard',
    appSrc.includes('prev.teamContext ? prev :'),
  )
}

rmSync(HERMETIC, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nnative-core boot contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core boot contract: green (${checks} checks)`)
