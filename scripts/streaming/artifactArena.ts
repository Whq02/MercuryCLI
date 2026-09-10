
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
export const DIST = join(ROOT, 'dist', 'mercury.mjs')

const API_KEY = 'fixture-key-000'
const COMPOSER_READY_NEEDLE = 'ype a prompt'
const COMPOSER_NOMINAL_MS = 4000

export interface TeeWrite {
  ts: number
  len?: number
  content?: string
  queuedBytes?: number
}

export interface PtyRead {
  ts: number
  text: string
}

export interface SendRecord {
  sent: number
  atMs: number
  b64: string
}

export interface ProbeMark {
  t: number
  k: string
  v: number
}

export interface ProbeDump {
  counters: Record<string, number>
  frames: { total: number; window: number; p50: number; p95: number; p99: number; maxMs: number }
  allMarks: ProbeMark[]
  epochMinusPerfNow: number
}

const FACE_READY_NEEDLE = '↑↓ choose'

export interface ArenaOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  killedByWall: boolean
  report: DriverReport | null
  elapsedMs: number
  complete: boolean
  reason: string | null
}

export interface DriverReport {
  raw_bytes: number
  raw_reads: number
  sends: number
  unfired: string[]
  ended: 'deadline' | 'eof' | 'read-error'
  elapsed_ms: number
}

export interface ArenaRun {
  fixture: FixtureApi
  teeLines: TeeWrite[]
  sendLog: SendRecord[]
  ptyReads: PtyRead[]
  outcome: ArenaOutcome
  probe: ProbeDump | null
  driverOut: string
  anchorShiftMs: number
  paths: { home: string; cwd: string; drive: string; tee: string }
  cleanup: () => void
}

export interface ArenaOpts {
  turns: ScriptedTurn[] | ((cwd: string) => ScriptedTurn[])
  sends: string[]
  seconds: number
  cols?: number
  rows?: number
  probe?: boolean
  keep?: boolean
  resizes?: string[]
  seedCwd?: Record<string, string>
  seedHome?: (configDir: string, cwd: string) => void | Promise<void>
  distPath?: string
  extraEnv?: Record<string, string>
  anchor?: { needle: string; atMs: number } | null
}

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
    process.exit(2)
  }
}

export function nodeBinPath(): string {
  return process.env.NODE_BIN ?? spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
}

export async function runArtifactArena(opts: ArenaOpts): Promise<ArenaRun> {
  const distPath = opts.distPath ?? DIST
  if (!existsSync(distPath)) {
    console.error(`artifact missing at ${distPath} — run \`bun run build.ts\` first`)
    process.exit(2)
  }
  const nodeBin = nodeBinPath()

  const home = mkdtempSync(join(tmpdir(), 'flux-arena-home-'))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'flux-arena-cwd-')))
  for (const [rel, content] of Object.entries(opts.seedCwd ?? {})) {
    writeFileSync(join(cwd, rel), content)
  }
  const scripted = (typeof opts.turns === 'function' ? opts.turns(cwd) : opts.turns).map(
    (turn): ScriptedTurn => (turn.whenModel === undefined ? { ...turn, whenModel: 'opus' } : turn),
  )
  const fixture = await startFixtureApi(
    scripted,
  )
  const configDir = join(home, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
    }),
  )
  if (opts.seedHome) {
    await opts.seedHome(configDir, cwd)
  }
  const tee = join(home, 'tee.jsonl')
  const drive = join(home, 'drive.jsonl')
  const probeTee = join(home, 'flux-probe.json')

  const sendArgs: string[] = []
  sendArgs.push('--send', `after:${FACE_READY_NEEDLE}:900:\\r`)
  const anchor = opts.anchor === undefined ? { needle: COMPOSER_READY_NEEDLE, atMs: COMPOSER_NOMINAL_MS } : opts.anchor
  if (anchor !== null) sendArgs.push('--anchor', `${anchor.needle}:${anchor.atMs}`)
  for (const s of opts.sends) sendArgs.push('--send', s)
  for (const r of opts.resizes ?? []) sendArgs.push('--resize', r)

  const child = spawn(
    '/usr/bin/python3',
    [
      join(HERE, 'ptydrive.py'),
      '--cols', String(opts.cols ?? 120),
      '--rows', String(opts.rows ?? 40),
      '--seconds', String(opts.seconds),
      '--out', drive,
      ...sendArgs,
      '--', nodeBin, distPath,
    ],
    {
      cwd,
      env: {
        ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: configDir,
        MERCURY_CREDENTIAL_STORE: 'file',
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: API_KEY,
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_TABULA_DIR: join(home, 'tabula'),
        INK_WRITE_TEE: tee,
        INK_WRITE_TEE_FULL: '1',
        MERCURY_TERMINAL_TITLE: '0',
        MERCURY_OPERATOR: process.env.MERCURY_OPERATOR?.trim() || 'sam',
        ...(opts.probe ? { MERCURY_FLUX_PROBE: '1', MERCURY_FLUX_PROBE_TEE: probeTee } : {}),
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_TURN_RECEIPT: '0',
        MERCURY_OASIS_BG: '0',
        ...opts.extraEnv,
      },
    },
  )
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  const spawnedAt = Date.now()
  let killedByWall = false
  const killer = setTimeout(() => {
    killedByWall = true
    child.kill('SIGKILL')
  }, vshotBudgetMs(opts.seconds * 1000) + 22_000)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  )
  await new Promise<void>(resolve => child.on('close', () => resolve()))
  const { code: exitCode, signal } = await exited
  clearTimeout(killer)
  const elapsedMs = Date.now() - spawnedAt
  const outcome = driverOutcome({ exitCode, signal, killedByWall, elapsedMs, driverOut })
  if (!outcome.complete) console.error(`[arena] capture incomplete — ${outcome.reason}`)

  await fixture.close()

  const teeLines: TeeWrite[] = existsSync(tee)
    ? readFileSync(tee, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l) as TeeWrite
          } catch {
            return null
          }
        })
        .filter((x): x is TeeWrite => x !== null)
    : []
  const driveRows: Array<Partial<SendRecord> & { anchor?: number; shiftMs?: number }> = existsSync(drive)
    ? readFileSync(drive, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as Partial<SendRecord> & { anchor?: number; shiftMs?: number })
    : []
  const sendLog: SendRecord[] = driveRows.filter(
    (r): r is SendRecord => r.sent !== undefined && (r as { after?: string }).after !== FACE_READY_NEEDLE,
  )
  const ptyReads: PtyRead[] = driveRows
    .filter((r): r is { ts: number; b64: string } => typeof (r as { ts?: unknown }).ts === 'number' && typeof (r as { b64?: unknown }).b64 === 'string')
    .map(r => ({ ts: r.ts, text: Buffer.from(r.b64, 'base64').toString('utf8') }))
  const anchorShiftMs = driveRows.find(r => typeof r.anchor === 'number')?.shiftMs ?? 0
  let probe: ProbeDump | null = null
  if (opts.probe && existsSync(probeTee)) {
    try {
      probe = JSON.parse(readFileSync(probeTee, 'utf8')) as ProbeDump
    } catch {
      probe = null
    }
  }

  const cleanup = (): void => {
    if (process.env.FLUX_BENCH_KEEP) return
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  if (process.env.FLUX_BENCH_KEEP) console.log(`kept arena: home=${home} cwd=${cwd}`)
  else if (!opts.keep) cleanup()

  return {
    fixture,
    teeLines,
    sendLog,
    ptyReads,
    outcome,
    probe,
    driverOut,
    anchorShiftMs,
    paths: { home, cwd, drive, tee },
    cleanup,
  }
}

export function driverOutcome(input: {
  exitCode: number | null
  signal: NodeJS.Signals | null
  killedByWall: boolean
  elapsedMs: number
  driverOut: string
}): ArenaOutcome {
  let report: DriverReport | null = null
  const lines = input.driverOut.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const rec = JSON.parse(line) as Partial<DriverReport>
      if (typeof rec.raw_bytes === 'number' && Array.isArray(rec.unfired)) {
        report = {
          raw_bytes: rec.raw_bytes,
          raw_reads: typeof rec.raw_reads === 'number' ? rec.raw_reads : 0,
          sends: typeof rec.sends === 'number' ? rec.sends : 0,
          unfired: rec.unfired as string[],
          ended: rec.ended === 'eof' || rec.ended === 'read-error' ? rec.ended : 'deadline',
          elapsed_ms: typeof rec.elapsed_ms === 'number' ? rec.elapsed_ms : input.elapsedMs,
        }
        break
      }
    } catch {}
  }
  let reason: string | null = null
  if (input.killedByWall) reason = `the arena's wall killed the driver after ${input.elapsedMs} ms (no closing report can be trusted)`
  else if (input.signal !== null) reason = `the driver died by ${input.signal} after ${input.elapsedMs} ms`
  else if (input.exitCode !== 0) reason = `the driver exited ${input.exitCode} after ${input.elapsedMs} ms: ${input.driverOut.trim().slice(-300)}`
  else if (report === null) reason = `the driver exited 0 but wrote no closing report: ${input.driverOut.trim().slice(-300)}`
  else if (report.ended !== 'deadline') reason = `the capture ended by ${report.ended} at ${report.elapsed_ms} ms, before the authored deadline (the child left the pty early)`
  return {
    exitCode: input.exitCode,
    signal: input.signal,
    killedByWall: input.killedByWall,
    report,
    elapsedMs: input.elapsedMs,
    complete: reason === null,
    reason,
  }
}


const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<=>]*[A-Za-z@`~]|\x1b[()][0-9A-Za-z]|\x1b[A-Za-z=><]/g

export function visibleText(s: string): string {
  return s.replace(ESC_RE, '').replace(/[\s─-╿]+/g, '')
}

export function firstPtyVisibility(reads: readonly PtyRead[], needle: string, notBefore: number): PtyRead | undefined {
  let carry = ''
  for (const r of reads) {
    const window = (carry + r.text).slice(-4096)
    if (r.ts >= notBefore && visibleText(window).includes(needle)) return r
    carry = window
  }
  return undefined
}

export function observedEmissionWindow(emits: readonly { at: number }[]): { start: number; end: number } | null {
  if (emits.length === 0) return null
  let start = emits[0]!.at
  let end = emits[0]!.at
  for (const e of emits) {
    if (e.at < start) start = e.at
    if (e.at > end) end = e.at
  }
  return { start, end }
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

export function markEpochs(probe: ProbeDump, kind: string): number[] {
  return probe.allMarks.filter(m => m.k === kind).map(m => m.t + probe.epochMinusPerfNow)
}


export interface GrabbedScreen {
  atMs: number
  rows: string[]
  cursor?: { x: number; y: number; hidden: boolean }
  reverseCells?: [number, number][]
}

export function grabScreens(
  run: ArenaRun,
  cols: number,
  rows: number,
  offsets: number[],
): GrabbedScreen[] {
  const shift = run.anchorShiftMs ?? 0
  const actual = (o: number): number => (o < 0 || o < COMPOSER_NOMINAL_MS ? o : Math.round(o + shift))
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, String(cols), String(rows), ...offsets.map(o => String(actual(o)))],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  const screens = (JSON.parse(res.stdout) as { screens: GrabbedScreen[] }).screens
  const byOffset = new Map<number, GrabbedScreen>()
  for (const s of screens) byOffset.set(s.atMs, s)
  return offsets.map(o => {
    const s = byOffset.get(actual(o))
    if (!s) throw new Error(`screengrab returned no screen for requested offset ${o}`)
    return { ...s, atMs: o }
  })
}

export function findRows(rows: string[], needle: string): number[] {
  const hits: number[] = []
  rows.forEach((r, i) => {
    if (r.includes(needle)) hits.push(i)
  })
  return hits
}

export function firstOutputTs(run: ArenaRun): number {
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as { ts?: number }
      if (typeof r.ts === 'number') return r.ts
    } catch {
    }
  }
  return 0
}

export function sendStamp(run: ArenaRun, s: SendRecord): number {
  const shift = run.anchorShiftMs ?? 0
  const trueMs = s.sent - firstOutputTs(run)
  return trueMs >= COMPOSER_NOMINAL_MS + shift ? trueMs - shift : trueMs
}
