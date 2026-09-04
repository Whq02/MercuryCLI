#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('prove-git-facts-drive: the posix PTY engine — skipped on win32')
  process.exit(0)
}

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'git-facts-drive-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const FIX = join(SCRATCH, 'fixture')
const SURFACES = (process.env.MERCURY_GIT_DRIVE_SURFACES ?? 'face,chat,board').split(',').map(s => s.trim()).filter(s => s === 'face' || s === 'chat' || s === 'board') as Array<'face' | 'chat' | 'board'>
const FACE_TICKS = Number(process.env.MERCURY_GIT_DRIVE_FACE_TICKS ?? 600)
const IDLE_TICKS = Number(process.env.MERCURY_GIT_DRIVE_IDLE_TICKS ?? 200)
const SETTLE_TICKS = 100
const TOUCH_TICKS = 25
const BOUND_TICKS = 175
const IDLE_CEILING_PER_120S = 2

const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.email=prover@example.invalid', '-c', 'user.name=prover', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function makeRepo(dir: string, files: number): void {
  mkdirSync(dir, { recursive: true })
  const dirs = 50
  let n = 0
  for (let d = 0; d < dirs; d++) {
    const dd = join(dir, 'src', `mod${String(d).padStart(2, '0')}`)
    mkdirSync(dd, { recursive: true })
    for (let f = 0; f < Math.ceil(files / dirs) && n < files; f++, n++) {
      writeFileSync(join(dd, `file${String(f).padStart(3, '0')}.ts`), `// module ${d} file ${f}\nexport const v${f} = ${(d * 7919 + f * 104729) % 1000003}\n`.repeat(4))
    }
  }
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","scripts":{"test":"true"}}\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'seed')
}
function countObjects(dir: string): { count: number; size: number } {
  const out = git(dir, 'count-objects', '-v')
  const num = (k: string): number => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(out)?.[1] ?? NaN)
  return { count: num('count'), size: num('size') }
}

makeRepo(FIX, 5000)
mkdirSync(TEMPLATE, { recursive: true })
const SHIM_DIR = join(SCRATCH, 'shim')
mkdirSync(SHIM_DIR)
writeFileSync(
  join(SHIM_DIR, 'git'),
  [
    '#!/bin/bash',
    'start=$(perl -MTime::HiRes=time -e \'printf "%d", time*1000\')',
    `"${REAL_GIT}" "$@"`,
    'rc=$?',
    `printf '%s\\t%s\\t%s\\t%s\\n' "$start" "$PPID" "$PWD" "$*" >> "\${GIT_SHIM_LOG:-/dev/null}"`,
    'exit $rc',
    '',
  ].join('\n'),
)
chmodSync(join(SHIM_DIR, 'git'), 0o755)
const PRELOAD = join(SCRATCH, 'sync-census.cjs')
writeFileSync(
  PRELOAD,
  [
    "'use strict'",
    "const cp = require('child_process')",
    "const fs = require('fs')",
    "const LOG = process.env.GIT_SYNC_LOG",
    "if (LOG) {",
    "  for (const fn of ['execFileSync', 'spawnSync', 'execSync']) {",
    "    const orig = cp[fn]",
    "    cp[fn] = function (file, ...rest) {",
    "      try {",
    "        const argv = fn === 'execSync' ? String(file) : `${String(file)} ${Array.isArray(rest[0]) ? rest[0].join(' ') : ''}`",
    "        if (/(^|\\/)git(\\s|$)/.test(argv)) fs.appendFileSync(LOG, `${Date.now()}\\t${process.pid}\\t${fn}\\t${argv}\\n`)",
    "      } catch {}",
    "      return orig.call(this, file, ...rest)",
    "    }",
    "  }",
    "}",
    '',
  ].join('\n'),
)

process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-git-facts-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
seedFirstRun(TEMPLATE, [FIX])

const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const BOARD = 'SESSION CONCOURSE'
const SHIFT_LEFT = '\x1b[1;2D'
const WARM_TICKS = 25
type Send = Record<string, unknown>
const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
const QUIT: Send[] = [
  { afterPrevTicks: 3, data: '\x03' },
  { afterPrevTicks: 2, data: '\x03' },
  { afterPrevTicks: 4, data: '\x04' },
  { afterPrevTicks: 2, data: '\x04' },
]
type Row = { start: number; ppid: string; cwd: string; argv: string }
type Surface = {
  surface: string
  idleRows: Row[]
  idleMinutes: number
  touchRows: Row[]
  touchAt: number | null
  before: { count: number; size: number }
  after: { count: number; size: number }
  endReason: unknown
  status: string
  syncBoot: number
  syncIdle: number
  syncTouch: number
}

function reapHome(home: string): void {
  for (const rec of Object.values(readSessionWorkers(join(home, 'daemon')))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
  }
}

async function idleOn(surface: 'face' | 'chat' | 'board'): Promise<Surface> {
  const home = join(SCRATCH, `home-${surface}`)
  cpSync(TEMPLATE, home, { recursive: true })
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const shimLog = join(SCRATCH, `git-${surface}.log`)
  writeFileSync(shimLog, '')
  const syncLog = join(SCRATCH, `sync-${surface}.log`)
  writeFileSync(syncLog, '')
  const idleTicks = surface === 'face' ? FACE_TICKS : IDLE_TICKS
  const warmTicks = surface === 'face' ? 0 : WARM_TICKS + 60
  const idle: Send[] = [
    { afterPrevTicks: SETTLE_TICKS, data: '', mark: 'surface' },
    { afterPrevTicks: idleTicks + BOUND_TICKS + warmTicks, data: '', mark: 'surface-end' },
    { afterPrevTicks: TOUCH_TICKS, data: '', mark: 'touch-end' },
    ...QUIT,
  ]
  const sends: Send[] =
    surface === 'face'
      ? [g(READY_LINE, '', { awaitSettleTicks: 4 }), ...idle]
      : surface === 'chat'
        ? [g(READY_LINE, ''), { afterPrevTicks: WARM_TICKS, data: '\r' }, g(COMPOSER, '', { awaitSettleTicks: 4 }), ...idle]
        : [g(READY_LINE, ''), { afterPrevTicks: WARM_TICKS, data: '\r' }, g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }), g(BOARD, '', { awaitSettleTicks: 4 }), ...idle]
  const cfgPath = join(SCRATCH, `cfg-${surface}.json`)
  const outPath = join(SCRATCH, `grid-${surface}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd: FIX, cols: 120, rows: 40, sends, total: SETTLE_TICKS + idleTicks + BOUND_TICKS + warmTicks + TOUCH_TICKS + 300, out: outPath }))
  const before = countObjects(FIX)
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
      GIT_SHIM_LOG: shimLog,
      NODE_OPTIONS: `--require=${PRELOAD}`,
      GIT_SYNC_LOG: syncLog,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_OPERATOR: 'sam',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let tail = ''
  child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
  child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
  const touchAtMs = await new Promise<number | null>(resolvePromise => {
    const delay = (BOUND_TICKS + warmTicks + SETTLE_TICKS + idleTicks) * 200
    const timer = setTimeout(() => {
      try {
        writeFileSync(join(FIX, 'outside.txt'), 'moved from outside\n')
        git(FIX, 'add', 'outside.txt')
        resolvePromise(Date.now())
      } catch {
        resolvePromise(null)
      }
    }, delay)
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise(null)
    })
  })
  await new Promise<void>(r => (child.exitCode !== null ? r() : child.on('close', () => r())))
  const after = countObjects(FIX)
  reapHome(home)
  try {
    await api.close()
  } catch {
  }
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
  } catch {
  }
  const receipts = (payload.sendReceipts as Array<{ atTick: number; ts: number }> | undefined) ?? []
  const idx = sends.findIndex(s => s.mark === 'surface')
  const idxEnd = sends.findIndex(s => s.mark === 'surface-end')
  const winStart = receipts[idx]?.ts
  const winEnd = receipts[idxEnd]?.ts
  const all: Row[] = readFileSync(shimLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [start = '0', ppid = '', cwd = '', ...argv] = l.split('\t')
      return { start: Number(start), ppid, cwd, argv: argv.join('\t') }
    })
  const idleEnd = touchAtMs ?? winEnd
  const idleRows = winStart !== undefined && idleEnd !== undefined ? all.filter(r => r.start >= winStart && r.start < idleEnd) : []
  const idleMinutes = winStart !== undefined && idleEnd !== undefined ? (idleEnd - winStart) / 60000 : 0
  if (idleMinutes === 0) console.log(`  (${surface}: no idle window — ${String(payload.endReason)} · ${tail.slice(-300)})`)
  const touchRows = touchAtMs !== null ? all.filter(r => r.start >= touchAtMs && r.start <= touchAtMs + 2_000) : []
  const syncRows = readFileSync(syncLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [ts = '0', pid = '', fn = '', ...argv] = l.split('\t')
      return { ts: Number(ts), pid, fn, argv: argv.join('\t') }
    })
  const syncBoot = syncRows.length
  const syncIdle = winStart !== undefined && winEnd !== undefined ? syncRows.filter(r => r.ts >= winStart && r.ts <= winEnd).length : 0
  const syncTouch = touchAtMs !== null ? syncRows.filter(r => r.ts >= touchAtMs && r.ts <= touchAtMs + 4_000).length : 0
  try {
    git(FIX, 'reset', '-q', '--', 'outside.txt')
    rmSync(join(FIX, 'outside.txt'), { force: true })
  } catch {
  }
  const status = git(FIX, 'status', '--porcelain').trim()
  return { surface, idleRows, idleMinutes, touchRows, touchAt: touchAtMs, before, after, endReason: payload.endReason, status, syncBoot, syncIdle, syncTouch }
}

function shapeOf(argv: string): string {
  const toks = argv.split(' ')
  const out: string[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t === '-C' || t === '-c') {
      i++
      continue
    }
    if (t === '--no-optional-locks') continue
    out.push(t.startsWith('/') ? '<path>' : t)
  }
  return out.slice(0, 5).join(' ')
}

const results: Surface[] = []
for (const surface of SURFACES) {
  const secs = ((surface === 'face' ? FACE_TICKS : IDLE_TICKS) * 0.2).toFixed(0)
  console.log(`\n── ${surface}: booting the bundle on the 5,000-file fixture, idling ${secs} s, then moving the index from outside`)
  results.push(await idleOn(surface))
}

console.log('\n== git invocations inside each idle window (the after-picture) ==')
for (const r of results) {
  const byShape = new Map<string, number>()
  for (const x of r.idleRows) byShape.set(shapeOf(x.argv), (byShape.get(shapeOf(x.argv)) ?? 0) + 1)
  const ceiling = Math.max(1, Math.round((IDLE_CEILING_PER_120S * r.idleMinutes) / 2))
  console.log(`  ${r.surface}: idle window ${r.idleMinutes.toFixed(2)} min · ${r.idleRows.length} git calls · objects ${r.before.count}→${r.after.count} · end=${String(r.endReason)}`)
  for (const [k, n] of [...byShape.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${k}`)
  check(`G0 ${r.surface}: the idle window was captured (≥ 0.5 min)`, r.idleMinutes >= 0.5, `${r.idleMinutes.toFixed(2)} min`)
  check(`G1 ${r.surface}: at most ${IDLE_CEILING_PER_120S} git processes per 120 s at idle (${ceiling} for this window)`, r.idleRows.length <= ceiling, `${r.idleRows.length} in ${r.idleMinutes.toFixed(2)} min: ${[...byShape.keys()].join(' | ')}`)
  const statusProbes = r.touchRows.filter(x => /^status --porcelain/.test(x.argv)).length
  const upstreamProbes = r.touchRows.filter(x => /^rev-list --count/.test(x.argv)).length
  console.log(`      after the index move: ${r.touchRows.length} git call(s) within 2 s — ${r.touchRows.map(x => shapeOf(x.argv)).join(' | ') || '(none)'}`)
  check(`G2 ${r.surface}: the index move was made inside the capture`, r.touchAt !== null)
  check(`G2 ${r.surface}: exactly one status probe within 2 s of the index move`, statusProbes === 1, `${statusProbes}`)
  check(`G2 ${r.surface}: no upstream probe for an index move`, upstreamProbes === 0, `${upstreamProbes}`)
  check(`G3 ${r.surface}: the repository gained no object beyond the prover's own blob`, r.after.count - r.before.count <= 1, `${r.before.count}→${r.after.count}`)
  check(`G3 ${r.surface}: the launch folder's git status is empty after the surface`, r.status === '', r.status.split('\n').slice(0, 4).join(' | '))
  console.log(`      synchronous git spawns (every process): boot ${r.syncBoot} · idle window ${r.syncIdle} · after the index move ${r.syncTouch}`)
  check(`G4 ${r.surface}: nothing spawns git synchronously inside the idle window`, r.syncIdle === 0, `${r.syncIdle}`)
  check(`G4 ${r.surface}: the index move is answered without a synchronous spawn`, r.syncTouch === 0, `${r.syncTouch}`)
}

if (process.env.MERCURY_GIT_DRIVE_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-git-facts-drive: ALL LAWS HOLD' : `\nprove-git-facts-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
