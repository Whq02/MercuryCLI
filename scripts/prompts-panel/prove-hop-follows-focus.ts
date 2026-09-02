#!/usr/bin/env bun
// ============================================================================
//  scripts/prompts-panel/prove-hop-follows-focus.ts — sheet line 2, driven
//  whole on the REAL product: the prompts panel follows the FOCUSED chat
//  across concourse hops.
//
//  Two daemon-carried sessions on a loopback fixture API (ALPHA: 'stream the
//  alpha chain' · BETA: 'settle the beta turn'). The operator enters ALPHA,
//  opens /workbench (the panel shows ALPHA's prompt), closes it, hops back
//  to the board, enters BETA, opens /workbench again (the panel shows
//  BETA's prompt — and never ALPHA's). Frames are the evidence: the grab
//  timeline must show a panel over ALPHA's roll, then a panel over BETA's.
//
//  Fixture-hermetic: scratch home + daemon dir + two workspaces; the fixture
//  API serves both workers; nothing touches the operator's estate. The
//  switchboard's seamless-switch journey is the pattern this rides.
//
//  Run:  ~/.bun/bin/bun run scripts/prompts-panel/prove-hop-follows-focus.ts
//  (dist must exist — `bun run build.ts`)
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'panel-hop-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const work2 = join(SCRATCH, 'work2')
for (const d of [home, daemonDir, work, work2]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONCOURSE = 'always'

const COLS = Number(process.env.PANEL_HOP_COLS ?? '120')
const ROWS = Number(process.env.PANEL_HOP_ROWS ?? '40')
const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.PROMPTS_PANEL_CAPTURE_DIR ?? join(tmpdir(), 'prompts-panel-captures')
mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(` PROMPTS PANEL — follows the focused chat across hops (${COLS}x${ROWS})`)
console.log('============================================================')

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work, work2])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// Script order = request arrival order: ALPHA's settled turn first, BETA's
// second; spares absorb strays (a resumed view re-asks nothing, but the
// fixture must never starve).
const api = await startFixtureApi([
  { kind: 'text', text: 'alpha-01 settled body.' },
  { kind: 'text', text: 'beta-01 settled body.' },
  { kind: 'text', text: 'Spare.' },
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

const ALPHA_PROMPT = 'stream the alpha chain'
const BETA_PROMPT = 'settle the beta turn'
// The dispatched sessions' ids, set by seedHome — the panel header names the
// followed session (`prompts · <runner|project> · session <id8>`), which is
// the law's own spelling: prompt TEXT rides inside the ground-preamble
// message and truncates off the roll, so text needles rot; identity holds.
let alphaSession = ''
let betaSession = ''

try {
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    // The board's enter road is TWO-STAGE (the armed-row grammar): the first
    // ↵ ARMS the selected row ("⇄ armed — ↵ again enters · type to message ·
    // esc disarms"), the second ↵ ENTERS the session.
    sends: [
      'after:Beta probe:2500:\t', // both rows on the board → focus the list
      'after:Beta probe:3300:\r', // ARM the selected row (ALPHA, the first)
      'after:Beta probe:3900:\r', // ↵ again ENTERS ALPHA
      'after:Beta probe:7000:/workbench', // the panel over ALPHA's chat
      'after:Beta probe:7600:\r',
      'after:Beta probe:12000:\x1b', // esc closes the panel
      'after:Beta probe:13500:\x1b[1;2D', // back to the board
      'after:Beta probe:15500:\x1b[B', // select the OTHER row (BETA)
      'after:Beta probe:16500:\r', // ARM the different session
      'after:Beta probe:17100:\r', // ↵ again ENTERS BETA
      'after:Beta probe:20000:/workbench', // the panel over BETA's chat
      'after:Beta probe:20600:\r',
    ],
    seconds: 27,
    cols: COLS,
    rows: ROWS,
    keep: true,
    seedHome: async (configDir, cwd) => {
      // Both sessions dispatch IN the arena's own project: the concourse
      // re-cut scopes session ROWS to the current project — a session of
      // another project paints as a door LINE ("↵ switches the board"),
      // whose Enter hops boards, never enters a session, and whose line
      // never carries the title needle the sends anchor on. The panel law
      // under proof (follows the FOCUSED chat) needs two enterable rows,
      // so both live here; the door road has its own provers. The project
      // is a git repo with one commit: a SECOND session in a non-repo
      // folder queues behind the git offer (heldReason no-repository) and
      // its modal owns the board — the offer road too has its own provers.
      seedFirstRun(configDir, [cwd])
      const { execFileSync } = await import('node:child_process')
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'arena', GIT_AUTHOR_EMAIL: 'arena@invalid', GIT_COMMITTER_NAME: 'arena', GIT_COMMITTER_EMAIL: 'arena@invalid' }
      execFileSync('git', ['init', '-q'], { cwd, env: gitEnv })
      writeFileSync(join(cwd, 'README.md'), 'arena ground\n')
      execFileSync('git', ['add', '.'], { cwd, env: gitEnv })
      execFileSync('git', ['commit', '-q', '-m', 'arena ground'], { cwd, env: gitEnv })
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'hop-a',
        prompt: ALPHA_PROMPT,
        workspaceDir: cwd,
        title: 'Alpha probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('ALPHA dispatched', a.ok === true && a.sessionId !== undefined, JSON.stringify(a))
      alphaSession = (a.sessionId ?? '').slice(0, 8)
      const alphaLog = join(paths.getProjectDir(cwd), `${a.sessionId ?? ''}.jsonl`)
      check(
        'ALPHA settled (its body on disk)',
        await untilAsync(async () => existsSync(alphaLog) && readFileSync(alphaLog, 'utf8').includes('alpha-01 settled body'), 30_000),
      )
      const b = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'hop-b',
        prompt: BETA_PROMPT,
        workspaceDir: cwd,
        title: 'Beta probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('BETA dispatched', b.ok === true && b.sessionId !== undefined, JSON.stringify(b))
      betaSession = (b.sessionId ?? '').slice(0, 8)
      const betaLog = join(paths.getProjectDir(cwd), `${b.sessionId ?? ''}.jsonl`)
      check(
        'BETA settled (its body on disk)',
        await untilAsync(async () => existsSync(betaLog) && readFileSync(betaLog, 'utf8').includes('beta-01 settled body'), 30_000),
      )
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
    const offsets = [4000, 6000, 8000, 9000, 10500, 12000, 14500, 16000, 18000, 21500, 22500, 24500, 26000].map(m => S(m))
    const grabs = grabScreens(run, COLS, ROWS, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    // Every frame lands beside the receipts — a failed drive must leave its
    // screens behind, never a bare timeline.
    for (const g of grabs) writeFileSync(join(CAPTURE_DIR, `L2-hop-frame-${g.atMs}ms-${COLS}x${ROWS}.txt`), text(g) + '\n')
    const kind = (g: { rows: string[] }): string => {
      const t = text(g)
      const panel = /PROMPTS \(\d+\)/.test(t) && /SAVED PROMPTS/.test(t)
      if (panel && t.includes(`session ${alphaSession}`) && !t.includes(`session ${betaSession}`)) return 'panel-alpha'
      if (panel && t.includes(`session ${betaSession}`) && !t.includes(`session ${alphaSession}`)) return 'panel-beta'
      if (panel) return 'panel-foreign'
      if (t.includes('SESSION CONCOURSE')) return 'board'
      if (t.includes('alpha-01 settled body')) return 'alpha'
      if (t.includes('beta-01 settled body')) return 'beta'
      return 'other'
    }
    const lane = grabs.map(g => ({ atMs: g.atMs, kind: kind(g) }))
    const laneStr = lane.map(l => `${l.atMs / 1000}s:${l.kind}`).join(' ')
    console.log(`  timeline: ${laneStr}`)
    const firstAlphaPanel = lane.findIndex(l => l.kind === 'panel-alpha')
    const firstBetaPanel = lane.findIndex(l => l.kind === 'panel-beta')
    check("a panel over ALPHA's chat painted (its header names ALPHA's session)", firstAlphaPanel >= 0, laneStr)
    check("a panel over BETA's chat painted later (its header names BETA's session)", firstBetaPanel > firstAlphaPanel, laneStr)
    check('no panel ever named a foreign or unidentified session', !lane.some(l => l.kind === 'panel-foreign'), laneStr)
    for (const [i, g] of grabs.entries()) {
      const k = lane[i]!.kind
      if (k === 'panel-alpha' || k === 'panel-beta') {
        writeFileSync(join(CAPTURE_DIR, `L2-hop-${k}-${COLS}x${ROWS}.txt`), text(g) + '\n')
      }
    }
  } finally {
    await run.cleanup?.()
  }
} finally {
  daemon?.kill('SIGTERM')
  await api.close?.()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-hop-follows-focus — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
