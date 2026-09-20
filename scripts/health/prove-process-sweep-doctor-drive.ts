#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first or name a bundle with --dist`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('process sweep doctor drive: POSIX only (the Windows read and ending are proved by scripts/winreg/prove-process-sweep-doctor.ts on a Windows box)')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'orphan-sweep-doctor-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_RENDER_CWD = CWD
process.env.MERCURY_SESSION_PARK_DRAIN_MINUTES = '0.01'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_HOME

const { guardLoginDriverWrite } = await import('../lib/loginDriverGuard.ts')
guardLoginDriverWrite('the process sweep doctor drive', process.env)
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const scenarios = await import('../ui/renderScenarios.ts')
const { getProcessStartTokenAsync } = await import('../../src/daemon/ownerWatch.ts')
seedFirstRun(HOME, [CWD])

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  MERCURY_HOME: '',
  MERCURY_SESSION_PARK_DRAIN_MINUTES: '0.01',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}

const standIns: ChildProcess[] = []
const registeredTokens = new Map<number, string | null>()
async function standInWindow(): Promise<number> {
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000000)'], { stdio: 'ignore', detached: true })
  standIns.push(child)
  const pid = child.pid!
  const startToken = await getProcessStartTokenAsync(pid)
  const dir = join(HOME, 'processes')
  mkdirSync(dir, { recursive: true })
  const id = randomUUID()
  const expired = new Date(Date.now() - 3_600_000)
  const path = join(dir, `cockpit-${pid}-${id}.json`)
  writeFileSync(path, JSON.stringify({
    schema: 1,
    id,
    pid,
    startToken,
    exe: process.execPath,
    bundle: BIN,
    configHome: HOME,
    daemonDir: join(HOME, 'daemon'),
    terminal: null,
    bornAt: expired.getTime(),
    heartbeatAt: expired.getTime(),
  }, null, 2))
  utimesSync(path, expired, expired)
  registeredTokens.set(pid, startToken)
  return pid
}
const alive = (pid: number): boolean => {
  const out = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
  return out.trim() !== '' && !out.trim().startsWith('Z')
}

type Row = { id?: string; label?: string; evidence?: string; detail?: string; status?: string; remedy?: unknown }
function rowsOf(jsonText: string): Row[] {
  const rows: Row[] = []
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v)
      return
    }
    if (o && typeof o === 'object') {
      const r = o as Row
      if (typeof r.id === 'string' && typeof r.label === 'string' && typeof r.status === 'string') rows.push(r)
      for (const v of Object.values(o)) walk(v)
    }
  }
  try {
    walk(JSON.parse(jsonText))
  } catch {
    return rows
  }
  return rows
}
function doctorJson(): { text: string; status: number | null } {
  const res = spawnSync('node', [BIN, 'doctor', '--json'], { cwd: CWD, encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  return { text: res.stdout ?? '', status: res.status }
}

function capture(name: string, cols: number, rows: number, extraSends: Array<Record<string, unknown>>, total: number): string[] {
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
    return []
  }
  scenarios.writeSyntheticSession('short')
  const ESC = '\x1b'
  const out = join(SCRATCH, `${name}.json`)
  const vcfg = {
    argv: ['node', BIN, '--resume', scenarios.SID],
    cwd: CWD,
    cols,
    rows,
    sends: [
      { atTick: 140, awaitRaw: `${ESC}[?2004h`, minTick: 30, data: '/health' },
      { afterPrevTicks: 6, data: '\r' },
      ...extraSends,
    ],
    total,
    out,
  }
  const vcfgPath = join(SCRATCH, `${name}-cfg.json`)
  writeFileSync(vcfgPath, JSON.stringify(vcfg))
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), vcfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(300_000), env: childEnv })
  check(`the ${name} capture ran`, res.status === 0, (res.stderr ?? '').slice(-200))
  let lines: string[] = []
  try {
    const grid = JSON.parse(readFileSync(out, 'utf8')) as { grid: { c: string }[][] }
    lines = grid.grid.map(r => r.map(c => c.c || ' ').join(''))
  } catch {
    lines = []
  }
  const captureDir = process.env.MERCURY_HEALTH_CAPTURE_DIR
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true })
    writeFileSync(join(captureDir, `orphan-sweep-doctor-${name}.txt`), lines.join('\n') + '\n')
    try {
      writeFileSync(join(captureDir, `orphan-sweep-doctor-${name}.json`), readFileSync(out))
    } catch {
      console.log('  … the grid could not be copied beside the frame')
    }
  }
  return lines
}

try {
  console.log('J doctor --json carries the Mercury processes row with a stale stand-in listed')
  const standIn = await standInWindow()
  const j = doctorJson()
  const rows = rowsOf(j.text)
  const row = rows.find(r => r.id === 'mercury-processes')
  check('doctor --json produced a certificate', j.status === 0 || j.status === 3, `status=${String(j.status)}`)
  check('the certificate carries the row "Mercury processes"', row !== undefined && row.label === 'Mercury processes', rows.map(r => r.id).join(',').slice(0, 200))
  check('the row counts running · stale · cannot end · not ours', /^\d+ running · \d+ stale · \d+ cannot end · \d+ not ours/.test(row?.evidence ?? ''), row?.evidence)
  check('the row warns and lists the stand-in as a stale line with pid, terminal and age', row?.status === 'warn' && (row.detail ?? '').includes(`pid ${standIn} · no terminal ·`), (row?.detail ?? '').slice(0, 160))
  if (!(row?.detail ?? '').includes(`pid ${standIn} · no terminal ·`)) {
    const listing = spawnSync('node', [BIN, 'doctor', 'processes'], { cwd: CWD, encoding: 'utf8', timeout: vshotBudgetMs(120_000), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? ''
    let entries: Array<{ process?: { pid?: number; exe?: string; user?: string; args?: string[] }; classification?: string; reason?: string; startToken?: string | null }> = []
    try {
      entries = (JSON.parse(listing.slice(Math.max(0, listing.indexOf('{')))) as { entries?: typeof entries }).entries ?? []
    } catch {
      entries = []
    }
    const mine = entries.find(entry => entry.process?.pid === standIn)
    const token = registeredTokens.get(standIn)
    console.log(`  … the stand-in as the headless listing reads it: ${mine === undefined ? `no entry among ${entries.length}` : `${mine.classification} · ${mine.reason} · exe=${mine.process?.exe} · user=${mine.process?.user} · args=${(mine.process?.args ?? []).join(' ').slice(0, 60)} · token=${mine.startToken}`} · reader uid=${typeof process.getuid === 'function' ? process.getuid() : 'n/a'} · registered token=${token}`)
  }
  const rowIndex = Math.max(0, rows.findIndex(r => r.id === 'mercury-processes'))
  check('the stand-in is untouched by the read-only doctor', alive(standIn))
  process.kill(standIn, 'SIGKILL')
  rmSync(join(HOME, 'processes'), { recursive: true, force: true })

  for (const [cols, termRows] of [[120, 40], [80, 21]] as const) {
    console.log(`S the cockpit at ${cols}×${termRows} — the row, the action, the result`)
    const size = `${cols}x${termRows}`
    const target = await standInWindow()
    const downs = Array.from({ length: rowIndex }, () => ({ afterPrevTicks: 1, data: '\x1b[B' }))
    const walk = rowIndex === 0 ? [] : [{ afterPrevTicks: 45, data: '\x1b[B' }, ...downs.slice(1)]
    const before = capture(`row-${size}`, cols, termRows, [...walk, { afterPrevTicks: 3, data: '\r' }], 150 + rowIndex)
    check(`${size}: /health painted its certificate`, before.some(l => l.includes('health certificate')))
    check(`${size}: the Mercury processes row is on screen`, before.some(l => l.includes('Mercury processes')), before.find(l => l.includes('Mercury processes'))?.trim().slice(0, 120))
    check(`${size}: the row's trail lists the stale stand-in with pid, terminal and age`, before.some(l => l.includes(`pid ${target} · no terminal ·`)), before.find(l => l.includes(`pid ${target}`))?.trim().slice(0, 120))
    check(`${size}: the read-only row ended nothing`, alive(target))
    if (row === undefined) {
      process.kill(target, 'SIGKILL')
      continue
    }
    const confirm = capture(`confirm-${size}`, cols, termRows, [
      ...walk,
      { afterPrevTicks: 3, data: 'f' },
    ], 150 + rowIndex)
    check(`${size}: the action asks with the approved words before anything is ended`, confirm.some(l => l.includes('End these') && l.includes('stale processes?')), confirm.find(l => l.includes('End these'))?.trim().slice(0, 120))
    check(`${size}: the confirmation card shows the reviewed pid`, confirm.some(l => l.includes(`pid ${target}`)))
    check(`${size}: the stand-in is untouched while the card waits`, alive(target))
    const result = capture(`result-${size}`, cols, termRows, [
      ...walk,
      { afterPrevTicks: 3, data: 'f' },
      { afterPrevTicks: 5, data: '\r' },
    ], 200 + rowIndex)
    check(`${size}: the result names what was ended with the approved words`, result.some(l => /Ended 1 stale processes; 0 could not be ended/.test(l)), result.find(l => l.includes('Ended'))?.trim().slice(0, 120))
    check(`${size}: the reviewed stand-in was ended through the doctor's action`, !alive(target))
  }
} catch (error) {
  failures++
  console.log(`  [FAIL] the drive threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const child of standIns) {
    try {
      child.kill('SIGKILL')
    } catch {
      continue
    }
  }
  if (!process.argv.includes('--keep')) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`scratch kept at ${SCRATCH}`)
}
console.log(failures === 0 ? '✅ process sweep doctor drive: all legs green' : `❌ process sweep doctor drive: ${failures} leg(s) red`)
process.exit(failures === 0 ? 0 : 1)
