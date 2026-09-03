
import { spawn, spawnSync } from 'node:child_process'
import { vshotBudgetMs } from '../../lib/captureDriver.ts'
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
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
export const DIST = join(ROOT, 'dist', 'mercury.mjs')
const PTYDRIVE = join(ROOT, 'scripts', 'streaming', 'ptydrive.py')

const API_KEY = 'fixture-key-000'

export interface TeeWrite {
  ts: number
  len?: number
  content?: string
}

export interface SendRecord {
  sent: number
  atMs: number
  b64: string
}

export interface PulseDumpLine {
  summary: Record<string, unknown> & {
    generation?: number
    status?: string
    cold?: boolean
    dispatched?: boolean
    totalMs?: number
    ackMs?: number | null
    localPrepMs?: number | null
    providerWaitMs?: number | null
    firstVisibleMs?: number | null
    paintMs?: number | null
  }
  events: { name: string; at: number; data?: Record<string, unknown> }[]
  producers: { label: string; ms: number; outcome: string; count: number }[]
}

export function normalizeDumpLine(raw: unknown): PulseDumpLine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const nested =
    r.summary && typeof r.summary === 'object' ? (r.summary as Record<string, unknown>) : null
  const trace = r.trace && typeof r.trace === 'object' ? (r.trace as Record<string, unknown>) : null
  const events = (r.events ?? trace?.events ?? []) as PulseDumpLine['events']
  const producers = (r.producers ?? trace?.producers ?? []) as PulseDumpLine['producers']
  const summary = (nested ?? r) as PulseDumpLine['summary']
  if (!Array.isArray(events) || !Array.isArray(producers)) return null
  return { summary, events, producers }
}

export interface PulseRun {
  fixture: FixtureApi
  teeLines: TeeWrite[]
  sendLog: SendRecord[]
  pulse: PulseDumpLine[]
  driverOut: string
  anchorShiftMs: number
  paths: { home: string; cwd: string; drive: string; tee: string; dump: string }
  cleanup: () => void
}

const COMPOSER_READY_NEEDLE = 'Type a prompt'
const COMPOSER_NOMINAL_MS = 4000

export function anchoredOffset(run: { anchorShiftMs: number }, ms: number): number {
  return ms < 0 || ms < COMPOSER_NOMINAL_MS ? ms : Math.round(ms + run.anchorShiftMs)
}

export function restoreOffsets<T extends { atMs: number }>(run: { anchorShiftMs: number }, screens: T[]): T[] {
  for (const s of screens) {
    if (s.atMs >= 0 && s.atMs >= COMPOSER_NOMINAL_MS + Math.min(0, run.anchorShiftMs)) s.atMs = Math.round(s.atMs - run.anchorShiftMs)
  }
  return screens
}

export interface PulseArenaOpts {
  turns: ScriptedTurn[] | ((cwd: string) => ScriptedTurn[])
  sends: string[]
  seconds: number
  cols?: number
  rows?: number
  keep?: boolean
  resizes?: string[]
  seedCwd?: Record<string, string>
  seedConfig?: Record<string, string>
  extraEnv?: Record<string, string>
}

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
    process.exit(2)
  }
}

export function distHasSpelling(spelling: string): boolean {
  if (!existsSync(DIST)) return false
  return readFileSync(DIST, 'utf8').includes(spelling)
}

export function nodeBinPath(): string {
  return process.env.NODE_BIN ?? spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
}

function seedFiles(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

export async function runPulseArena(opts: PulseArenaOpts): Promise<PulseRun> {
  requireDist()
  const nodeBin = nodeBinPath()

  const home = mkdtempSync(join(tmpdir(), 'pulse-arena-home-'))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pulse-arena-cwd-')))
  seedFiles(cwd, opts.seedCwd ?? {})
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
    }),
  )
  seedFiles(configDir, opts.seedConfig ?? {})
  const tee = join(home, 'tee.jsonl')
  const drive = join(home, 'drive.jsonl')
  const dump = join(home, 'pulse.jsonl')

  const sendArgs: string[] = []
  sendArgs.push('--send', 'after:↑↓ choose:900:\\r')
  for (const s of opts.sends) sendArgs.push('--send', s)
  sendArgs.push('--anchor', `${COMPOSER_READY_NEEDLE}:${COMPOSER_NOMINAL_MS}`)
  for (const r of opts.resizes ?? []) sendArgs.push('--resize', r)

  const child = spawn(
    '/usr/bin/python3',
    [
      PTYDRIVE,
      '--cols', String(opts.cols ?? 120),
      '--rows', String(opts.rows ?? 40),
      '--seconds', String(opts.seconds),
      '--out', drive,
      ...sendArgs,
      '--', nodeBin, DIST,
    ],
    {
      cwd,
      env: {
        ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: API_KEY,
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_TABULA_DIR: join(home, 'tabula'),
        MERCURY_PULSE_DUMP: dump,
        INK_WRITE_TEE: tee,
        INK_WRITE_TEE_FULL: '1',
        MERCURY_TERMINAL_TITLE: '0',
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_TURN_RECEIPT: '0',
        MERCURY_OASIS_BG: '0',
        MERCURY_CREDENTIAL_STORE: 'file',
        ...opts.extraEnv,
      },
    },
  )
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(opts.seconds * 1000) + 22_000)
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  clearTimeout(killer)

  await fixture.close()

  const readJsonl = <T,>(path: string, filter: (row: unknown) => T | null): T[] =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => {
            try {
              return filter(JSON.parse(l))
            } catch {
              return null
            }
          })
          .filter((x): x is T => x !== null)
      : []

  const teeLines = readJsonl<TeeWrite>(tee, row =>
    row && typeof row === 'object' && typeof (row as TeeWrite).ts === 'number'
      ? (row as TeeWrite)
      : null,
  )
  const sendLog = readJsonl<SendRecord>(drive, row =>
    row && typeof row === 'object' && typeof (row as SendRecord).sent === 'number'
      ? (row as SendRecord)
      : null,
  )
  const pulse = readJsonl<PulseDumpLine>(dump, normalizeDumpLine)
  const anchorShiftMs =
    readJsonl<{ shiftMs: number }>(drive, row =>
      row && typeof row === 'object' && typeof (row as { anchor?: unknown }).anchor === 'number'
        ? (row as { shiftMs: number })
        : null,
    )[0]?.shiftMs ?? 0

  const cleanup = (): void => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  if (process.env.PULSE_ARENA_KEEP) console.log(`kept arena: home=${home} cwd=${cwd}`)
  else if (!opts.keep) cleanup()

  return {
    fixture,
    teeLines,
    sendLog,
    pulse,
    driverOut,
    anchorShiftMs,
    paths: { home, cwd, drive, tee, dump },
    cleanup,
  }
}


const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<=>]*[A-Za-z@`~]|\x1b[()][0-9A-Za-z]|\x1b[A-Za-z=><]/g

export function visibleText(s: string): string {
  return s.replace(ESC_RE, '').replace(/[\s─-╿]+/g, '')
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

export function enterSends(run: PulseRun): SendRecord[] {
  return run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\r')
}
