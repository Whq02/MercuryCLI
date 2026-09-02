
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { COMPASS_SID, buildCompass1k } from './fixture1k.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
export const DIST = join(ROOT, 'dist', 'mercury.mjs')
const FLUX = join(ROOT, 'scripts', 'streaming')

const API_KEY = 'fixture-key-000'

export type DriveRecord =
  | { kind: 'out'; ts: number; bytes: number }
  | { kind: 'send'; sent: number; atMs: number; b64: string }
  | { kind: 'resize'; resized: number; atMs: number; cols: number; rows: number }

export interface TeeWrite {
  ts: number
  len?: number
  content?: string
}

export interface CompassRun {
  fixture: FixtureApi
  records: DriveRecord[]
  outs: { ts: number; bytes: number }[]
  sends: { sent: number; atMs: number; b64: string }[]
  resizes: { resized: number; atMs: number; cols: number; rows: number }[]
  teeLines: TeeWrite[]
  driverOut: string
  paths: { home: string; cwd: string; drive: string; tee: string }
  cleanup: () => void
}

export interface CompassArenaOpts {
  sends: string[]
  resizes?: string[]
  seconds: number
  cols?: number
  rows?: number
  turns?: ScriptedTurn[]
  extraEnv?: Record<string, string>
  extraSessions?: (cwd: string) => Array<{ sid: string; lines: Record<string, unknown>[] }>
}

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
    process.exit(2)
  }
}

function nodeBinPath(): string {
  return process.env.NODE_BIN ?? spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
}

function encodeTranscript(lines: Record<string, unknown>[], sessionId: string): string {
  let n = 0
  const ctx = {
    sessionId: sessionId as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-06-20T08:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  return lines.map(l => JSON.stringify(entryToRecord(l, ctx as never))).join('\n') + '\n'
}

function projectSlug(cwd: string): string {
  const s = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (s.length > 200) throw new Error(`arena cwd too long for the no-hash slug path: ${cwd}`)
  return s
}

export async function runCompassArena(opts: CompassArenaOpts): Promise<CompassRun> {
  requireDist()
  const nodeBin = nodeBinPath()

  const home = mkdtempSync(join(tmpdir(), 'compass-arena-home-'))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'compass-arena-cwd-')))

  const fixture = await startFixtureApi(opts.turns ?? [])
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

  const projDir = join(configDir, 'projects', projectSlug(cwd))
  mkdirSync(projDir, { recursive: true })
  const { lines } = buildCompass1k(cwd)
  writeFileSync(join(projDir, `${COMPASS_SID}.jsonl`), encodeTranscript(lines, COMPASS_SID))
  for (const extra of opts.extraSessions?.(cwd) ?? []) {
    writeFileSync(join(projDir, `${extra.sid}.jsonl`), encodeTranscript(extra.lines, extra.sid))
  }

  const tee = join(home, 'tee.jsonl')
  const drive = join(home, 'drive.jsonl')

  const sendArgs: string[] = []
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
      '--', nodeBin, DIST, '--resume', COMPASS_SID,
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
        INK_WRITE_TEE: tee,
        INK_WRITE_TEE_FULL: '1',
        MERCURY_TERMINAL_TITLE: '0',
        MERCURY_CRITTER_GAZE: '0',
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
  const killer = setTimeout(() => child.kill('SIGKILL'), opts.seconds * 1000 + 22_000)
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  clearTimeout(killer)

  await fixture.close()

  const records: DriveRecord[] = []
  if (existsSync(drive)) {
    for (const line of readFileSync(drive, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const r = JSON.parse(line) as Record<string, unknown>
        if (typeof r.ts === 'number') {
          records.push({
            kind: 'out',
            ts: r.ts,
            bytes: Buffer.from(String(r.b64 ?? ''), 'base64').length,
          })
        } else if (typeof r.sent === 'number') {
          records.push({ kind: 'send', sent: r.sent, atMs: Number(r.atMs), b64: String(r.b64) })
        } else if (typeof r.resized === 'number') {
          records.push({
            kind: 'resize',
            resized: r.resized,
            atMs: Number(r.atMs),
            cols: Number(r.cols),
            rows: Number(r.rows),
          })
        }
      } catch {
      }
    }
  }
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

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }

  return {
    fixture,
    records,
    outs: records.filter((r): r is Extract<DriveRecord, { kind: 'out' }> => r.kind === 'out'),
    sends: records.filter((r): r is Extract<DriveRecord, { kind: 'send' }> => r.kind === 'send'),
    resizes: records.filter((r): r is Extract<DriveRecord, { kind: 'resize' }> => r.kind === 'resize'),
    teeLines,
    driverOut,
    paths: { home, cwd, drive, tee },
    cleanup,
  }
}


export interface GrabbedScreen {
  atMs: number
  rows: string[]
  cursor?: { x: number; y: number; hidden: boolean }
}

export function grabScreens(run: CompassRun, cols: number, rows: number, offsets: number[]): GrabbedScreen[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(FLUX, 'screengrab.py'), run.paths.drive, String(cols), String(rows), ...offsets.map(String)],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  return (JSON.parse(res.stdout) as { screens: GrabbedScreen[] }).screens
}


export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

export function firstOutAfter(
  run: CompassRun,
  t: number,
  ceiling?: number,
): { ts: number; bytes: number } | null {
  for (const o of run.outs) {
    if (o.ts > t && (ceiling === undefined || o.ts <= ceiling)) return o
    if (o.ts > (ceiling ?? Infinity)) break
  }
  return null
}

export function settleAfter(
  run: CompassRun,
  t: number,
  gapMs: number,
  ceilingMs: number,
): { settleTs: number; bytes: number; chunks: number } | null {
  const window = run.outs.filter(o => o.ts > t && o.ts <= t + ceilingMs)
  if (window.length === 0) return null
  let settleTs = window[0]!.ts
  let bytes = 0
  let chunks = 0
  let prev = t
  for (const o of window) {
    if (chunks > 0 && o.ts - prev > gapMs) break
    bytes += o.bytes
    chunks++
    settleTs = o.ts
    prev = o.ts
  }
  return { settleTs, bytes, chunks }
}
