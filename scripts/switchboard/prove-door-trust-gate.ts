#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-door-trust-gate.ts — the OTHER-PROJECTS door row
//  answers ↵ (the 24-seconds-of-nothing poison, pinned).
//
//  A gate-loop drive had read "↵ on a door row no-ops" off a wrong-frame
//  observation: the drive awaited the ENTERED view while the door's ↵ had
//  lawfully opened the folder-switch TRUST gate — the modal held the screen,
//  and the ↵↵ arm pair cannot answer a y/n card. This prover pins the truth
//  end-to-end on the real product (dist, PTY arena, real daemon, fixture
//  provider):
//   §1 the door row paints for a foreign project's running session;
//   §2 ↵ on the door is NEVER a silent nothing — the UNTRUSTED folder's ↵
//      opens the trust check, and y completes the switch: the ground note
//      paints, the chip flips, and the board RE-SCOPES to the project (the
//      session appears as a live row; the door and the modal are gone).
//  The poison is the original misread: if the door ↵ dies silently, the y
//  send never delivers (its await never appears) and §2's re-scope reds.
//  Trusted-arm door switching is prove-cross-project-drive's D2; the picker-
//  side trust gate is prove-concourse-flow-laws' — this is the DOOR × TRUST
//  composition alone.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'door-trust-')))
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

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// A long paced thought keeps the foreign session RUNNING through the whole
// walk, so the door row's count stays alive under every capture.
const api = await startFixtureApi([
  { kind: 'paced_tool_use', preDeltas: ['stage-01 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo one', description: 'pause one' } }] },
  { kind: 'paced_tool_use', preDeltas: ['stage-02 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 8; echo two', description: 'pause two' } }] },
  { kind: 'paced', deltas: ['stage-03 live-body. '], gapMs: 400, settleDelayMs: 1500 },
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
    // The walk: tab into the list (the door row is the only row — it holds
    // the selection), ↵ opens the door. The arena PRE-SEEDS its home with
    // only its own cwd (seedFirstRun early-returns on an existing config),
    // so `work` is genuinely UNTRUSTED — the gate must paint. The y is
    // CONDITIONED on the modal's own words: a silent door starves it and
    // §2 reds — the poison is the original 24-seconds-of-nothing.
    sends: ['after:running in:1500:\t', 'after:running in:2600:\r', 'after:UNTRUSTED FOLDER:1200:y'],
    seconds: 26,
    cols: 140,
    rows: 40,
    keep: true,
    seedHome: async (configDir: string, cwd: string) => {
      seedFirstRun(configDir, [cwd, work])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const dispatched = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'door-trust-1',
        prompt: 'stream a long body',
        workspaceDir: work, // FOREIGN project — the door row's producer
        title: 'Door probe session',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check('the foreign session dispatched (working)', dispatched.ok === true && dispatched.sessionId !== undefined, JSON.stringify(dispatched))
      const transcript = join(paths.getProjectDir(work), `${dispatched.sessionId ?? ''}.jsonl`)
      check('the worker transcript was born in the foreign project home', await untilAsync(async () => existsSync(transcript) && statSync(transcript).size > 200, 30_000), transcript)
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
    const offsets = [2500, 5000, 8000, 11000, 14000, 17000, 20000, 24000].map(m => S(m))
    const grabs = grabScreens(run, 140, 40, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    // §1 the door row painted (before the walk moved anything).
    const doorFrames = grabs.filter(g => text(g).includes('running in') && text(g).includes('OTHER PROJECTS'))
    check('§1 the OTHER-PROJECTS door row paints for the foreign running session', doorFrames.length > 0, `door frames: ${doorFrames.map(g => g.atMs).join(',') || 'none'}`)
    // §2 the switch COMPLETED: ground note + chip + the re-scoped board's
    // live row. Reaching here at all means the ↵ answered (the y's await
    // is the modal's own words) — a silent door starves the y and this reds.
    const rescoped = grabs.filter(
      g => text(g).includes('Door probe session') && text(g).includes('repo → work') && !text(g).includes('UNTRUSTED FOLDER'),
    )
    check(
      '§2 door ↵ → trust y → the board RE-SCOPES (session row live, ground note painted, modal settled) — never a silent nothing',
      rescoped.length > 0,
      `re-scoped frames: ${rescoped.map(g => g.atMs).join(',') || 'none'}`,
    )
    const late = grabs[grabs.length - 1]
    check('§2 …and the door row is gone from the re-scoped board (the sessions are no longer elsewhere)', late !== undefined && !text(late).includes('OTHER PROJECTS'), late ? `late frame @${late.atMs}` : 'no late frame')
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
  if (process.env.DOOR_TRUST_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-door-trust-gate: ALL LAWS HOLD' : `\nprove-door-trust-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
