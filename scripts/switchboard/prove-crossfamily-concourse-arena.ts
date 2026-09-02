#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-crossfamily-concourse-arena.ts — LANE CMA, the
//  SCREEN half: the cross-family concourse driven whole on the REAL product
//  (dist UI in a PTY + dist daemon + the shared three-dialect fixture), the
//  frames the verdict.
//
//  The composite under test: the coordinator chair on the GPT family
//  (config-seeded assist model, the Responses dialect on the wire) with
//  REAL Anthropic seats — one launched BY the coordinator from the
//  operator's typed ask, one dispatched directly at the daemon door. The
//  five journeys, read off the frames and the files:
//    LAUNCH — the operator types the ask into the concourse composer; the
//             GPT coordinator executes launch_session; the new seat's row
//             paints on the board.
//    STEER  — a second ask; message_session delivers INTO the seat while
//             it works (the delivery law: read at its next boundary); the
//             text lands in the seat's transcript on disk.
//    VIEW   — the board frames row BOTH seats by title, and the status
//             rail names the cross-family chair ('coordinator · GPT-5.5')
//             on the LIVE path (no fixture snapshot seam).
//    ENTER  — entering a seat paints that seat's own streamed body.
//    SWITCH — back out, enter the OTHER seat, its body paints; the
//             board returns between (the e1→b→e2 walk).
//
//  ARENA_COLS picks the width (default 120; the acceptance drives 100
//  and 120 — two sizes, the real-boot law).
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-crossfamily-concourse-arena.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'cma-arena-')))
const daemonDir = join(SCRATCH, 'daemon')
const workB = join(SCRATCH, 'workB')
for (const d of [daemonDir, workB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const COLS = Number(process.env.ARENA_COLS ?? '120')
const ROWS = COLS >= 120 ? 40 : 30

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { startCrossfamilyFixture, CMA_STEER_TEXT } = await import('../lib/crossfamilyConcourseFixture.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

// The seat holds its first turn live long enough that the STEER lands into
// a WORKING session and an enter can still catch the live view.
const fixture = await startCrossfamilyFixture({
  port: Number(process.env.ARENA_PORT ?? '25141'),
  seatStyle: 'paced',
  seatSleepSeconds: 14,
})

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemonWithHome = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', workB], {
    cwd: workB,
    env: {
      ...process.env,
      ...fixture.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_PARTY: '0',
      MERCURY_TERMINAL_TITLE: '0',
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

let betaSid = ''
let arenaCwd = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: [
      // The composer boots focused; the ask is typed then submitted. The
      // 'CMA Beta' needle arms when the pre-dispatched seat's row paints.
      'after:ask in plain words:1500:cma-launch: start the alpha seat',
      'after:ask in plain words:2400:\r',
      // STEER while the alpha seat is mid-turn (its Bash sleep holds it).
      'after:CMA Beta:9000:cma-steer: adjust the alpha seat',
      'after:CMA Beta:9700:\r',
      // ENTER the selected row, back out, ENTER the other (the switch).
      'after:CMA Beta:15000:\t',
      'after:CMA Beta:16000:\r',
      'after:CMA Beta:17200:\r',
      'after:CMA Beta:20000:\x1b[1;2D',
      'after:CMA Beta:21500:\x1b[B',
      'after:CMA Beta:22500:\r',
      'after:CMA Beta:23700:\r',
      'after:CMA Beta:26500:\x1b[1;2D',
    ],
    seconds: 31,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      arenaCwd = cwd
      // The GPT coordinator chair, seeded through the arena home's own
      // config file (the legacy .config.json this home reads).
      const cfgPath = join(configDir, '.config.json')
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      cfg.concourseCoordinator = { mode: 'agent-assisted', assistModel: 'gpt-5.5' }
      writeFileSync(cfgPath, JSON.stringify(cfg))
      seedFirstRun(configDir, [cwd, workB])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))
      // The DIRECT seat (the daemon door, model named on the wire field).
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'cma-arena-beta',
        prompt: 'seat-task-beta: work the beta brief',
        workspaceDir: cwd,
        title: 'CMA Beta',
        model: 'claude-sonnet-5',
      } as never)) as { ok?: boolean; sessionId?: string; modelId?: string }
      check('BETA dispatched at the daemon door', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      check('the named model rode the door (claude-sonnet-5, never a silent substitute)', b.modelId === 'claude-sonnet-5', String(b.modelId))
      betaSid = b.sessionId ?? ''
      const betaLog = join(paths.getProjectDir(cwd), `${betaSid}.jsonl`)
      check(
        'BETA streams on the Anthropic wire (its live body on disk)',
        await untilAsync(async () => existsSync(betaLog) && readFileSync(betaLog, 'utf8').includes('beta-live body'), 30_000),
      )
    },
    extraEnv: {
      ...fixture.env,
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = [3000, 6000, 8000, 11000, 14000, 17000, 19000, 23000, 25000, 28000, 30000].map(m => S(m))
    const grabs = grabScreens(run, COLS, ROWS, offsets)
    const frameText = (g: { rows: string[] }): string => g.rows.join('\n')
    const kind = (g: { rows: string[] }): 'board' | 'alpha' | 'beta' | 'other' => {
      const t = frameText(g)
      if (t.includes('SESSION CONCOURSE')) return 'board'
      if (/alpha-(live|done) body/.test(t)) return 'alpha'
      if (/beta-(live|done) body/.test(t)) return 'beta'
      return 'other'
    }
    const lane = grabs.map(g => ({ atMs: g.atMs, kind: kind(g), text: frameText(g) }))
    const laneStr = lane.map(l => `${l.atMs / 1000}s:${l.kind}`).join(' ')
    if (process.env.ARENA_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs} [${kind(g)}]`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
    }

    // VIEW — the board rows BOTH seats and names the cross-family chair.
    const boards = lane.filter(l => l.kind === 'board')
    check(`the board paints [${COLS}×${ROWS}]`, boards.length >= 1, laneStr)
    check('VIEW: a board frame rows the coordinator-LAUNCHED seat (CMA Alpha)', boards.some(b => b.text.includes('CMA Alpha')), laneStr)
    check('VIEW: a board frame rows the directly-dispatched seat (CMA Beta)', boards.some(b => b.text.includes('CMA Beta')), laneStr)
    check("VIEW: the rail names the cross-family chair on the LIVE path (coordinator · GPT-5.5)",
      boards.some(b => /coordinator · GPT-5\.5/i.test(b.text)),
      boards.length > 0 ? boards[boards.length - 1]!.text.split('\n').filter(r => /coordinator/i.test(r)).join(' | ').slice(0, 200) : 'no boards')
    // LAUNCH — the GPT coordinator's reply painted on the strip.
    check('LAUNCH: the coordinator spoke through the GPT ack on the board', boards.some(b => b.text.includes('cma-openai-ack')), laneStr)

    // ENTER + SWITCH — the e1→board→e2 walk, order-agnostic.
    let phase: 'want-e1' | 'want-b1' | 'want-e2' | 'done' = 'want-e1'
    let firstEntered: 'alpha' | 'beta' | null = null
    for (const l of lane) {
      if (phase === 'want-e1' && (l.kind === 'alpha' || l.kind === 'beta')) {
        firstEntered = l.kind
        phase = 'want-b1'
      } else if (phase === 'want-b1' && l.kind === 'board') phase = 'want-e2'
      else if (phase === 'want-e2' && (l.kind === 'alpha' || l.kind === 'beta') && l.kind !== firstEntered) phase = 'done'
    }
    check('ENTER: the first enter paints that seat\'s own body', phase !== 'want-e1', laneStr)
    check('SWITCH: back to the board, then the OTHER seat\'s body paints', phase === 'done', laneStr)
    const alphaEntered = lane.some(l => l.kind === 'alpha')
    const betaEntered = lane.some(l => l.kind === 'beta')
    check('both seats were entered across the walk (the cross-family pair on screen)', alphaEntered && betaEntered, laneStr)

    // STEER — disk truth: the steer text reached the coordinator-launched
    // seat's transcript (the seat answers it after its live turn settles).
    const alphaDir = paths.getProjectDir(arenaCwd)
    const alphaFiles = existsSync(alphaDir) ? (await import('node:fs')).readdirSync(alphaDir).filter(f => f.endsWith('.jsonl')) : []
    const steerLanded = alphaFiles.some(f => {
      const body = readFileSync(join(alphaDir, f), 'utf8')
      return body.includes('seat-task-alpha') && body.includes(CMA_STEER_TEXT)
    })
    check('STEER: the steer text landed in the launched seat\'s transcript', steerLanded, `${alphaDir}: ${alphaFiles.join(',')}`)

    // The wire: the coordinator rode the Responses dialect exclusively with
    // the exact id; the seats rode /v1/messages; nothing touched zai.
    const gptHits = fixture.captured.filter(h => h.lane === 'openai')
    check('the coordinator turns rode the GPT dialect with the exact id (≥2 turns ⇒ ≥4 rounds)',
      gptHits.length >= 4 && gptHits.every(h => h.model === 'gpt-5.5'),
      fixture.captured.map(h => `${h.lane}:${h.model}`).join(','))
    check('no anthropic-dialect coordinator turn ran (the chair stayed GPT)',
      fixture.captured.filter(h => h.lane === 'anthropic-coordinator').length === 0)
    check('the seats rode /v1/messages only',
      fixture.captured.filter(h => h.lane === 'anthropic-seat').length >= 2 &&
        fixture.captured.filter(h => h.lane === 'zai').length === 0)
  } finally {
    if (process.env.ARENA_KEEP === '1') console.log(`[keep] arena home ${run.paths.home} cwd ${run.paths.cwd}`)
    else run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon?.kill('SIGTERM')
  await fixture.close()
  if (process.env.ARENA_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-crossfamily-concourse-arena (${COLS}×${ROWS}): ALL LAWS HOLD` : `\nprove-crossfamily-concourse-arena (${COLS}×${ROWS}): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
