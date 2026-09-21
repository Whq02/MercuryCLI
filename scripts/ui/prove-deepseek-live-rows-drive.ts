#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const argAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}
const DIST = resolve(argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))
const OUT = argAfter('--out')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'deepseek-catalogue-fixture-server.ts')
const PINS = join(ROOT, 'src', 'services', 'providers', 'deepseek', 'deepseekPins.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`no POSIX pty capture driver on this host (${driver.kind}) — the DeepSeek rows drive cannot run here`)
  process.exit(1)
}
if (!existsSync(DIST)) {
  console.error(`${DIST} missing — bun run build.ts first`)
  process.exit(1)
}

const DEAD = 'http://127.0.0.1:9'
const KEY = 'sk-deepseek-fixture-live-rows-000001'
const scratch = mkdtempSync(join(tmpdir(), 'deepseek-live-rows-'))
if (OUT) mkdirSync(OUT, { recursive: true })

const PIN_DATE = /observedAt: '(\d{4}-\d{2}-\d{2})'/.exec(readFileSync(PINS, 'utf8'))?.[1] ?? ''

async function startFixture(mode: string, ledger: string): Promise<{ port: number; stop: () => void }> {
  const child = spawn(process.execPath, ['run', FIXTURE, mode, ledger], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString())
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
    child.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  })
  return { port, stop: () => child.kill('SIGTERM') }
}

function childEnv(home: string, tag: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(scratch, `daemon-${tag}`),
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_BASE_URL: DEAD,
    BROWSER: 'true',
    DEEPSEEK_API_KEY: KEY,
    MERCURY_DEEPSEEK_API_BASE: `http://127.0.0.1:${port}`,
  }
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'HF_TOKEN',
    'ZAI_API_KEY',
    'MOONSHOT_API_KEY',
    'MERCURY_MODEL',
    'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
    'NODE_ENV',
    'CI',
  ]) {
    delete env[key]
  }
  return env
}

interface DriveResult {
  status: number | null
  marks: Map<string, string>
  final: string
  stderr: string
}
function drive(tag: string, home: string, port: number, sends: unknown[], total: number): DriveResult {
  const grid = join(scratch, `${tag}-grid.json`)
  const cfgPath = join(scratch, `${tag}-vshot.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', DIST], sends, total, cols: 120, rows: 40, out: grid, title: tag }))
  const res = spawnSync(driver.python, [VSHOT, cfgPath], {
    encoding: 'utf-8',
    env: childEnv(home, tag, port),
    cwd: ROOT,
    timeout: vshotBudgetMs(180_000),
  })
  const marks = new Map<string, string>()
  let final = ''
  if (existsSync(grid)) {
    const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
      grid?: Array<Array<{ c: string }>>
      marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
    }
    const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
    for (const m of payload.marks ?? []) marks.set(m.label, text(m.grid))
    final = payload.grid ? text(payload.grid) : ''
  }
  if (OUT) {
    for (const [label, screen] of marks) writeFileSync(join(OUT, `${tag}-${label}.txt`), screen + '\n')
    writeFileSync(join(OUT, `${tag}-final.txt`), final + '\n')
  }
  return { status: res.status, marks, final, stderr: (res.stderr ?? '').trim() }
}

const lines = (screen: string, needle: string): string => screen.split('\n').filter(l => l.includes(needle)).join(' · ')
const groupLine = (screen: string, heading: string): string => {
  const ls = screen.split('\n')
  const at = ls.findIndex(l => l.includes(heading))
  return at >= 0 ? (ls[at + 1] ?? '') : ''
}
const ledgerHits = (ledger: string): number =>
  existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(l => l.includes('GET /models')).length : 0
function dumpOnRed(tag: string, before: number, res: DriveResult): void {
  if (failures === before) return
  for (const [label, screen] of res.marks) {
    console.log(`\n──── ${tag} · mark "${label}" ────`)
    console.log(screen.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n'))
  }
  console.log(`\n──── ${tag} · final ────`)
  console.log(res.final.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '').join('\n'))
  if (res.stderr) console.log(`\n──── ${tag} · stderr tail ────\n${res.stderr.slice(-600)}`)
}

const seededHome = (name: string, settings?: Record<string, unknown>): string => {
  const home = join(scratch, name)
  seedFirstRun(home, [ROOT])
  if (settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  return home
}

const PICKER_REGION = [0, 0, 64, 40]
const ESC = '\x1b'
const END = '\x1b[F'
const UP = '\x1b[A'
const openSends: unknown[] = [
  { atTick: 40, awaitText: '↑↓ choose', minTick: 3, requireAwait: true, awaitSettleTicks: 2, data: '\r' },
  { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
  { requireAwait: true, awaitText: '❯ /model', awaitStableTicks: 2, data: '' },
  { afterPrevTicks: 2, data: '\r' },
]

console.log('============================================================')
console.log(' the DeepSeek rows — the live list, the pins standing in, the alias')
console.log(`   bundle: ${DIST}`)
console.log('============================================================')

const daemonDirs: string[] = []

console.log('\n[1] the live list: the fixture names three ids and the picker paints them')
{
  const before = failures
  const ledger = join(scratch, 'live-ledger.log')
  const fixture = await startFixture('live', ledger)
  const home = seededHome('home-live')
  daemonDirs.push(join(scratch, 'daemon-live'))
  const res = drive('live', home, fixture.port, [
    ...openSends,
    { requireAwait: true, awaitText: '│ │ DeepSeek V4 Pro', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'open', data: END },
    { requireAwait: true, awaitText: 'Deepseek Fixture Next', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'live', data: UP + UP },
    { requireAwait: true, awaitText: 'deepseek-flash · model IDs', awaitStableTicks: 2, awaitStableRegion: PICKER_REGION, mark: 'flash', data: ESC },
    { afterPrevTicks: 3, data: '' },
  ], 220)
  fixture.stop()
  check('live: the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${res.stderr.slice(-300)}`)
  const live = res.marks.get('live') ?? ''
  const flash = res.marks.get('flash') ?? ''
  check('live: the fixture answered the model list at least once (the ledger)', ledgerHits(ledger) >= 1, `hits ${ledgerHits(ledger)}`)
  check('live: the two pinned rows paint with their pin labels', live.includes('DeepSeek V4 Pro') && live.includes('DeepSeek V4.1 Flash'), lines(live, 'DeepSeek'))
  check('live: the unpinned live id paints with its mechanical name, after the pinned rows', live.indexOf('Deepseek Fixture Next') > live.indexOf('DeepSeek V4.1 Flash'), lines(live, 'Deepseek'))
  check("live: the unpinned row paints the conservative window Mercury budgets for an unrecorded id (200k), never a pin's", lines(live, 'Deepseek Fixture Next').includes('200k ctx') && !lines(live, 'Deepseek Fixture Next').includes('1M ctx'), lines(live, 'Deepseek Fixture Next'))
  check('live: the pinned rows keep their pinned window', lines(live, 'DeepSeek V4 Pro                ').includes('1M ctx') || lines(live, '│ DeepSeek V4 Pro').includes('1M ctx'), lines(live, 'DeepSeek V4 Pro'))
  check('live: the group line names the key and no frontier row stands under any heading', groupLine(live, 'DEEPSEEK MODELS').includes('key present') && !live.includes('frontier:'), groupLine(live, 'DEEPSEEK MODELS'))
  check('live: the Flash row persists the current id (deepseek-flash on the id line)', flash.includes('deepseek-flash · model IDs'), lines(flash, 'model IDs'))
  check('live: the retired id is nowhere on the screen', !live.includes('deepseek-v4-flash') && !flash.includes('deepseek-v4-flash'))
  dumpOnRed('live', before, res)
}

console.log('\n[2] the pins stand in: the fixture refuses the list (HTTP 503)')
{
  const before = failures
  const ledger = join(scratch, 'refuse-ledger.log')
  const fixture = await startFixture('refuse', ledger)
  const home = seededHome('home-refuse')
  daemonDirs.push(join(scratch, 'daemon-refuse'))
  const res = drive('refuse', home, fixture.port, [
    ...openSends,
    { requireAwait: true, awaitText: '│ │ DeepSeek V4 Pro', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'open', data: END },
    { requireAwait: true, awaitText: '│ │ Custom endpoint', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'rows', data: UP + UP },
    { requireAwait: true, awaitText: 'deepseek-v4-pro · model IDs', awaitStableTicks: 2, awaitStableRegion: PICKER_REGION, mark: 'pro', data: ESC },
    { afterPrevTicks: 3, data: '' },
  ], 200)
  fixture.stop()
  check('refuse: the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${res.stderr.slice(-300)}`)
  const rows = res.marks.get('rows') ?? ''
  check('refuse: the list was asked for (the ledger records the refused request)', ledgerHits(ledger) >= 1, `hits ${ledgerHits(ledger)}`)
  check('refuse: the two dated pins stand in', rows.includes('DeepSeek V4 Pro') && rows.includes('DeepSeek V4.1 Flash'), lines(rows, 'DeepSeek'))
  check('refuse: no fixture row is invented', !rows.includes('Deepseek Fixture Next'))
  check(`refuse: the group line names the key alone — no frontier row, no date (${PIN_DATE}), no live count`, groupLine(rows, 'DEEPSEEK MODELS').includes('key present') && !rows.includes('frontier:') && !groupLine(rows, 'DEEPSEEK MODELS').includes(PIN_DATE) && !groupLine(rows, 'DEEPSEEK MODELS').includes('models live'), groupLine(rows, 'DEEPSEEK MODELS'))
  dumpOnRed('refuse', before, res)
}

console.log('\n[3] the alias: a saved deepseek-v4-flash setting opens on the Flash row as deepseek-flash')
{
  const before = failures
  const ledger = join(scratch, 'alias-ledger.log')
  const fixture = await startFixture('live', ledger)
  const home = seededHome('home-alias', { model: 'deepseek-v4-flash' })
  daemonDirs.push(join(scratch, 'daemon-alias'))
  const res = drive('alias', home, fixture.port, [
    ...openSends,
    { requireAwait: true, awaitText: '│ │ DeepSeek V4.1 Flash', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'alias', data: ESC },
    { afterPrevTicks: 3, data: '' },
  ], 160)
  fixture.stop()
  check('alias: the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${res.stderr.slice(-300)}`)
  const alias = res.marks.get('alias') ?? ''
  check('alias: the picker opens on the Flash row, marked current', lines(alias, 'DeepSeek V4.1 Flash').includes('current'), lines(alias, 'DeepSeek V4.1 Flash'))
  check('alias: the id line paints the current id (deepseek-flash), never the retired one', alias.includes('deepseek-flash · model IDs') && !alias.includes('deepseek-v4-flash'), lines(alias, 'model IDs'))
  check('alias: the saved setting still holds the retired spelling (nothing rewritten on open)', readFileSync(join(home, 'settings.json'), 'utf8').includes('deepseek-v4-flash'))
  dumpOnRed('alias', before, res)
}

for (const dir of daemonDirs) {
  process.env.MERCURY_DAEMON_DIR = dir
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5_000 }).catch(() => undefined)
}
if (!OUT) rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ DEEPSEEK ROWS — LIVE LIST, PINS, ALIAS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
