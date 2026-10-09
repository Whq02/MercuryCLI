#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'board-click-twice-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const TITLE = 'Click twice alpha'
const TITLE_B = 'Click twice beta'
const MULTI_CLICK_WINDOW_MS = 500

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const slowTurn = [
  { kind: 'paced_tool_use', preDeltas: ['stage-01 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo one', description: 'pause one' } }] },
  { kind: 'paced_tool_use', preDeltas: ['stage-02 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo two', description: 'pause two' } }] },
  { kind: 'paced', deltas: ['stage-03 live-body. ', 'stage-04 live-body. '], gapMs: 400, settleDelayMs: 1500 },
] as const
const api = await startFixtureApi([...slowTurn, ...slowTurn, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }] as never)

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
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const paths = await import('../../src/utils/sessionStorage/paths.ts')

console.log('the session board: a click selects a row, a second click on the selected row enters it — also when the second click lands inside the terminal’s double-click window (the built product in a PTY)')
try {
  const { runArtifactArena } = await import('../streaming/artifactArena.ts')
  const run = await runArtifactArena({
    turns: [],
    sends: [
      { awaitText: ['SESSION CONCOURSE', TITLE], targetHeader: 'STATUS & TITLE', targetText: TITLE },
      { awaitText: ['SESSION CONCOURSE', 'enter session'], targetHeader: 'STATUS & TITLE', targetText: TITLE, settleMs: 60, arrivedText: ['live-body', 'Type a prompt'], arrivedAbsent: 'SESSION CONCOURSE' } as never,
      { awaitText: ['live-body', 'Type a prompt'], awaitAbsent: 'SESSION CONCOURSE', text: '\x1b[1;2D' },
      { awaitText: ['SESSION CONCOURSE', TITLE_B], targetHeader: 'STATUS & TITLE', targetText: TITLE_B },
      { awaitText: ['SESSION CONCOURSE', 'enter session'], targetHeader: 'STATUS & TITLE', targetText: TITLE_B, settleMs: 60, arrivedText: ['live-body', 'Type a prompt'], arrivedAbsent: 'SESSION CONCOURSE' } as never,
      { awaitText: ['live-body', 'Type a prompt'], awaitAbsent: 'SESSION CONCOURSE', text: '' },
    ],
    seconds: 34,
    anchor: null,
    cols: 140,
    rows: 40,
    keep: true,
    seedHome: async (configDir, cwd) => {
      const gitRun = (args: string[]): void => {
        const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
        if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr ?? '').slice(0, 200)}`)
      }
      gitRun(['init', '-q', '-b', 'main', '.'])
      writeFileSync(join(cwd, 'README.md'), '# click twice workspace\n')
      gitRun(['add', 'README.md'])
      gitRun(['-c', 'user.name=arena', '-c', 'user.email=arena@fixture.invalid', 'commit', '-q', '-m', 'base'])
      seedFirstRun(configDir, [cwd, work])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      for (const [id, title] of [['click-twice-a', TITLE], ['click-twice-b', TITLE_B]] as const) {
        const dispatched = (await daemonControlRpc({
          op: 'concourseDispatch',
          clientMessageId: id,
          prompt: 'stream a long body',
          workspaceDir: cwd,
          title,
          modelKey: 'claude-opus-5',
          effort: 'xhigh',
        } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
        check(`${title}: the session dispatched (working)`, dispatched.ok === true && dispatched.sessionId !== undefined, JSON.stringify(dispatched))
        const transcript = join(paths.getProjectDir(cwd), `${dispatched.sessionId ?? ''}.jsonl`)
        check(`${title}: the runner is mid-thought before the board boots`, await untilAsync(async () => existsSync(transcript) && statSync(transcript).size > 200 && readFileSync(transcript, 'utf8').includes('stage-01 live-body'), 30_000), transcript)
      }
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
    const legs: Array<{ name: string; title: string; clickSteps: [number, number]; arrivedStep: number }> = [
      { name: 'the first visit', title: TITLE, clickSteps: [0, 1], arrivedStep: 2 },
      { name: 'after shift+← back from the session, the other row', title: TITLE_B, clickSteps: [3, 4], arrivedStep: 5 },
    ]
    for (const leg of legs) {
      const first = run.sendLog.find(s => s.step === leg.clickSteps[0])
      const second = run.sendLog.find(s => s.step === leg.clickSteps[1])
      check(`${leg.name}: the first click landed on the row`, first !== undefined, run.driverOut.slice(-300))
      check(`${leg.name}: the second click landed on the row once the list had the focus`, second !== undefined, run.driverOut.slice(-300))
      const gapMs = first !== undefined && second !== undefined ? second.sent - first.sent : -1
      const selectedBeforeSecond = (second?.screen ?? []).some(row => row.includes('▸') && row.includes(leg.title))
      check(`${leg.name}: the first click selected the row (the cursor sits on it when the second click fires)`, selectedBeforeSecond, (second?.screen ?? []).filter(row => row.includes(leg.title)).join(' | ').slice(0, 300))
      const arrived = run.sendLog.find(s => s.step === leg.arrivedStep)
      const entered = arrived !== undefined && (arrived.screen ?? []).some(row => row.includes('live-body')) && !(arrived.screen ?? []).some(row => row.includes('SESSION CONCOURSE'))
      check(`${leg.name}: the second click entered the session — ${gapMs} ms after the first${gapMs >= 0 && gapMs <= MULTI_CLICK_WINDOW_MS ? ' (inside the double-click window)' : ''}`, entered, run.outcome.complete ? 'entered view never painted' : `the walk did not complete: ${run.outcome.reason ?? ''} ${run.driverOut.slice(-200)}`)
      if (gapMs > MULTI_CLICK_WINDOW_MS) console.log(`  … ${leg.name}: the two clicks fell ${gapMs} ms apart, outside the ${MULTI_CLICK_WINDOW_MS} ms window: the quick-second-click road was not exercised in this leg`)
    }
  } finally {
    run.cleanup()
  }
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  daemon?.kill('SIGTERM')
  await api.close()
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log(failures === 0 ? '\nprove-board-click-twice: ALL LAWS HOLD' : `\nprove-board-click-twice: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
