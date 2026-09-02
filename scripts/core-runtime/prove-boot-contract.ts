#!/usr/bin/env bun
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

{
  const p = await import('../../src/utils/startupProfiler.js')
  const { getPerformance } = await import('../../src/utils/profilerBase.js')

  p.profileCheckpoint('t15_probe_a')
  p.profileCheckpoint('t15_probe_b')
  p.profileCheckpoint('t15_probe_a')

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
  p.profileReport()
  check('profiler: report is once-only (latched)', !existsSync(logPath))
}

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

{
  const cliSrc = readFileSync(join(SRC, 'entrypoints/cli.tsx'), 'utf8')
  const cli = staticImports(cliSrc)
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
  check(
    'eager-front: main.tsx static value imports = 106',
    main.value.length === 106,
    String(main.value.length),
  )
  check(
    'eager-front: main.tsx imports the launch-graph owner',
    main.value.some(s => s.endsWith('boot/launchGraph.js')),
  )
  check(
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

{
  const shutdownSrc = readFileSync(join(SRC, 'utils/gracefulShutdown.ts'), 'utf8')
  const sh = staticImports(shutdownSrc)
  const expected = [
    '../bootstrap/state.js',
    './cleanupRegistry.js',
    './deadline.js',
    './debug.js',
    './diagLogs.js',
    './log.js',
    './process.js',
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

  const launchSites = [...mainSrc.matchAll(/await launchRepl\(/g)].map(m => m.index!)
  check('launch-graph: ONE interactive launchRepl call site (T15 collapse)', launchSites.length === 1, String(launchSites.length))
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
  at('runnerArgv: runnerArgvFromBoot(process.argv.slice(2)),')
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

  const inkAppSrc = readFileSync(join(SRC, 'ink/components/App.tsx'), 'utf8')
  const armIdx = inkAppSrc.indexOf("stdin.addListener('readable', this.handleReadable)")
  const signalIdx = inkAppSrc.indexOf('signalInputLive();')
  check(
    'launch-graph: signalInputLive fires at the raw-mode arm (owned Ink runtime)',
    armIdx > 0 && signalIdx > armIdx && signalIdx - armIdx < 400,
    `${armIdx},${signalIdx}`,
  )
}

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
  g.signalInputLive()
  await new Promise(r => setTimeout(r, 400))
  check(
    'launch-graph: after input-live + settle, nodes ran IN ORDER',
    ran.join(',') === 'a,boom,b',
    ran.join(','),
  )
  await new Promise(r => setTimeout(r, 400))
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

{
  const menu = await import('../../src/substrate/startupMenu.js')
  const dir = join(HERMETIC, 'boot-env')
  mkdirSync(dir, { recursive: true })

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
