// ============================================================================
//  scripts/pulse/lib/pulseArena.ts — the hermetic PTY arena for
//  scenes.
//
//  A faithful sibling of scripts/streaming/artifactArena.ts (same hard-won
//  invariants — credit where due) with the seams the scene matrix
//  needs and the flux arena does not own:
//   • seedConfig — files under the hermetic MERCURY_CONFIG_DIR (hook fixtures
//     ride user settings.json; project-settings hooks would need approval).
//   • nested seedCwd paths (mkdir -p before write).
//   • MERCURY_PULSE_DUMP always armed at <home>/pulse.jsonl; the parsed lines
//     come back as run.pulse (empty when the integrator's dump seam has not
//     landed — provers discriminate that via distHasSpelling()).
//
//  Invariants inherited from artifactArena:
//   • ASYNC spawn only — the fixture HTTP server lives in THIS process;
//     spawnSync starves its accept loop and the child's requests deadlock.
//   • Seed the project trust key with the REALPATH'd cwd.
//   • Pre-approve the API key (slice(-20)).
//   • Pin MERCURY_TERMINAL_TITLE=0 (no title writes).
// ============================================================================

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

/** One MERCURY_PULSE_DUMP line, normalized. The integrator's promised shape is
 *  the full PulseTurnSummary plus the trace's events + producer records; this
 *  reader tolerates either a flat spelling ({...summary, events, producers})
 *  or a nested one ({summary, events, producers}). */
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
  /** Parsed + normalized MERCURY_PULSE_DUMP lines ([] until the seam lands). */
  pulse: PulseDumpLine[]
  driverOut: string
  /** The state anchor's re-base (ms): how much later (negative: earlier)
   *  the chat's composer painted than the authored nominal. Post-anchor
   *  sends fired shifted by this much; grab offsets follow through
   *  anchoredOffset/restoreOffsets. 0 when the composer never painted. */
  anchorShiftMs: number
  paths: { home: string; cwd: string; drive: string; tee: string; dump: string }
  cleanup: () => void
}

/** The chat composer's placeholder — the chat's own ready line — and the
 *  authored nominal the riders assume it by (their prompts sit ≥ 5000). */
const COMPOSER_READY_NEEDLE = 'Type a prompt'
const COMPOSER_NOMINAL_MS = 4000

/** An authored grab offset (ms from the first output chunk) moved to where
 *  its moment actually happened after the anchor's re-base; -1 and
 *  pre-anchor offsets stay put. */
export function anchoredOffset(run: { anchorShiftMs: number }, ms: number): number {
  return ms < 0 || ms < COMPOSER_NOMINAL_MS ? ms : Math.round(ms + run.anchorShiftMs)
}

/** Grabbed screens back onto their AUTHORED offsets (the inverse of
 *  anchoredOffset) so a prover's authored thresholds keep their meaning. */
export function restoreOffsets<T extends { atMs: number }>(run: { anchorShiftMs: number }, screens: T[]): T[] {
  for (const s of screens) {
    if (s.atMs >= 0 && s.atMs >= COMPOSER_NOMINAL_MS + Math.min(0, run.anchorShiftMs)) s.atMs = Math.round(s.atMs - run.anchorShiftMs)
  }
  return screens
}

export interface PulseArenaOpts {
  turns: ScriptedTurn[] | ((cwd: string) => ScriptedTurn[])
  /** ptydrive --send specs, e.g. ['5000:hello', '5600:\\r'] — or the
   *  observed-ready form 'after:needle:delayMs:text' (proof-hygiene:
   *  state-anchored sends for equivalence corpora; fixed ticks stay right
   *  where time IS the contract, i.e. the latency benches). */
  sends: string[]
  seconds: number
  cols?: number
  rows?: number
  keep?: boolean
  resizes?: string[]
  /** Files seeded into the arena cwd (nested rel paths ok — mkdir -p). */
  seedCwd?: Record<string, string>
  /** Files seeded into the hermetic MERCURY_CONFIG_DIR (e.g. settings.json
   *  with a hook fixture — user-settings hooks run without approval). */
  seedConfig?: Record<string, string>
  extraEnv?: Record<string, string>
}

export function requireDist(): void {
  if (!existsSync(DIST)) {
    console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
    process.exit(2)
  }
}

/** Does the SHIPPED artifact carry a spelling? The host-vs-built lesson:
 *  source presence proves nothing about the artifact the scenes run. */
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
  // realpath: macOS mkdtemp hands back a symlinked path; the CLI keys its
  // project config by the RESOLVED cwd — seed with that or the trust dialog
  // blocks the boot.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pulse-arena-cwd-')))
  seedFiles(cwd, opts.seedCwd ?? {})
  // Scripted turns are the MAIN model's unless a turn names its own model:
  // the same submit fires small-model side calls (the session title) that
  // must never consume a scripted turn.
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
  // The bare boot lands ON the Boot face and the face's ↵ births the chat
  // (the flip-first birth): ↵ on New Session the moment the face's ready
  // line shows — an observed-ready send, state-anchored, never a fixed
  // instant (the artifact arena's record: 900 ms after the hint's first
  // paint, so the face's keybinding mount is up before the key lands) —
  // then the scene's own sends follow.
  sendArgs.push('--send', 'after:↑↓ choose:900:\\r')
  for (const s of opts.sends) sendArgs.push('--send', s)
  // THE STATE ANCHOR (the artifact arena's law): a rider's fixed-ms prompt
  // authored for a nominal world fires into the FACE when the birth is
  // late — the composer's placeholder is the world's own ready line, and
  // the post-anchor schedule re-bases to its first paint. Riders' fixed
  // ms sends are byte-unchanged; the latency benches measure from real
  // send epochs and never see the shift.
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
        // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
        // env drops the job-wide knob and ptydrive falls back to scale 1 -
        // authored-time sends race 3x-slow hosted boots (the undelivered-sends
        // class; gate run 3's arena zero-observation shapes). Forward it.
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
        // capture pins (repo convention): ambience off, the pipeline is the
        // subject. Every display animation holds still — the critter's sway
        // and blink, its gaze and sleep, the header's live seconds, the live
        // glyphs — so a settle gate that reads the whole grid sees the screen
        // hold and no recorded frame lands on an arbitrary animation phase.
        // A drive that photographs an animation re-enables it through extraEnv.
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_TURN_RECEIPT: '0',
        MERCURY_OASIS_BG: '0',
        MERCURY_CREDENTIAL_STORE: 'file', // darwin keychain never leaks into arena boots (same class as the visual-baseline red)
        ...opts.extraEnv,
      },
    },
  )
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  // The killer wall covers ptydrive's own SCALED timeline (the hosted
  // profile stretches the drive inside the engine; an authored-seconds wall
  // would SIGKILL the drive it granted headroom to — run 2's zero-frames
  // class, one layer up).
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

// ── shared readers ──────────────────────────────────────────────────────────

const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<=>]*[A-Za-z@`~]|\x1b[()][0-9A-Za-z]|\x1b[A-Za-z=><]/g

/** Strip ANSI + whitespace + box glyphs — token-visibility matching. */
export function visibleText(s: string): string {
  return s.replace(ESC_RE, '').replace(/[\s─-╿]+/g, '')
}

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

/** Enter presses in the send log: the sends whose payload is exactly \r. */
export function enterSends(run: PulseRun): SendRecord[] {
  return run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('utf8') === '\r')
}
