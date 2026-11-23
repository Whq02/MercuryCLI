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
for (const k of ['MERCURY_HOME', 'MERCURY_ENTER_MENU']) {
  delete process.env[k]
}
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })


let failures = 0
let checks = 0
const WHERE: Array<[string, string]> = [
  ['profiler:', 'src/boot/startupProfiler.ts (profileCheckpoint, profileReport, getStartupPerfLogPath)'],
  ['launch-graph:', 'src/boot/launchGraph.ts (registerBackgroundNode, armBackgroundDiscovery, signalInputLive)'],
  ['boot-env:', 'src/platform/substrate/startupMenu.ts (applyBootMenuEnv, writeBootEnvChoice, readBootEnvChoices, bootEnvPath)'],
  ['early-input:', 'src/boot/earlyInput.ts'],
  ['launch:', 'launchChat in src/boot/chatLauncher.ts'],
]
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    const where = WHERE.find(([prefix]) => label.startsWith(prefix))?.[1]
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}${where ? `\n    fix: ${where}` : ''}`)
  }
}

console.log('native-core T15 — launch-graph boot contract')

{
  const p = await import('../../src/boot/startupProfiler.js')
  const { getPerformance } = await import('../../src/platform/logs/profiling.js')

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
  const menu = await import('../../src/platform/substrate/startupMenu.js')
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
  const ei = await import('../../src/boot/earlyInput.js')
  ei.startCapturingEarlyInput()
  check(
    'early-input: non-TTY start is a no-op (run-mode safety gate)',
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
  const { launchChat } = await import('../../src/boot/chatLauncher.js')
  const { App } = await import('../../src/boot/App.js')
  const { SurfaceRouter } = await import('../../src/screen/routes/SurfaceRouter.js')
  const { Chat } = await import('../../src/screen/chat/Chat.js')

  const calls: Array<{ root: unknown; element: React.ReactElement }> = []
  const fakeRender = async (root: unknown, element: never): Promise<void> => {
    calls.push({ root, element })
  }

  const initialState = { __t15: 'state-1' }
  const root = { __t15root: true }
  const chatProps = { __t15repl: true }
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
    await launchChat(
      root as never,
      { getFpsMetrics: () => undefined, initialState: initialState as never },
      chatProps as never,
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
  check('launch: App wraps SurfaceRouter without a second MCP owner', el?.props?.children?.type === SurfaceRouter)
  const routed = el?.props?.children?.props as { children?: { type: unknown; props: Record<string, unknown> } }
  check('launch: SurfaceRouter wraps Chat', routed?.children?.type === Chat)
  check(
    'launch: chatProps forwarded untouched',
    (routed?.children?.props as { __t15repl?: boolean })?.__t15repl === true,
  )
  check('launch: root forwarded untouched', (calls[0]?.root as { __t15root?: boolean })?.__t15root === true)
  const forwarded = (el?.props?.initialState ?? {}) as Record<string, unknown>
  check(
    'launch: empty home ⇒ every field of initialState is forwarded by REFERENCE and nothing is added — no crew projection, no born crew',
    Object.keys(initialState as Record<string, unknown>).every(key => forwarded[key] === (initialState as Record<string, unknown>)[key]) &&
      Object.keys(forwarded).every(key => key in (initialState as Record<string, unknown>)),
    JSON.stringify(Object.keys(forwarded)),
  )
}


rmSync(HERMETIC, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nnative-core boot contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core boot contract: green (${checks} checks)`)
