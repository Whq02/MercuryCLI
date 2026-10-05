#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argument('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const EFFORT_ROW = /effort: ([a-z]+) · \/effort to change/
const READY_ROW = /ready · .+? · (max|xhigh|high|medium|low)\b/

section('§1 by construction — the notice names the word the status chip names')
{
  const modulePath = join(ROOT, 'src', 'components', 'PromptInput', 'composerEffortNotice.ts')
  check('the composer owns an effort-notice module beside the chip label', existsSync(modulePath), modulePath)
  if (existsSync(modulePath)) {
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
    enableConfigs()
    const { composerEffortLabel, composerEffortNotice } = await import('../../src/components/PromptInput/composerEffortNotice.ts')
    const model = 'claude-opus-5-5'
    const table: Array<[string, Parameters<typeof composerEffortNotice>[0]]> = [
      ['a seat word with the screen state reset (the picker pick)', { model, seatEffort: 'max', sentEffort: undefined, effortValue: undefined, bornEffort: null }],
      ['a seat word beside a screen word', { model, seatEffort: 'max', sentEffort: undefined, effortValue: 'high', bornEffort: null }],
      ['the sent word over the seat word', { model, seatEffort: 'max', sentEffort: 'high', effortValue: undefined, bornEffort: null }],
      ['a born word with no seat', { model, seatEffort: null, sentEffort: undefined, effortValue: undefined, bornEffort: 'max' }],
      ['no seat, the screen word', { model, seatEffort: null, sentEffort: undefined, effortValue: 'low', bornEffort: null }],
      ['no seat, no word (the model default)', { model, seatEffort: null, sentEffort: undefined, effortValue: undefined, bornEffort: null }],
    ]
    for (const [label, facts] of table) {
      const chip = composerEffortLabel(facts)
      const notice = composerEffortNotice(facts)
      const word = notice === undefined ? undefined : EFFORT_ROW.exec(notice)?.[1]
      check(`${label}: the notice carries the chip's word (${chip})`, chip !== undefined && word === chip, `notice ${JSON.stringify(notice)} chip ${JSON.stringify(chip)}`)
    }
    check('a model without an effort axis has no notice', composerEffortNotice({ model: 'claude-haiku-4-5-20251001', seatEffort: 'max', sentEffort: undefined, effortValue: 'max', bornEffort: null }) === undefined)
    const root = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
    check('the composer toast is built from the seat facts through that module', root.includes('composerEffortNotice({') && root.includes('seatEffort,') && root.includes('sentEffort,') && root.includes('bornEffort,'))
    check('the composer reads the three seat facts the chip reads', root.includes('useFocusedServedEffort()') && root.includes('useFocusedSentEffort()') && root.includes('useFocusedBornEffort()'))
  }
}

section('§2 pty — opt+p on a hosted chat that runs at max: no notice says otherwise')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the pty leg needs the posix capture driver (${driver.kind})`)
} else if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} missing — the pty leg needs a build`)
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'optp-effort-notice-')))
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ engine: { effort: 'max' } }))

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
    { atTick: 80, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, requireAwait: true, data: '\r' },
    on(PROMPT, '', { awaitSettleTicks: 3, mark: 'idle' }),
    on(PROMPT, `${ESC}p`, { awaitSettleTicks: 1 }),
    on(PICKER, `${ESC}[B`, { awaitSettleTicks: 1 }),
    on(PICKER, '\r', { awaitSettleTicks: 1 }),
    on(PROMPT, '', { awaitSettleTicks: 3, mark: 'picked' }),
    on('Set model to', '', { awaitSettleTicks: 1, mark: 'switched' }),
    on(PROMPT, '', { awaitSettleTicks: 8, mark: 'picked-later' }),
    on(PROMPT, '', { awaitSettleTicks: 8, mark: 'picked-latest' }),
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
      readyText: [PROMPT],
      cols: 120,
      rows: 40,
      out: gridPath,
      title: 'optp-effort-notice',
    }),
  )
  const res = spawnSync(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], {
    env,
    cwd: project,
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
  })
  check('the capture ran', res.status === 0 && existsSync(gridPath), `status ${res.status}: ${(res.stderr ?? '').slice(-400)}`)
  if (res.status === 0 && existsSync(gridPath)) {
    const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { marks?: Mark[] }
    const marks = new Map((payload.marks ?? []).map(m => [m.label, m]))
    const rows = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join('').trimEnd())
    const statusWord = (grid: Cell[][]): string | undefined => {
      for (const row of rows(grid)) {
        const hit = READY_ROW.exec(row)
        if (hit) return hit[1]
      }
      return undefined
    }
    const noticeWord = (grid: Cell[][]): string | undefined => {
      for (const row of rows(grid)) {
        const hit = EFFORT_ROW.exec(row)
        if (hit) return hit[1]
      }
      return undefined
    }
    const idle = marks.get('idle')
    const switched = marks.get('switched')
    const after = ['picked', 'switched', 'picked-later', 'picked-latest'].map(label => marks.get(label)).filter((m): m is Mark => m !== undefined)
    check('the hosted chat booted with an empty composer', idle !== undefined && rows(idle.grid).some(r => r.includes(PROMPT)), idle ? rows(idle.grid).filter(r => r.includes('❯')).join(' | ') : 'no mark')
    check('the four readings after the pick were taken', after.length === 4, after.map(m => m.label).join(','))
    const status = after.map(m => statusWord(m.grid))
    check('the status row carries the seat word max after the pick', status.every(w => w === 'max'), after.map(m => rows(m.grid).filter(r => r.includes('ready ·')).join(' | ')).join(' || '))
    const seen = after.map(m => ({ label: m.label, word: noticeWord(m.grid), status: statusWord(m.grid) }))
    check(
      'no effort notice after the pick names a word the status row does not show',
      seen.every(s => s.word === undefined || s.word === s.status),
      seen.map(s => `${s.label}: notice ${JSON.stringify(s.word)} status ${JSON.stringify(s.status)}`).join(' · '),
    )
    check('the switch itself was announced', switched !== undefined && rows(switched.grid).some(r => r.includes('Set model to')), switched ? rows(switched.grid).filter(r => r.includes('model')).join(' | ') : 'no mark')
    for (const m of after) writeFileSync(join(scratch, `${m.label}.txt`), rows(m.grid).join('\n'))
    console.log(`  frames: ${scratch}`)
  }
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
