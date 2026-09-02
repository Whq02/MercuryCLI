#!/usr/bin/env bun
// ============================================================================
//  drive-live-tiles-degrade — the degraded FACE under the forced
//  posture (MERCURY_TILES_FORCE_DEGRADE=1, the registry-rowed capture seam):
//  one session streams hard, and the board must show
//   D1 the ONE footer sentence ('· tiles show summaries — the machine is
//      busy');
//   D2 the streamer's NOW cell carries NO live tokens (the summary stands,
//      the dim '·' mark leads) in EVERY frame;
//   D3 the board keeps painting (no freeze — the header clock advances).
//  The TRIGGER (the per-second read/derive budget, both directions) is
//  pinned deterministically in prove-live-tiles.ts L4; this drive banks the
//  visible face at both sizes.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tiles-degrade-')))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [daemonDir, work]) mkdirSync(d, { recursive: true })
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
  { kind: 'paced', deltas: Array.from({ length: 40 }, (_, i) => `degrade-mark ${String(i + 1).padStart(3, '0')} `), gapMs: 500, settleDelayMs: 1500 },
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
    seconds: 22,
    cols: SIZE.cols,
    rows: SIZE.rows,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'degrade-1',
        prompt: 'stream for the degrade face',
        workspaceDir: work,
        title: 'Busy streamer',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('streamer dispatched', a.ok === true && a.sessionId !== undefined)
      const t = join(paths.getProjectDir(work), `${a.sessionId}.jsonl`)
      check('transcript born', await untilAsync(async () => existsSync(t) && statSync(t).size > 100, 30_000))
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_TILES_FORCE_DEGRADE: '1',
    },
  })
  try {
    const offsets = [5000, 8000, 11000, 14000, 17000, 20000]
    const grabs = grabScreens(run, SIZE.cols, SIZE.rows, offsets)
    if (KEEP_DIR) {
      mkdirSync(KEEP_DIR, { recursive: true })
      for (const g of grabs.filter(x => [8000, 14000].includes(x.atMs))) {
        writeFileSync(join(KEEP_DIR, `degrade-${SIZE.cols}x${SIZE.rows}-at${g.atMs}.txt`), g.rows.map(r => r.replace(/\s+$/, '')).join('\n'))
      }
    }
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const boardFrames = grabs.filter(g => text(g).includes('SESSIONS'))
    check('the board painted', boardFrames.length >= 4, `${boardFrames.length} frames`)
    check(
      'D1 the ONE footer sentence',
      boardFrames.every(g => text(g).includes('tiles show summaries — the machine is busy')),
      `frames with it: ${boardFrames.filter(g => text(g).includes('tiles show summaries')).map(g => g.atMs).join(',')}`,
    )
    const streamRow = (g: { rows: string[] }): string => g.rows.find(r => r.includes('Busy streamer')) ?? ''
    // The discriminator: a LIVE tile shows the stream's TAIL (tokens ≥010
    // by mid-run, truncate-start); the lawful degraded summary is the
    // settled text's HEAD (its 56-clip carries tokens 001–003 only).
    const liveTail = (row: string): boolean => /degrade-mark 0[1-9]\d/.test(row)
    check('D2 no live tokens in the degraded tile (the summary stands)', boardFrames.every(g => !liveTail(streamRow(g))), boardFrames.map(g => `${g.atMs}:${liveTail(streamRow(g)) ? 'LIVE' : 'still'}`).join(','))
    check('D2 the dim · mark leads the summary cell', boardFrames.some(g => / · |·/.test(streamRow(g))), JSON.stringify(streamRow(boardFrames[boardFrames.length - 1]!).slice(-50)))
    const clocks = new Set(boardFrames.map(g => (text(g).match(/\b(\d{2}:\d{2}:\d{2})\b/) ?? [])[1] ?? ''))
    check('D3 no freeze (the clock advances across frames)', clocks.size >= 3, `${clocks.size} distinct clocks`)
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

console.log(failures === 0 ? `\ndrive-live-tiles-degrade ${SIZE.cols}x${SIZE.rows}: FACE HOLDS` : `\ndrive-live-tiles-degrade ${SIZE.cols}x${SIZE.rows}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
