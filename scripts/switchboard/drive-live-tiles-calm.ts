#!/usr/bin/env bun
// ============================================================================
//  drive-live-tiles-calm — the CALM pin (LIVE TILES sheet line 3): a 60 s
//  two-session drive where ONE streams — the other's row and the board's
//  order are byte-stable frame to frame.
//
//  Session A streams one long paced turn for ~55 s; session C completed a
//  short text turn before the board booted (its row is READY TO REVIEW and
//  IDLE). Frames are grabbed every second for 60 s and read row-scoped:
//   C1 the idle session's ROW is byte-identical across EVERY frame (the
//      AGE cell — a lawful minute tick — is stripped before comparing);
//   C2 the board's ROW ORDER (titles top-to-bottom) never changes while no
//      STATE changes (the streamer's settle at ~55 s bounds the window);
//   C3 POISON: the streamer's row DOES change across frames — the still
//      assert is not vacuous;
//   C4 after the streamer settles, the WHOLE board is still: consecutive
//      final frames byte-identical on every session row.
//
//  Not a suite member (drive- prefix): the capture battery runs it
//  backgrounded; its frames bank as the calm + idle-board captures.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiles-calm-')))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const workC = join(SCRATCH, 'work-idle')
for (const d of [daemonDir, work, workC]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const SIZE = process.env.MERCURY_TILES_DRIVE_SIZE === '100x30' ? { cols: 100, rows: 30 } : { cols: 120, rows: 40 }
const KEEP_DIR = process.env.MERCURY_TILES_CAPTURE_DIR

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  // C's quick settled turn (dispatched FIRST, completes before boot).
  { kind: 'text', text: 'quiet done.' },
  // A's one long streaming turn (~55 s at 90×600 ms).
  { kind: 'paced', deltas: Array.from({ length: 90 }, (_, i) => `calm-alpha ${String(i + 1).padStart(3, '0')} `), gapMs: 600, settleDelayMs: 1500 },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemonWithHome = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const untilAsync = async (pred: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const paths = await import('../../src/utils/sessionStorage/paths.ts')

try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: 64,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work, workC])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      // C first: its short turn settles before the board boots.
      const c = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'calm-idle-1',
        prompt: 'a quick reply',
        workspaceDir: workC,
        title: 'Idle done',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('idle session dispatched', c.ok === true && c.sessionId !== undefined)
      const cTranscript = join(paths.getProjectDir(workC), `${c.sessionId}.jsonl`)
      check('idle session settled before boot', await untilAsync(async () => existsSync(cTranscript) && readFileSync(cTranscript, 'utf8').includes('quiet done.'), 30_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'calm-stream-1',
        prompt: 'stream calmly',
        workspaceDir: work,
        title: 'Calm streamer',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('streamer dispatched', a.ok === true && a.sessionId !== undefined)
      const aTranscript = join(paths.getProjectDir(work), `${a.sessionId}.jsonl`)
      check('streamer transcript born', await untilAsync(async () => existsSync(aTranscript) && statSync(aTranscript).size > 100, 30_000))
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = Array.from({ length: 60 }, (_, i) => 3000 + i * 1000)
    const grabs = grabScreens(run, SIZE.cols, SIZE.rows, offsets)
    if (KEEP_DIR) {
      mkdirSync(KEEP_DIR, { recursive: true })
      for (const g of grabs.filter(x => [5000, 20000, 40000, 58000, 61000, 62000].includes(x.atMs))) {
        writeFileSync(join(KEEP_DIR, `calm-${SIZE.cols}x${SIZE.rows}-at${g.atMs}.txt`), g.rows.map(r => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const boardFrames = grabs.filter(g => g.rows.some(r => r.includes('SESSIONS')))
    check('the board painted for the whole minute', boardFrames.length >= 50, `${boardFrames.length} frames`)
    // Row-scoped reads. The AGE cell (the rightmost ~8 columns) may tick a
    // lawful minute boundary — stripped before the still compare.
    const stripAge = (row: string): string => row.replace(/\s+$/, '').slice(0, Math.max(0, SIZE.cols - 9))
    const idleRow = (g: { rows: string[] }): string => stripAge(g.rows.find(r => r.includes('Idle done')) ?? '')
    const streamRow = (g: { rows: string[] }): string => (g.rows.find(r => r.includes('Calm streamer')) ?? '').replace(/\s+$/, '')
    // The settle boundary: the streamer's state flips at ~57 s (a lawful
    // re-sort moment). The calm window is every frame before it.
    const calmWindow = boardFrames.filter(g => g.atMs <= 55000)
    const idleVariants = new Set(calmWindow.map(idleRow))
    check('C1 the idle row is byte-stable across the whole minute', idleVariants.size === 1 && !idleVariants.has(''), `${idleVariants.size} variant(s): ${[...idleVariants].map(v => JSON.stringify(v.slice(-40))).join(' | ')}`)
    // C2 the order: session-row titles top-to-bottom, constant.
    const orderOf = (g: { rows: string[] }): string =>
      g.rows
        .map(r => (r.includes('Calm streamer') ? 'A' : r.includes('Idle done') ? 'C' : ''))
        .filter(Boolean)
        .join('')
    const orders = new Set(calmWindow.map(orderOf))
    check('C2 the row order never changes while states hold', orders.size === 1 && !orders.has(''), `orders: ${[...orders].join(',')}`)
    // C3 POISON: the streamer's row moves (the still assert bites).
    const streamVariants = new Set(calmWindow.map(streamRow))
    check('C3 poison: the streaming row DOES change', streamVariants.size >= 5, `${streamVariants.size} variants`)
    // C4 the idle board: after the settle, consecutive frames byte-stable
    // on every session row (age-stripped).
    const finalFrames = boardFrames.filter(g => g.atMs >= 60000)
    const finalRows = (g: { rows: string[] }): string => [idleRow(g), stripAge(streamRow(g))].join('\n')
    const finals = new Set(finalFrames.map(finalRows))
    check('C4 the settled board is STILL (final frames identical)', finalFrames.length >= 2 && finals.size === 1, `${finalFrames.length} frames, ${finals.size} variant(s)`)
  } finally {
    run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon?.kill('SIGTERM')
  await api.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\ndrive-live-tiles-calm ${SIZE.cols}x${SIZE.rows}: CALM HOLDS` : `\ndrive-live-tiles-calm ${SIZE.cols}x${SIZE.rows}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
