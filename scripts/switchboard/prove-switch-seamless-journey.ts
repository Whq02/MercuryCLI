#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-switch-seamless-journey.ts — the operator's
//  switching repro, driven whole on the REAL product: enter a LIVE session,
//  back out, enter a DIFFERENT session, back out, re-enter the first.
//
//  The law under test (the OS bar): every enter TAKES — three enters, three
//  entered views painted with the right session's content, the board back
//  between them; never a dead keypress. The first enter lands mid-thought
//  (the live view painting while the runner works); the second targets a
//  settled session (the attached path); the third re-enters the first.
//
//  Frames are the evidence: entered views are frames WITHOUT the concourse
//  header carrying the session's own body text; board returns are frames
//  WITH it, later in time. The e1→b1→e2→b2→e3 order is asserted off the
//  grab timeline. SWITCH_COLS picks the width (default 120; the acceptance
//  drives 100 and 120).
//
//  Fixture-hermetic: scratch home + daemon dir + workspace; the fixture API
//  serves both workers; nothing touches the operator's estate.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'switch-seamless-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const work2 = join(SCRATCH, 'work2')
for (const d of [home, daemonDir, work, work2]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const COLS = Number(process.env.SWITCH_COLS ?? '120')

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work, work2])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// Script order = request arrival order: ALPHA's long chain is dispatched
// (and requested) first; BETA's short settled turn second; spares absorb
// strays. ALPHA stays mid-thought for ~30s of real sleeps so the first
// enter lands into a live, painting view.
const api = await startFixtureApi([
  { kind: 'paced_tool_use', preDeltas: ['alpha-01 body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo a1', description: 'alpha pause one' } }] },
  { kind: 'text', text: 'beta-01 settled body.' },
  { kind: 'paced_tool_use', preDeltas: ['alpha-02 body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo a2', description: 'alpha pause two' } }] },
  { kind: 'paced_tool_use', preDeltas: ['alpha-03 body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo a3', description: 'alpha pause three' } }] },
  { kind: 'paced', deltas: ['alpha-04 body. ', 'alpha-05 body. '], gapMs: 400, settleDelayMs: 1500 },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
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
let alphaSid = ''
let betaSid = ''
try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  // The drive: focus the list once both rows exist, then three enters with
  // backs between them. ⇧← = CSI 1;2D (the leave/back gesture); arrows move
  // the selection to the OTHER row between enters. Fixed-ms spacing after
  // the one observed-ready anchor (arm-once needles cannot gate repeat
  // states); the frame assertions below stay the loud failure.
  const run = await runArtifactArena({
    turns: [],
    // ARM-THEN-ENTER (the ruled L17 grammar): each board enter is ↵↵ — the
    // first press arms the selected row, the second enters it.
    sends: [
      'after:Beta probe:2500:\t', // both rows on the board → focus the list
      'after:Beta probe:3300:\r', // ARM 1 — the selected row
      'after:Beta probe:3900:\r', // ENTER 1
      'after:Beta probe:8500:\x1b[1;2D', // back to the board
      'after:Beta probe:10500:\x1b[B', // select the OTHER row (the move disarms)
      'after:Beta probe:11500:\r', // ARM 2
      'after:Beta probe:12100:\r', // ENTER 2 — the different session
      'after:Beta probe:16500:\x1b[1;2D', // back to the board
      'after:Beta probe:18500:\x1b[A', // select the first row again
      'after:Beta probe:19500:\r', // ARM 3
      'after:Beta probe:20100:\r', // ENTER 3 — re-enter the first
    ],
    seconds: 27,
    cols: COLS,
    rows: 40,
    keep: true,
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work, work2])
      // TWO sessions on ONE project need a GIT GROUND (the coexistence law:
      // the second session forks its own worktree — held behind the git
      // offer on a bare folder). Stage the ground the lawful way.
      const { execFileSync } = await import('node:child_process')
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
      execFileSync('git', ['-c', 'user.email=drive@fixture', '-c', 'user.name=drive', 'commit', '-q', '--allow-empty', '-m', 'ground'], { cwd })
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'switch-a',
        prompt: 'stream the alpha chain',
        // The ARENA'S OWN project (the ratified project-scoped board): the
        // journey proves its own law on same-project rows; the cross-project
        // DOOR is prove-cross-project's estate.
        workspaceDir: cwd,
        title: 'Alpha probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('ALPHA dispatched', a.ok === true && a.sessionId !== undefined, JSON.stringify(a))
      alphaSid = a.sessionId ?? ''
      const alphaLog = join(paths.getProjectDir(cwd), `${alphaSid}.jsonl`)
      check(
        'ALPHA is mid-thought (first stage on disk)',
        await untilAsync(async () => existsSync(alphaLog) && readFileSync(alphaLog, 'utf8').includes('alpha-01 body'), 30_000),
      )
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'switch-b',
        prompt: 'settle the beta turn',
        workspaceDir: cwd,
        title: 'Beta probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('BETA dispatched', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      betaSid = b.sessionId ?? ''
      const betaLog = join(paths.getProjectDir(cwd), `${betaSid}.jsonl`)
      check(
        'BETA settled (its body on disk)',
        await untilAsync(async () => existsSync(betaLog) && readFileSync(betaLog, 'utf8').includes('beta-01 settled body'), 30_000),
      )
    },
    extraEnv: {
      MERCURY_CONCOURSE: 'always',
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  try {
    const offsets = [3000, 5000, 7000, 9000, 11000, 13000, 15000, 17000, 19000, 21000, 23000, 25000].map(m => S(m))
    const grabs = grabScreens(run, COLS, 40, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const kind = (g: { rows: string[] }): 'board' | 'alpha' | 'beta' | 'other' => {
      const t = text(g)
      if (t.includes('SESSION CONCOURSE')) return 'board'
      if (/alpha-\d\d body/.test(t)) return 'alpha'
      if (t.includes('beta-01 settled body')) return 'beta'
      return 'other'
    }
    const lane = grabs.map(g => ({ atMs: g.atMs, kind: kind(g) }))
    const laneStr = lane.map(l => `${l.atMs / 1000}s:${l.kind}`).join(' ')
    if (process.env.SWITCH_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs} [${kind(g)}]`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, COLS - 2))
      }
    }
    // The e1→b1→e2→b2→e3 walk, order-agnostic over which row boots
    // selected: three ENTERED stretches, the middle one a DIFFERENT session,
    // the third matching the first, with board frames between them.
    const entered: Array<{ atMs: number; kind: string }> = []
    let phase: 'want-e1' | 'want-b1' | 'want-e2' | 'want-b2' | 'want-e3' | 'done' = 'want-e1'
    for (const l of lane) {
      if (phase === 'want-e1' && (l.kind === 'alpha' || l.kind === 'beta')) {
        entered.push(l)
        phase = 'want-b1'
      } else if (phase === 'want-b1' && l.kind === 'board') phase = 'want-e2'
      else if (phase === 'want-e2' && (l.kind === 'alpha' || l.kind === 'beta') && l.kind !== entered[0]!.kind) {
        entered.push(l)
        phase = 'want-b2'
      } else if (phase === 'want-b2' && l.kind === 'board') phase = 'want-e3'
      else if (phase === 'want-e3' && l.kind === entered[0]!.kind) {
        entered.push(l)
        phase = 'done'
      }
    }
    check(`E1 the first enter takes (a live entered view paints) [${COLS} cols]`, entered.length >= 1, laneStr)
    check('B1 backing out returns the board', phase !== 'want-b1' && entered.length >= 1, laneStr)
    check('E2 entering a DIFFERENT session takes (the repro core)', entered.length >= 2, laneStr)
    check('B2 backing out again returns the board', entered.length >= 2 && phase !== 'want-b2', laneStr)
    check('E3 re-entering the first session takes (place kept)', phase === 'done', laneStr)
    // The live half of the bar: the FIRST entered view carried the live
    // runner (alpha painting mid-chain) in at least one frame.
    const liveAlphaEntered = lane.some(l => l.kind === 'alpha')
    check('the live session painted inside an entered view during the drive', liveAlphaEntered, laneStr)
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
  if (process.env.SWITCH_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nprove-switch-seamless-journey (${COLS} cols): ALL LAWS HOLD` : `\nprove-switch-seamless-journey (${COLS} cols): ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
