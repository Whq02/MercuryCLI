#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argument('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 300)}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const SAVED = 'saved as your default'
const READY_ROW = /ready · .+? · (max|xhigh|high|medium|low)\b/

section('§1 by construction — the picker pick and /model share the one owner of the saved default')
{
}

section('§2 pty — opt+p, ↓, ↵: the choice is the saved default and the receipt says so')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the pty leg needs the posix capture driver (${driver.kind})`)
} else if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} missing — the pty leg needs a build`)
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'optp-saved-default-')))
  const shimDir = join(scratch, 'bin')
  mkdirSync(shimDir, { recursive: true })
  for (const exe of ['git', 'ssh']) {
    const shim = join(shimDir, exe)
    writeFileSync(shim, '#!/bin/sh\nexit 128\n')
    chmodSync(shim, 0o755)
  }
  const project = join(scratch, 'proj')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# fixture project\n')
  const home = join(scratch, 'home-optp')
  seedFirstRun(home, [project])
  const settingsPath = join(home, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ engine: { effort: 'max' } }))

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    HOME: join(scratch, 'home'),
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    USER: 'sam',
    TERM: 'xterm-256color',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    BROWSER: '/usr/bin/true',
  }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN',
    'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI',
    'VSHOT_ACTIVE', 'MERCURY_CRITTER', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL',
  ]) {
    delete env[key]
  }
  mkdirSync(env.HOME!, { recursive: true })

  type Cell = { c: string }
  type Mark = { label: string; grid: Cell[][] }
  const ESC = '\x1b'
  const PROMPT = 'Type a prompt'
  const PICKER = 'Applies to this and future sessions'
  const on = (needle: string, data: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    atTick: 199,
    awaitText: needle,
    minTick: 1,
    requireAwait: true,
    data,
    ...extra,
  })
  const sends: Record<string, unknown>[] = [
    { atTick: 80, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    on(PROMPT, '', { awaitPattern: READY_ROW.source, awaitSettleTicks: 3, mark: 'idle' }),
    on(PROMPT, `${ESC}p`, { awaitSettleTicks: 1 }),
    on(PICKER, `${ESC}[B`, { awaitSettleTicks: 1 }),
    on(PICKER, '', { awaitSettleTicks: 1, mark: 'picker' }),
    on(PICKER, '\r', { awaitSettleTicks: 1 }),
    on('Set model to', '', { awaitSettleTicks: 2, mark: 'switched' }),
  ]
  const gridPath = join(scratch, 'optp.json')
  const cfgPath = join(scratch, 'optp-cfg.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: [nodeBin, DIST, '--chat'],
      cwd: project,
      sends,
      total: 220,
      readyText: ['Set model to'],
      cols: 120,
      rows: 40,
      out: gridPath,
      title: 'optp-saved-default',
    }),
  )
  const res = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
    env,
    cwd: project,
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
  })
  check('the capture ran', res.status === 0 && existsSync(gridPath), `status ${res.status}: ${(res.stderr ?? '').slice(-400)}`, 'run bun run build.ts so dist/mercury.mjs exists, then read the stderr above for why the pty capture driver failed')
  if (res.status === 0 && existsSync(gridPath)) {
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[] }
    const marks = new Map((payload.marks ?? []).map(m => [m.label, m]))
    const rows = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join('').trimEnd())
    const idle = marks.get('idle')
    const picker = marks.get('picker')
    const switched = marks.get('switched')
    check('the hosted chat is admitted before the picker opens', idle !== undefined && rows(idle.grid).some(r => READY_ROW.test(r)), idle ? rows(idle.grid).filter(r => r.includes('ready')).join(' | ') : 'no mark', 'the chat never showed its ready row (ready · model · effort) before opt+p was sent; check the boot and chat start-up path in the built dist/mercury.mjs')
    const pickedRow = picker === undefined ? undefined : rows(picker.grid).find(r => /❯\s+(?:\d+\.\s+)?claude-/.test(r))
    const pickedId = pickedRow === undefined ? undefined : /❯\s+(?:\d+\.\s+)?(\S+)/.exec(pickedRow)?.[1]
    check('the picker opened on opt+p and ↓ moved the cursor to a model row', pickedId !== undefined && pickedId.startsWith('claude-'), pickedRow ?? 'no ❯ row', 'opt+p should open the model picker (src/screen/model-picker/ModelPicker.tsx, opened through modelDoorsSurfaceOf in src/screen/composer/composerModelDoorsParts.tsx) and the down key should land on a claude- row')
    const receipts = switched === undefined ? [] : rows(switched.grid).filter(r => r.includes('Set model to'))
    check('the receipt names the pick as the saved default, as /model does (the transcript ack row beside it carries the plain words)', receipts.some(r => r.includes(SAVED)), receipts.join(' | ') || 'no receipt', 'the Set model to notice is built in applyModelSelectionOf in src/screen/composer/composerModelDoorsParts.tsx and takes its saved wording from persistModelChoice in src/commands/model/persistModelChoice.ts; make the opt+p pick call it with persist true')
    const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: { model?: string; effort?: string } }) : {}
    check('the settings carry the pick as the default model', pickedId !== undefined && settings.engine?.model === pickedId, `settings ${JSON.stringify(settings)} picked ${JSON.stringify(pickedId)}`, 'the opt+p pick must write engine.model through persistModelChoice in src/commands/model/persistModelChoice.ts, as /model does')
    check('the saved effort is untouched by a model pick', settings.engine?.effort === 'max', JSON.stringify(settings), 'a model pick must change engine.model only; persistModelChoice in src/commands/model/persistModelChoice.ts should not write engine.effort')
    writeFileSync(join(scratch, 'switched.txt'), switched ? rows(switched.grid).join('\n') : '')
    console.log(`  frames: ${scratch}`)
  }
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
