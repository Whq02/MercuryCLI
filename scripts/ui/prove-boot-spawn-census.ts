#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const PRELOAD = join(ROOT, 'scripts', 'ui', 'fixtures', 'spawn-census', 'preload.cjs')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] the PTY capture driver is unavailable here — ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'spawn-census-')))
const FX = join(SCRATCH, 'fx')
const HOME_DIR = join(SCRATCH, 'home')
const LOGS = join(SCRATCH, 'census')
const SHIM = join(SCRATCH, 'bin')
for (const d of [FX, HOME_DIR, LOGS, SHIM, join(FX, 'src')]) mkdirSync(d, { recursive: true })
writeFileSync(join(FX, 'package.json'), '{"name":"fx","private":true}\n')
writeFileSync(join(FX, 'pyproject.toml'), '[project]\nname = "fx"\nversion = "0.1.0"\n')
writeFileSync(join(FX, 'README.md'), '# fx\n')
writeFileSync(join(FX, '.gitignore'), 'node_modules/\n')
writeFileSync(join(FX, 'src', 'app.ts'), 'export const one = 1\n')
writeFileSync(join(FX, 'src', 'main.py'), 'print("one")\n')
const git = (args: string[]): boolean =>
  spawnSync('git', ['-C', FX, '-c', 'user.email=census@example.invalid', '-c', 'user.name=census', ...args], { stdio: 'ignore' }).status === 0
check('the fixture repository has a commit', git(['init', '-q']) && git(['add', '.']) && git(['commit', '-q', '-m', 'seed']))
writeFileSync(join(SHIM, 'ruff'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ruff 0.6.9"; exit 0; fi\nsleep 30\n')
writeFileSync(join(SHIM, 'pyright-langserver'), '#!/bin/sh\nsleep 30\n')
chmodSync(join(SHIM, 'ruff'), 0o755)
chmodSync(join(SHIM, 'pyright-langserver'), 0o755)
seedFirstRun(HOME_DIR, [FX])

const REPLY = 'CENSUS-REPLY-OK'
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: REPLY })))
let firstRequestTs: number | null = null
const requestClock = setInterval(() => {
  if (firstRequestTs === null && api.messageRequests().length > 0) firstRequestTs = Date.now()
}, 5)

const READY = '↵ start  ·  m menu  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const ASK = 'census: hello'
const sends = [
  { awaitText: READY, atTick: 150, data: '', mark: 'face-ready' },
  { awaitText: READY, awaitSettleTicks: 30, atTick: 230, data: '\r', mark: 'enter' },
  { awaitText: COMPOSER, awaitSettleTicks: 5, atTick: 310, data: ASK, mark: 'chat-ready' },
  { awaitText: ASK, awaitSettleTicks: 3, atTick: 350, data: '\r', mark: 'submit' },
  { awaitText: REPLY, awaitSettleTicks: 5, atTick: 470, data: '', mark: 'replied' },
]
const cfgPath = join(SCRATCH, 'cfg.json')
const outPath = join(SCRATCH, 'grid.json')
writeFileSync(
  cfgPath,
  JSON.stringify({ argv: ['node', DIST, '--model', 'claude-sonnet-5'], cwd: FX, cols: 120, rows: 40, sends, readyText: [REPLY], readySettleTicks: 15, total: 540, out: outPath }),
)
const env: Record<string, string | undefined> = {
  ...process.env,
  PATH: `${SHIM}:${process.env.PATH ?? ''}`,
  NODE_OPTIONS: `--require=${PRELOAD}`,
  SPAWN_CENSUS_DIR: LOGS,
  MERCURY_CONFIG_DIR: HOME_DIR,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_OPERATOR: 'sam',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_LIVE_GLYPHS: '0',
}
for (const k of ['NODE_ENV', 'CI', 'MERCURY_DAEMON_DIR', 'MERCURY_CONCOURSE']) delete env[k]
const stderr: string[] = []
await new Promise<void>((resolve, reject) => {
  const child = spawn(driver.python, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(240_000))
  child.stderr?.on('data', c => stderr.push(String(c)))
  child.on('error', reject)
  child.on('close', () => {
    clearTimeout(deadline)
    resolve()
  })
})
clearInterval(requestClock)
await sleep(3_000)
const leftovers = (spawnSync('pgrep', ['-f', HOME_DIR], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').filter(Boolean).map(Number)
for (const pid of leftovers) { try { process.kill(pid, 'SIGTERM') } catch {} }
await sleep(3_000)
for (const pid of leftovers) { try { process.kill(pid, 'SIGKILL') } catch {} }
await api.close()

type Grid = Array<Array<{ c?: string }>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => c.c ?? ' ').join('').trimEnd()).join('\n')
check('the capture wrote a grid', existsSync(outPath), stderr.join('').slice(-400))
const payload = existsSync(outPath)
  ? (JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: Array<{ ts: number }>; endReason?: string })
  : { grid: [] as Grid }
const marks = new Map<string, string>()
const markTs = new Map<string, number>()
;(payload.marks ?? []).forEach((m, i) => {
  marks.set(m.label, gridText(m.grid))
  const receipt = payload.sendReceipts?.[i]
  if (receipt) markTs.set(m.label, receipt.ts)
})
check('the face painted (the ready line is on the face-ready frame)', (marks.get('face-ready') ?? '').includes(READY), (marks.get('face-ready') ?? '').slice(0, 300))
check('the chat opened (the composer is on the chat-ready frame)', (marks.get('chat-ready') ?? '').includes(COMPOSER))
check('the turn was submitted and answered (the reply is on the replied frame)', (marks.get('replied') ?? '').includes(REPLY), (marks.get('replied') ?? '').slice(-600))
const readyTs = markTs.get('face-ready') ?? Number.POSITIVE_INFINITY
const submitTs = markTs.get('submit') ?? Number.POSITIVE_INFINITY
check('the first wire request followed the submit', firstRequestTs !== null && firstRequestTs >= submitTs, `submit ${submitTs} · first request ${firstRequestTs}`)
const turnEnd = firstRequestTs ?? Number.POSITIVE_INFINITY

interface Spawn { t: number; kind: string; sync: boolean; cmd: string; args: string[]; ms?: number; err?: string }
interface Stall { t: number; ms: number; overlap: string[] }
interface TsRead { t: number; path: string; ms: number }
type Role = 'interface' | 'daemon' | 'runner' | 'sidecar' | 'other'
interface Proc { pid: number; argv: string[]; role: Role; spawns: Spawn[]; stalls: Stall[]; tsReads: TsRead[] }

function roleOf(argv: string[]): Role {
  const rest = argv.slice(2)
  if (rest.includes('daemon')) return 'daemon'
  if (rest.includes('--lsp-ts-sidecar') || rest.includes('--lsp-web-sidecar')) return 'sidecar'
  if (rest.includes('-p')) return 'runner'
  if ((argv[1] ?? '').endsWith('mercury.mjs')) return 'interface'
  return 'other'
}
const procs: Proc[] = []
for (const name of readdirSync(LOGS)) {
  if (!name.startsWith('proc-')) continue
  const meta = JSON.parse(readFileSync(join(LOGS, name), 'utf8')) as { pid: number; argv: string[] }
  const proc: Proc = { pid: meta.pid, argv: meta.argv, role: roleOf(meta.argv), spawns: [], stalls: [], tsReads: [] }
  const log = join(LOGS, `census-${meta.pid}.jsonl`)
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const w = JSON.parse(line) as { spawns: Spawn[]; stalls: Stall[]; tsReads: TsRead[] }
      proc.spawns.push(...w.spawns)
      proc.stalls.push(...w.stalls)
      proc.tsReads.push(...w.tsReads)
    }
  }
  procs.push(proc)
}
const byRole = (role: Role): Proc[] => procs.filter(p => p.role === role)
const iface = byRole('interface')[0]
check('the census saw the interface, the daemon and the warm runner', !!iface && byRole('daemon').length > 0 && byRole('runner').length > 0, procs.map(p => `${p.role}:${p.pid}`).join(' '))

const exe = (s: Spawn): string => basename(s.cmd).toLowerCase()
const isGit = (s: Spawn): boolean => exe(s) === 'git' || exe(s) === 'git.exe'
const isLookup = (s: Spawn): boolean => exe(s) === 'which' || exe(s) === 'where.exe' || exe(s) === 'where'
const isSearch = (s: Spawn): boolean => /^rg(\.exe)?$/.test(exe(s)) || s.cmd.includes('ripgrep')
const isEstateWalk = (s: Spawn): boolean => isSearch(s) && s.args.includes('--files') && s.args.includes('*.md')
const isInterpreterProbe = (s: Spawn): boolean => /^(python|node)/.test(exe(s)) && s.args[0] === '--version'
const isOwnerWatch = (s: Spawn): boolean => exe(s) === 'ps' && s.args[0] === '-o' && s.args[1] === 'lstart='
const describe = (s: Spawn): string => `${s.kind} ${s.cmd} ${s.args.join(' ')}${s.ms !== undefined ? ` (${s.ms} ms)` : ''}${s.err ? ` [${s.err}]` : ''}`
const spawnStall = (st: Stall): string | undefined =>
  st.overlap.find(label => /^(spawnSync|execFileSync|execSync) /.test(label) && !/^(spawnSync|execFileSync|execSync) (\S*\/)?git(\.exe)? /.test(label))

console.log('\n── the census (per process) ──')
for (const p of procs) {
  const sync = p.spawns.filter(s => s.sync)
  const before = p.role === 'interface' ? sync.filter(s => s.t < readyTs) : sync
  const after = p.role === 'interface' ? sync.filter(s => s.t >= readyTs) : []
  const asyncBefore = p.spawns.filter(s => !s.sync && s.t < readyTs)
  const maxStall = p.stalls.reduce<Stall | null>((m, st) => (m === null || st.ms > m.ms ? st : m), null)
  console.log(`  ${p.role} (pid ${p.pid})`)
  console.log(`    sync before ready: ${before.length} (git ${before.filter(isGit).length}) · sync after ready: ${after.length} (git ${after.filter(isGit).length}) · async before ready: ${asyncBefore.length} (estate walks ${asyncBefore.filter(isEstateWalk).length}, interpreter probes ${asyncBefore.filter(isInterpreterProbe).length})`)
  console.log(`    windows budget: boot ${(before.length + asyncBefore.length) * 60} ms (${before.length + asyncBefore.length} × 60) · whole capture ${p.spawns.length * 60} ms (${p.spawns.length} × 60)`)
  console.log(`    max stall: ${maxStall ? `${maxStall.ms} ms [${maxStall.overlap.join(' | ').slice(0, 200)}]` : 'none'} · typescript reads: ${p.tsReads.length}`)
  for (const s of sync) console.log(`      sync ${p.role === 'interface' ? (s.t < readyTs ? 'before' : s.t >= submitTs && s.t <= turnEnd ? 'turn  ' : 'after ') : '      '} ${describe(s)}`)
}

console.log('\n── the pins ──')
if (iface) {
  const sync = iface.spawns.filter(s => s.sync)
  const before = sync.filter(s => s.t < readyTs)
  const after = sync.filter(s => s.t >= readyTs)
  const turn = sync.filter(s => s.t >= submitTs && s.t <= turnEnd)
  const beforeOther = before.filter(s => !isGit(s))
  check('interface: at most one synchronous non-git spawn before the face paints', beforeOther.length <= 1, beforeOther.map(describe).join(' · '))
  check('interface: a PATH lookup never spawns a process', sync.filter(isLookup).length === 0 && iface.spawns.filter(isLookup).length === 0, iface.spawns.filter(isLookup).map(describe).join(' · '))
  check('interface: the git facts spawn nothing synchronously before the face paints', before.filter(isGit).length === 0, before.filter(isGit).map(describe).join(' · '))
  check('interface: nothing spawns synchronously after the first paint, git included', after.length === 0, after.map(describe).join(' · '))
  check('interface: the submitted turn spawns nothing synchronously before its first wire request, git included', turn.length === 0, turn.map(describe).join(' · '))
  check('interface: the typescript compiler file is never read by the interface', iface.tsReads.length === 0, iface.tsReads.map(r => `${r.path} (${r.ms} ms)`).join(' · '))
}
for (const role of ['daemon', 'runner'] as const) {
  for (const p of byRole(role)) {
    const other = p.spawns.filter(s => s.sync && !isGit(s) && !(role === 'daemon' && isOwnerWatch(s)))
    const watch = role === 'daemon' ? p.spawns.filter(s => s.sync && isOwnerWatch(s)).length : 0
    check(`${role}: never spawns synchronously (non-git${role === 'daemon' ? `; the owner watch's ${watch} sync ps read(s) belong to its own owner` : ''})`, other.length === 0, other.map(describe).join(' · '))
  }
}
for (const p of procs) {
  const attributed = p.stalls.filter(st => st.ms > 200 && spawnStall(st) !== undefined)
  check(`${p.role}: no stall over 200 ms is attributed to a spawn`, attributed.length === 0, attributed.map(st => `${st.ms} ms ← ${spawnStall(st)}`).join(' · '))
  const walks = p.spawns.filter(isEstateWalk)
  check(`${p.role}: the configuration estate walk spawns no search process`, walks.length === 0, `${walks.length} walk(s): ${walks.slice(0, 3).map(describe).join(' · ')}`)
  const syncProbes = p.spawns.filter(s => s.sync && isInterpreterProbe(s))
  const asyncProbes = p.spawns.filter(s => !s.sync && isInterpreterProbe(s))
  check(`${p.role}: the interpreter probe is asynchronous and runs at most once`, syncProbes.length === 0 && asyncProbes.length <= 1, [...syncProbes, ...asyncProbes].map(describe).join(' · '))
}

if (process.env.CENSUS_KEEP === '1') console.log(`\n  kept: ${SCRATCH}`)
else rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-boot-spawn-census: all green' : `\nprove-boot-spawn-census: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
