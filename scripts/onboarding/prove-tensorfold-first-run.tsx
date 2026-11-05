#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const scenarioAt = process.argv.indexOf('--scenario')
const scenario = scenarioAt < 0 ? null : (process.argv[scenarioAt + 1] ?? null)
const sizeAt = process.argv.indexOf('--size')
const [COLS, ROWS] = (sizeAt < 0 ? '120x40' : (process.argv[sizeAt + 1] ?? '120x40')).split('x').map(Number) as [number, number]
const framesAt = process.argv.indexOf('--frames')
const FRAMES = framesAt < 0 ? undefined : process.argv[framesAt + 1]

if (scenario !== null) {
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
  const { mock } = await import('bun:test')
  const GIB = 1024 ** 3
  const fit = (needed: number) => ({ verdict: 'fits' as const, neededGib: needed, availableGib: 36, estimate: true as const })
  const ROWS_ON_DISK = [
    { repo: 'TensorFold/Qwen3.8-27B-MLX-4bit', shortName: 'qwen3.8-27b', label: 'Qwen3.8 27B', family: 'qwen27', state: 'not-pulled' as const, fit: fit(28.5), window: 131_072, qualified: true },
    { repo: 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', shortName: 'nemotron-lightning', label: 'Nemotron Lightning', family: 'nemotron', state: 'not-pulled' as const, fit: fit(20.8), window: 262_144, qualified: true },
    { repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', shortName: 'qwen3.5-2b', label: 'Qwen3.5 2B', family: 'qwen3_5', state: 'on-disk' as const, fit: fit(7.6), window: 262_144, qualified: true, bytesOnDisk: 1.6 * GIB },
  ]
  const realEngine = await import('../../src/services/tensorfold/engine.ts')
  mock.module('../../src/services/tensorfold/engine.js', () => ({
    ...realEngine,
    findTensorFoldEngine: async () => (Bun.which('tensorfold') !== null ? { version: '1.2.2', binary: Bun.which('tensorfold')!, chip: 'Apple M5 Pro', backends: ['metal'], families: [] } : null),
    tensorFoldMachine: () => ({ chip: 'Apple M5 Pro', usableGib: 36 }),
  }))
  const realInventory = await import('../../src/services/tensorfold/inventory.ts')
  mock.module('../../src/services/tensorfold/inventory.js', () => ({
    ...realInventory,
    readTensorFoldInventory: async () => ROWS_ON_DISK,
    bestTensorFoldFit: (rows: readonly { repo: string }[]) => rows[0] ?? null,
  }))
  mock.module('../../src/services/providers/local/tensorfoldApp.js', () => ({
    detectTensorFoldApp: async () => ({ running: false }),
  }))
  const React = await import('react')
  const { KEY, mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const handover = await import('../../src/substrate/splashHandover.js')
  const helm = await import('../../src/utils/cockpit/helmFocus.js')
  const facts = await import('../../src/components/tensorfold/tensorfoldFacts.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { Onboarding } = await import('../../src/components/Onboarding.js')
  const h = React.createElement
  let finished = 0
  const element = h(AppStateProvider as never, { onChangeAppState: () => {} } as never, h(KeybindingSetup as never, {} as never, h(Onboarding as never, { onDone: () => { finished++ } } as never)))
  const mounted = await mountOffscreen(element, COLS, ROWS)
  const until = async (needle: string | RegExp, ms = 15_000): Promise<boolean> => waitFor(() => (typeof needle === 'string' ? mounted.screen().includes(needle) : needle.test(mounted.screen())), ms)
  const frames: Record<string, string> = { capable: String(facts.tensorFoldCapableMachine()) }
  await until('Choose your theme')
  await settle(300)
  mounted.push(KEY.enter)
  await until(/sign in · 2\/\d/)
  await settle(500)
  frames['station'] = mounted.screen()
  frames['stationLines'] = mounted.lines().join('\n')
  if (scenario === 'back-out') {
    mounted.push(KEY.enter)
    await until('Guardrails')
    await settle(200)
    mounted.push(KEY.esc)
    await until(/sign in · 2\/\d/)
    await settle(300)
    mounted.push('s')
    await until('Guardrails')
    await settle(200)
  } else {
    mounted.push(KEY.enter)
    await until('Guardrails')
    await settle(200)
  }
  frames['afterChoice'] = mounted.screen()
  for (let step = 0; step < 4 && finished === 0; step++) {
    mounted.push(KEY.enter)
    await settle(500)
  }
  frames['finished'] = String(finished)
  frames['dispatch'] = String(helm.consumeCommandDispatch())
  frames['intent'] = String(handover.consumeBootSurfaceIntent())
  mounted.unmount()
  process.stdout.write(`@@FRAMES@@${JSON.stringify(frames)}`)
  process.exit(0)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const DEAD = 'http://127.0.0.1:9'
const SCRATCH = mkdtempSync(join(tmpdir(), 'tensorfold-first-run-'))
const FAKE_BIN = join(SCRATCH, 'fake-bin')
mkdirSync(FAKE_BIN, { recursive: true })
writeFileSync(join(FAKE_BIN, 'tensorfold'), '#!/bin/sh\necho "tensorfold 1.2.2"\n')
chmodSync(join(FAKE_BIN, 'tensorfold'), 0o755)
const BARE_PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(':')

const run = (tag: string, opts: { fake: boolean; probe: string }, size = '120x40'): Record<string, string> => {
  const home = mkdtempSync(join(SCRATCH, `${tag}-home-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: opts.fake ? `${FAKE_BIN}:${BARE_PATH}` : BARE_PATH,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_RECESS: '0',
    MERCURY_LOCAL_PROBE_TARGETS: opts.probe,
    BROWSER: 'true',
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
    MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    TERM_PROGRAM: 'vscode',
  }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR)$/.test(key)) delete env[key]
  }
  const r = spawnSync(process.execPath, ['run', SELF, '--scenario', tag, '--size', size], { encoding: 'utf8', env, timeout: 150_000 })
  rmSync(home, { recursive: true, force: true })
  const at = r.stdout.indexOf('@@FRAMES@@')
  try {
    return JSON.parse(r.stdout.slice(at + '@@FRAMES@@'.length)) as Record<string, string>
  } catch {
    return { error: `${r.status} · ${(r.stderr + r.stdout).slice(-900)}` }
  }
}
const flat = (grid: string): string => grid.split('\n').map(l => l.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '')).join(' ').replace(/\s+/g, ' ')
const focusedRow = (grid: string): string => grid.split('\n').find(l => /[▸❯]/.test(l))?.replace(/^.*[▸❯]\s*/, '').replace(/\s*│.*$/, '').trim() ?? ''
const firstRow = (grid: string): string => grid.split('\n').find(l => / — /.test(l) && !/Sign in later|first run/.test(l))?.replace(/^[^A-Za-z]*(?:[▸❯]\s*)?/, '').replace(/\s*│.*$/, '').trim() ?? ''

const READY = 'TensorFold — run Qwen3.8 27B on this Mac, no account (/tensorfold)'
const INSTALL = 'TensorFold — install and run Qwen3.8 27B on this Mac, no account (/tensorfold)'
const PROBE_ON = 'llamacpp=http://127.0.0.1:9'

console.log('§1 a capable machine with TensorFold on PATH: the TensorFold row leads, focused, named for the best fit; ↵ walks on and the chat opens /tensorfold after trust')
const installed = run('installed', { fake: true, probe: PROBE_ON })
const capable = installed.capable === 'true'
if (capable) {
  const station = installed.station ?? installed.error ?? ''
  check('the first row is TensorFold, named for the best fit, and it is the focused one', firstRow(station).startsWith('TensorFold — run Qwen3.8 27B') && focusedRow(station).startsWith('TensorFold — run Qwen3.8 27B'), `${firstRow(station)} · focused: ${focusedRow(station)}`)
  check("the row's words are the design's", flat(station).includes(READY), flat(station).slice(0, 600))
  check('the intro names TensorFold among what you can connect', flat(station).includes('or connect TensorFold, OpenRouter'), flat(station).slice(0, 400))
  check('↵ on it completes the sign-in step without a credential (Guardrails next)', (installed.afterChoice ?? '').includes('Guardrails'), (installed.afterChoice ?? '').split('\n').slice(0, 4).join(' / '))
  check('the walk finished', installed.finished === '1', installed.finished ?? '')
  check('after trust the chat lands and opens /tensorfold: the boot lands on the chat and /tensorfold is the command it runs', installed.dispatch === '/tensorfold' && installed.intent === 'repl', `${installed.dispatch} · ${installed.intent}`)
} else {
  check('this machine cannot run TensorFold: no TensorFold row, the walk as it was', !flat(installed.station ?? '').includes('TensorFold') && installed.dispatch === 'null', flat(installed.station ?? '').slice(0, 300))
}

console.log('§2 a capable machine without TensorFold: the row still leads and says the install is a step')
const bare = run('not-installed', { fake: false, probe: PROBE_ON })
if (capable) {
  const station = bare.station ?? bare.error ?? ''
  check('the first row says install and run, focused', firstRow(station) === INSTALL && focusedRow(station) === INSTALL, `${firstRow(station)} · focused: ${focusedRow(station)}`)
} else {
  check('this machine cannot run TensorFold: no row', !flat(bare.station ?? '').includes('TensorFold'))
}

console.log('§3 local probing off (every hermetic walk): the walk is unchanged')
const off = run('probing-off', { fake: true, probe: 'none' })
{
  const station = off.station ?? off.error ?? ''
  check('no TensorFold row and no TensorFold in the intro', !flat(station).includes('TensorFold'), flat(station).slice(0, 300))
  check('the first row and the focus are OpenAI as before', firstRow(station).startsWith('OpenAI — ChatGPT subscription') && focusedRow(station).startsWith('OpenAI — ChatGPT subscription'), `${firstRow(station)} · focused: ${focusedRow(station)}`)
  check('nothing armed for after trust', off.dispatch === 'null' && off.intent === 'null', `${off.dispatch} · ${off.intent}`)
}

console.log('§4 choosing TensorFold, backing out and choosing Sign in later instead disarms the deep link')
if (capable) {
  const back = run('back-out', { fake: true, probe: PROBE_ON })
  check('the walk finished through the later row', back.finished === '1', back.error ?? back.finished ?? '')
  check('no /tensorfold dispatch and no chat landing were left armed', back.dispatch === 'null' && back.intent === 'null', `${back.dispatch} · ${back.intent}`)
}

console.log('§5 the rows on every platform: first on a capable machine, after the subscriptions on Windows')
{
  const rows = await import('../../src/components/loginFamilyRows.ts')
  const facts = await import('../../src/components/tensorfold/tensorfoldFacts.ts')
  const host = rows.loginFamilyRows({ engineLegs: true, tensorfold: { kind: 'host' } })
  check('Windows: the row reads on a host and sits after the two subscriptions', host[2]?.label === 'TensorFold — on a host: a server on your network or a rented GPU pod (/tensorfold)' && host[0]?.value === 'openai' && host[1]?.value === 'anthropic', host.slice(0, 3).map(row => row.label).join(' | '))
  const served = rows.loginFamilyRows({ engineLegs: true, tensorfold: { kind: 'served', model: 'qwen3.5-2b', version: '1.2.2' } })
  check('a server already answering is named', served[0]?.label === 'TensorFold — run qwen3.5-2b on TensorFold 1.2.2, no account (/tensorfold)', served[0]?.label ?? '')
  const gpu = rows.loginFamilyRows({ engineLegs: true, tensorfold: { kind: 'ready', label: 'Nemotron Lightning', place: 'gpu' } })
  check("a CUDA box names its GPU", gpu[0]?.label === "TensorFold — run Nemotron Lightning on this machine's NVIDIA GPU, no account (/tensorfold)", gpu[0]?.label ?? '')
  check('no offer, no row: the roster as it was', rows.loginFamilyRows({ engineLegs: true }).length === rows.loginFamilyRows({ engineLegs: true, tensorfold: null }).length && rows.loginFamilyRows({ engineLegs: true })[0]?.value === 'openai')
  check('capable: Apple silicon; Linux with the R580+ driver; nothing else', facts.tensorFoldCapableMachine('darwin', 'arm64') && !facts.tensorFoldCapableMachine('darwin', 'x64') && facts.tensorFoldCapableMachine('linux', 'x64', () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05  Thu Sep 18 2026') && !facts.tensorFoldCapableMachine('linux', 'x64', () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 2024') && !facts.tensorFoldCapableMachine('linux', 'x64', () => undefined) && !facts.tensorFoldCapableMachine('win32', 'x64', () => 'Kernel Module  580.95.05'))
}

if (FRAMES !== undefined && capable) {
  mkdirSync(FRAMES, { recursive: true })
  for (const size of ['160x48', '110x34', '96x30']) {
    const frames = run('installed', { fake: true, probe: PROBE_ON }, size)
    writeFileSync(join(FRAMES, `26-first-run-${size}.txt`), `${frames.stationLines ?? frames.error ?? ''}\n`)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-tensorfold-first-run: ALL GREEN' : `\nprove-tensorfold-first-run: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
