#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('prove-tree-fingerprint-drive: the posix PTY engine — skipped on win32')
  process.exit(0)
}

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tree-drive-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const FIX = join(SCRATCH, 'fixture')
const IDLE_TICKS = Number(process.env.MERCURY_TREE_DRIVE_IDLE_TICKS ?? 200)
const SETTLE_TICKS = 100
const DIGEST_CEILING_PER_MIN = 1
const TOTAL_CEILING_PER_MIN = 8

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
    `printf '%s\\t%s\\t%s\\n' "$start" "$PWD" "$*" >> "\${GIT_SHIM_LOG:-/dev/null}"`,
    'exit $rc',
    '',
  ].join('\n'),
)
chmodSync(join(SHIM_DIR, 'git'), 0o755)

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
  console.error(`prove-tree-fingerprint-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
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
type Row = { start: number; cwd: string; argv: string }
type Surface = { surface: string; lines: string[]; rows: Row[]; minutes: number; before: { count: number; size: number }; after: { count: number; size: number }; endReason: unknown }

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
  const idle: Send[] = [{ afterPrevTicks: SETTLE_TICKS, data: '', mark: 'surface' }, { afterPrevTicks: IDLE_TICKS, data: '', mark: 'surface-end' }, ...QUIT]
  const sends: Send[] =
    surface === 'face'
      ? [g(READY_LINE, '', { awaitSettleTicks: 4 }), ...idle]
      : surface === 'chat'
        ? [g(READY_LINE, ''), { afterPrevTicks: WARM_TICKS, data: '\r' }, g(COMPOSER, '', { awaitSettleTicks: 4 }), ...idle]
        : [g(READY_LINE, ''), { afterPrevTicks: WARM_TICKS, data: '\r' }, g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }), g(BOARD, '', { awaitSettleTicks: 4 }), ...idle]
  const cfgPath = join(SCRATCH, `cfg-${surface}.json`)
  const outPath = join(SCRATCH, `grid-${surface}.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd: FIX, cols: 120, rows: 40, sends, total: SETTLE_TICKS + IDLE_TICKS + 300, out: outPath }))
  const before = countObjects(FIX)
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
      GIT_SHIM_LOG: shimLog,
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
  await new Promise<void>(r => child.on('close', () => r()))
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
  const grid = (payload.grid as Array<Array<{ c: string }>> | undefined) ?? []
  const lines = grid.map(r => r.map(c => c.c).join('').replace(/\s+$/, ''))
  const receipts = (payload.sendReceipts as Array<{ atTick: number; ts: number }> | undefined) ?? []
  const idx = sends.findIndex(s => s.mark === 'surface')
  const idxEnd = sends.findIndex(s => s.mark === 'surface-end')
  const winStart = receipts[idx]?.ts
  const winEnd = receipts[idxEnd]?.ts
  const all: Row[] = readFileSync(shimLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [start = '0', cwd = '', ...argv] = l.split('\t')
      return { start: Number(start), cwd, argv: argv.join('\t') }
    })
  const rows = winStart !== undefined && winEnd !== undefined ? all.filter(r => r.start >= winStart && r.start <= winEnd) : []
  const minutes = winStart !== undefined && winEnd !== undefined ? (winEnd - winStart) / 60000 : 0
  if (minutes === 0) console.log(`  (${surface}: no idle window — ${String(payload.endReason)} · ${tail.slice(-300)})`)
  return { surface, lines, rows, minutes, before, after, endReason: payload.endReason }
}

const isDigestStep = (argv: string): boolean => /^(read-tree HEAD|add -A -- \.|reset -q -- |write-tree)/.test(argv)
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
for (const surface of ['face', 'chat', 'board'] as const) {
  console.log(`\n── ${surface}: booting the bundle on the 5,000-file fixture, idling ${(IDLE_TICKS * 0.2).toFixed(0)} s`)
  results.push(await idleOn(surface))
}

console.log('\n== git invocations inside each idle window (the after-picture) ==')
for (const r of results) {
  const perMin = (n: number): number => n / Math.max(r.minutes, 0.01)
  const digests = r.rows.filter(x => x.argv.startsWith('add -A -- .')).length
  const byShape = new Map<string, number>()
  for (const x of r.rows) byShape.set(shapeOf(x.argv), (byShape.get(shapeOf(x.argv)) ?? 0) + 1)
  console.log(`  ${r.surface}: window ${r.minutes.toFixed(2)} min · ${r.rows.length} git calls (${perMin(r.rows.length).toFixed(1)}/min) · ${digests} digest scans (${perMin(digests).toFixed(1)}/min) · objects ${r.before.count}→${r.after.count} · end=${String(r.endReason)}`)
  for (const [k, n] of [...byShape.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(3)}  ${k}`)
  check(`D0 ${r.surface}: the idle window was captured (≥ 0.5 min)`, r.minutes >= 0.5, `${r.minutes.toFixed(2)} min`)
  check(`D1 ${r.surface}: the fingerprint runs at most ${DIGEST_CEILING_PER_MIN}/min at idle`, perMin(digests) <= DIGEST_CEILING_PER_MIN, `${digests} in ${r.minutes.toFixed(2)} min`)
  check(`D1 ${r.surface}: every digest step that ran was one of the four (no stray shapes)`, r.rows.filter(x => isDigestStep(x.argv)).every(x => x.cwd === FIX))
  check(`D2 ${r.surface}: all git calls stay under ${TOTAL_CEILING_PER_MIN}/min at idle`, perMin(r.rows.length) <= TOTAL_CEILING_PER_MIN, `${r.rows.length} in ${r.minutes.toFixed(2)} min`)
  check(`D3 ${r.surface}: the repository gained no object`, r.after.count === r.before.count && r.after.size === r.before.size, `${r.before.count}→${r.after.count}`)
}
const chat = results.find(r => r.surface === 'chat')
check('D4 the chat frame carries no vfy word on a measurable tree', chat !== undefined && !chat.lines.some(l => /\bvfy\b/.test(l)), chat?.lines.filter(l => /\bvfy\b/.test(l)).join(' | '))

if (process.env.MERCURY_TREE_DRIVE_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-tree-fingerprint-drive: ALL LAWS HOLD' : `\nprove-tree-fingerprint-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
