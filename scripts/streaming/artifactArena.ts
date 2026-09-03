// ============================================================================
//  scripts/streaming/artifactArena.ts — the shared hermetic arena for
//  app-scale runs (bench-artifact-stream.ts, prove-region-matrix.ts; grows
//  into the S11 circuit).
//
//  One call = one full production run: the SHIPPED dist/mercury.mjs boots
//  interactively (fresh HOME/MERCURY_CONFIG_DIR outside the repo, seeded to
//  skip onboarding + trust + the ApproveApiKey dialog) inside ptydrive.py's
//  PTY, routed via ANTHROPIC_BASE_URL to an in-process fixture server.
//
//  Hard-won invariants:
//   • ASYNC spawn only. The fixture HTTP server lives in THIS process;
//     spawnSync starves its accept loop and the child's requests deadlock
//     in the kernel backlog (ESTABLISHED sockets, zero parsed requests).
//   • Seed the project trust key with the REALPATH'd cwd (macOS mkdtemp
//     returns the /var symlink; the CLI keys config by the resolved path).
//   • Pre-approve the API key (slice(-20)) — a 'new' key blocks boot behind
//     the ApproveApiKey dialog and typed prompts land on IT.
//   • Pin MERCURY_TERMINAL_TITLE=0 — the session-title side call
//     otherwise races the scripted fixture queue for turns.
// ============================================================================

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
/** The chat world's ready line — the one line that paints only once the
 *  chat is up and input-wired (the vshot drives' entry needle). The cockpit
 *  (100+ columns) paints it as the composer's placeholder, 'Type a prompt';
 *  the deck world below the cockpit floor paints it in the hero's ready row,
 *  '● ready · type a prompt, or / for commands', and its composer carries no
 *  placeholder. The needle is the tail the two spellings share, so a boot at
 *  any width arms the anchor — a needle that never paints holds every
 *  post-anchor send forever. */
const COMPOSER_READY_NEEDLE = 'ype a prompt'
/** The authored nominal: riders' earliest send sits at 4500ms, so the
 *  composer is assumed ready 500ms before it. */
const COMPOSER_NOMINAL_MS = 4000

export interface TeeWrite {
  ts: number
  content?: string
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

/** The Boot face's ready line — the needle the arena's own New Session press
 *  is armed on; the driver records it beside the send. */
const FACE_READY_NEEDLE = '↑↓ choose'

export interface ArenaRun {
  fixture: FixtureApi
  teeLines: TeeWrite[]
  sendLog: SendRecord[]
  /** Parsed MERCURY_FLUX_PROBE_TEE dump (null unless opts.probe). */
  probe: ProbeDump | null
  driverOut: string
  /** The state anchor's re-base (ms): how much later (or earlier, negative)
   *  the chat's composer painted than the authored nominal. Every
   *  post-anchor send fired shifted by this much; grabScreens applies the
   *  same shift so authored offsets keep pointing at the authored moments.
   *  0 when the composer never painted (the schedule ran as authored). */
  anchorShiftMs: number
  /** Arena file locations — valid until cleanup() (opts.keep callers). */
  paths: { home: string; cwd: string; drive: string; tee: string }
  /** Remove the arena dirs (no-op if already cleaned). */
  cleanup: () => void
}

export interface ArenaOpts {
  /** Scripted fixture turns; pass a function to reference the arena cwd
   *  (e.g. a Read of a cwd-local path — auto-allowed only INSIDE the
   *  project dir). */
  turns: ScriptedTurn[] | ((cwd: string) => ScriptedTurn[])
  /** ptydrive --send specs, e.g. ['4500:hello', '5300:\\r']. */
  sends: string[]
  seconds: number
  cols?: number
  rows?: number
  /** Arm MERCURY_FLUX_PROBE + the probe tee and parse the dump. */
  probe?: boolean
  /** Keep the arena dirs until the caller's cleanup() — for post-run
   *  byte-log replay (screengrab.py). */
  keep?: boolean
  /** ptydrive --resize specs, e.g. ['7000:100:30'] (ms:cols:rows —
   *  TIOCSWINSZ + SIGWINCH at the offset). */
  resizes?: string[]
  /** Files to seed into the arena cwd before boot (relative path → content). */
  seedCwd?: Record<string, string>
  /** Seed the hermetic arena HOME's own stores before boot (configDir is the
   *  arena's .claude; cwd is the resolved arena project) — a prover writes
   *  through the real owners here, never ambient state. */
  seedHome?: (configDir: string, cwd: string) => void | Promise<void>
  /** Run a different artifact (e.g. an out-of-repo staged copy — the S11
   *  circuit). Defaults to the repo dist. */
  distPath?: string
  extraEnv?: Record<string, string>
  /** THE STATE ANCHOR's needle and nominal (default: the chat composer's
   *  placeholder at 4000 ms — the chat world's own ready line). A world
   *  that never paints it (a concourse boot under MERCURY_CONCOURSE=always)
   *  must pass `null`: with the default anchor every fixed-ms send at or
   *  past the nominal is HELD until the needle paints, which is never —
   *  the rail prover's 30 ms burst never typed for that reason. Null runs
   *  the schedule as authored (observed-ready sends are unaffected). */
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
  // realpath: macOS mkdtemp hands back a symlinked path; the CLI keys its
  // project config by the RESOLVED cwd — seed with that or the trust dialog
  // blocks the boot.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'flux-arena-cwd-')))
  for (const [rel, content] of Object.entries(opts.seedCwd ?? {})) {
    writeFileSync(join(cwd, rel), content)
  }
  // Scripted turns are the MAIN model's unless a turn names its own model:
  // the same submit fires small-model side calls (the session title) that
  // must never consume a scripted turn — a journey that ran dark because a
  // side call ate its first turn is the class this default closes.
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
      // The concourse's one-time capacity ask would sit its modal over the
      // board and eat the drive's sends — an arena home is a WALKED home
      // (a consented reading of five seats, never re-asked — the fixture
      // states its own machine; a declined record would read the live box).
      switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
    }),
  )
  // let a prover seed the ARENA home's own
  // stores through the real owners before boot (crew fixtures etc.) — the
  // hook sees the hermetic home + resolved cwd; nothing ambient is touched.
  if (opts.seedHome) {
    await opts.seedHome(configDir, cwd)
  }
  const tee = join(home, 'tee.jsonl')
  const drive = join(home, 'drive.jsonl')
  const probeTee = join(home, 'flux-probe.json')

  const sendArgs: string[] = []
  // THE LANDING RULE: a bare
  // boot lands on the Boot face; the arena drives the CHAT, so it presses
  // ↵ on New Session the moment the face's ready line shows (an observed-
  // ready send — state-anchored, never a fixed instant), then the scene's
  // own sends follow.
  // 900ms after the hint's FIRST stream paint — the canonical face-↵ record
  // waits for the paint to SETTLE (awaitSettle/Stable ticks); a 150ms fire
  // raced the face's keybinding mount and the ↵ was eaten on the slower
  // boots (the face still up at +6s, every later anchored send unarmed).
  sendArgs.push('--send', `after:${FACE_READY_NEEDLE}:900:\\r`)
  // THE STATE ANCHOR: the birth's wall-clock seconds never scale with the
  // movie, so a rider's fixed-ms prompt ('4500:hello') authored for a
  // nominal world fires into the FACE when the chat is late (the hosted
  // zero-observation shapes: composer never moved, 0 frames, 0 tail marks).
  // The composer's placeholder is the world's own ready line; the schedule
  // re-bases so the authored offsets hold relative to its first paint
  // (nominal 4000 — riders type from 4500, i.e. 500ms after the composer).
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
        // THE HOSTED CAPTURE PROFILE MUST REACH THE ENGINE: a curated child
        // env drops the job-wide knob and ptydrive falls back to scale 1 -
        // authored-time sends race 3x-slow hosted boots (the undelivered-sends
        // class; gate run 3's arena zero-observation shapes). Forward it.
        ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: configDir,
        // The registered file-store seam: an arena boot reads no machine keychain
        // (darwin's would sign a keyless capture in; the pool seeds this for every
        // child, a by-hand run must carry it itself).
        MERCURY_CREDENTIAL_STORE: 'file',
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: API_KEY,
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_TEAMS_DIR: join(home, 'teams'),
        MERCURY_TABULA_DIR: join(home, 'tabula'),
        INK_WRITE_TEE: tee,
        INK_WRITE_TEE_FULL: '1',
        MERCURY_TERMINAL_TITLE: '0',
        // the fixture operator handle: a capture records the same seat name on
        // every machine, never the account that ran it
        MERCURY_OPERATOR: process.env.MERCURY_OPERATOR?.trim() || 'sam',
        ...(opts.probe ? { MERCURY_FLUX_PROBE: '1', MERCURY_FLUX_PROBE_TEE: probeTee } : {}),
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
        ...opts.extraEnv,
      },
    },
  )
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  // The killer wall covers ptydrive's own SCALED timeline (the hosted
  // profile stretches the drive inside the engine — an authored-seconds
  // wall would SIGKILL the drive it granted headroom to).
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(opts.seconds * 1000) + 22_000)
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  clearTimeout(killer)

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
  // The arena's own New Session press is a HARNESS send, never the scene's:
  // the driver records an observed-ready send with the needle that armed it
  // (`after`), and the face ↵ is the one armed by the face's ready line —
  // it leaves the scene's send log so every "N sends delivered" count and
  // every index-free stamp read stays authored.
  const sendLog: SendRecord[] = driveRows.filter(
    (r): r is SendRecord => r.sent !== undefined && (r as { after?: string }).after !== FACE_READY_NEEDLE,
  )
  const anchorShiftMs = driveRows.find(r => typeof r.anchor === 'number')?.shiftMs ?? 0
  let probe: ProbeDump | null = null
  if (opts.probe && existsSync(probeTee)) {
    try {
      probe = JSON.parse(readFileSync(probeTee, 'utf8')) as ProbeDump
    } catch {
      probe = null
    }
  }

  // FLUX_BENCH_KEEP keeps the arena WHOLE — the provers that replay their
  // byte log (opts.keep) call cleanup() themselves once they have read it,
  // which threw the kept dirs away under the knob and left an inspector with
  // the printed paths pointing at nothing. Under the knob cleanup is a
  // no-op: the transcript, the daemon's projections, the tee, the drive
  // and the probe dump all stay for a post-run read.
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
    probe,
    driverOut,
    anchorShiftMs,
    paths: { home, cwd, drive, tee },
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

/** Marks of one kind as epoch-ms timestamps. */
export function markEpochs(probe: ProbeDump, kind: string): number[] {
  return probe.allMarks.filter(m => m.k === kind).map(m => m.t + probe.epochMinusPerfNow)
}

// ── row-coordinate tracing ─────────────────────────────

export interface GrabbedScreen {
  atMs: number
  rows: string[]
  cursor?: { x: number; y: number; hidden: boolean }
  reverseCells?: [number, number][]
}

/** Replay the run's PTY byte log through pyte (screengrab.py) and return the
 *  screen at each offset (ms relative to the first output chunk; -1 = final
 *  screen + cursor/reverse-cell report). Requires opts.keep — the drive log
 *  must still exist. */
/** Screens for the requested offsets, IN INPUT ORDER (C6, class
 *  sweep): screengrab.py sorts its stops internally, and ~40 call sites
 *  destructure this return positionally — the one-owner remap makes the
 *  offsets genuinely order-free (each screen's atMs echoes its requested
 *  offset; -1 means the final screen; duplicates share one grab). Callers
 *  that match by atMs are unaffected — the remap preserves every stamp. */
export function grabScreens(
  run: ArenaRun,
  cols: number,
  rows: number,
  offsets: number[],
): GrabbedScreen[] {
  // Authored offsets name authored MOMENTS; the state anchor moved every
  // post-anchor moment by run.anchorShiftMs, so the grab follows (-1, the
  // final screen, and pre-anchor offsets stay put). The returned screens
  // echo the REQUESTED offsets — callers that match by atMs never see the
  // shift.
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

/** Row indices (0-based screen coordinates) whose text contains the needle. */
export function findRows(rows: string[], needle: string): number[] {
  const hits: number[] = []
  rows.forEach((r, i) => {
    if (r.includes(needle)) hits.push(i)
  })
  return hits
}

/** Epoch ts of the run's first PTY output chunk — the base screengrab offsets
 *  are relative to. Read from the drive log itself (ptydrive stamps output as
 *  {ts,…} and sends as {sent,…} in the same file); requires opts.keep. */
export function firstOutputTs(run: ArenaRun): number {
  for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const r = JSON.parse(line) as { ts?: number }
      if (typeof r.ts === 'number') return r.ts
    } catch {
      // skip malformed line
    }
  }
  return 0
}

/** A send's moment in grabScreens' STAMP base. grabScreens stamps each
 *  screen with its requested (authored) offset and grabs it at offset + the
 *  anchor shift, first-output-relative; a send record carries its true
 *  epoch. The stamp a caller may window against is therefore the send's
 *  true first-output-relative time minus that same shift — the two bases
 *  meet, and the anchor's re-base (a fast or a slow world) cancels on both
 *  sides instead of sliding a window across a press by the whole shift.
 *  A moment before the nominal composer instant keeps the boot clock, like
 *  a pre-anchor grab. */
export function sendStamp(run: ArenaRun, s: SendRecord): number {
  const shift = run.anchorShiftMs ?? 0
  const trueMs = s.sent - firstOutputTs(run)
  return trueMs >= COMPOSER_NOMINAL_MS + shift ? trueMs - shift : trueMs
}
