#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-enter-live-journey.ts — DRIVE-12 (operator live
//  drive): the SEAMLESS ENTER, proven on the REAL product.
//
//  A real daemon (dist) admits a real session whose turn streams SLOWLY
//  against the fixture provider; the real UI (dist, PTY arena) boots on the
//  same daemon+provider, the operator enters that session mid-thought, the
//  frames are captured, and the laws under test are read off the frames and
//  the files:
//   §1 the entered view PAINTS the live transcript (the streamed text lands
//      on the operator's screen while the runner still works);
//   §2 THE ONE THINKING LIFT — the header spinner is up while the followed
//      runner is mid-turn (no operator turn of its own);
//   §3 the record NEVER reads PAUSED during the drain (the enter valve is
//      not a pause);
//   §4 a follow is a READ — the host terminal's own transcript gains ZERO
//      rows during the follow, and the followed transcript stays a strict
//      prefix-extension of itself (the runner's own writes only).
//  Fixture-hermetic: scratch home + daemon dir + workspace; the fixture API
//  is the provider for BOTH processes; nothing touches the operator's estate.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

// realpath: macOS mkdtemp hands back a symlinked /var path; every project-
// dir derivation keys on the RESOLVED cwd (/private/var…).
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'enter-live-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
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

// The provider both processes speak to: the WORKER's turn is a long paced
// stream (the thought the operator enters INTO); the UI's own turns are
// never sent in this journey.
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// The turn is a MULTI-MESSAGE thought: the SDK child writes each assistant
// message to disk when it completes (never mid-stream), so a follow paints
// per landing — text → a slow tool call → text → a slow tool call → text
// gives the operator's terminal several landings to repaint across ~20s
// while the runner is unmistakably mid-turn (tool_use unresolved).
const api = await startFixtureApi([
  { kind: 'paced_tool_use', preDeltas: ['stage-01 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 6; echo one', description: 'pause one' } }] },
  { kind: 'paced_tool_use', preDeltas: ['stage-02 live-body. '], gapMs: 300, tools: [{ name: 'Bash', input: { command: 'sleep 6; echo two', description: 'pause two' } }] },
  { kind: 'paced', deltas: ['stage-03 live-body. ', 'stage-04 live-body. '], gapMs: 400, settleDelayMs: 1500 },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
/** ONE config home for the daemon AND the UI: the worker's transcript lives
 *  under getProjectDir(workspaceId) beneath the config home, and the UI
 *  reads it by that same derivation — so the daemon boots with the ARENA's
 *  config home (spawned from seedHome, which runs before the UI child). */
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
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
let sessionId = ''
let transcript = ''
try {
  // ── the REAL UI boots on the same daemon; the operator enters mid-thought ─
  const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
  const hostTranscriptRows = (dir: string): { rows: number; digest: string } => {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      let rows = 0
      const parts: string[] = []
      for (const f of files) {
        const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
        rows += lines.length
        const types = lines.map(l => {
          try {
            const d = JSON.parse(l) as Record<string, unknown>
            const sid = typeof d.sessionId === 'string' ? `@${d.sessionId.slice(0, 8)}` : ''
            const kind =
              typeof d.type === 'string' ? d.type : typeof d.kind === 'string' ? `k:${d.kind}` : Object.keys(d).slice(0, 4).join('+')
            return `${kind}${sid}`
          } catch {
            return '!'
          }
        })
        parts.push(`${f}: ${types.join(',')}`)
      }
      return { rows, digest: parts.join(' | ') }
    } catch {
      return { rows: 0, digest: '' }
    }
  }
  const run = await runArtifactArena({
    turns: [],
    // The session's row lists on the board (same project); the journey
    // walks the ruled L17 grammar: tab to the list → ↵ ARMS the selected
    // row ("click Enter once and it selects it") → ↵ enters and follows.
    sends: [
      'after:Enter live probe:1200:\t',
      'after:Enter live probe:1900:\r',
      'after:Enter live probe:2600:\r',
    ],
    seconds: 26,
    cols: 140,
    rows: 40,
    keep: true,
    // The arena keeps ITS OWN config home (its trust seed lives there); it
    // shares OUR daemon + provider through the env. The daemon's transcript
    // home is the workspace-keyed project dir under OUR home — the UI reads
    // it by absolute path from the worker record (getProjectDir(workspaceId)
    // resolves under MERCURY_CONFIG_DIR, so the arena needs the same home
    // for THAT read); hence the arena's home IS our home, and we seed the
    // arena cwd's trust into it.
    seedHome: async (configDir, cwd) => {
      seedFirstRun(configDir, [cwd, work])
      spawnDaemonWithHome(configDir)
      check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      // ── admit + deliver the SLOW turn ───────────────────────────────────
      const dispatched = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: 'enter-live-1',
        prompt: 'stream a long body',
        // The ARENA'S OWN project: the board is PROJECT-SCOPED (the ratified
        // control-plane geometry) and this journey proves the ENTER+FOLLOW
        // law — a same-project row sits ON the board. (The cross-project
        // DOOR is its own estate: prove-cross-project owns it, and ↵ on a
        // door row currently no-ops at head — stop-noted to the lead.)
        workspaceDir: cwd,
        title: 'Enter live probe',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string; state?: string }
      check('the session dispatched (working)', dispatched.ok === true && dispatched.sessionId !== undefined, JSON.stringify(dispatched))
      sessionId = dispatched.sessionId ?? ''
      transcript = join(paths.getProjectDir(cwd), `${sessionId}.jsonl`)
      check('the worker transcript was born at the law home', await untilAsync(async () => existsSync(transcript) && statSync(transcript).size > 200, 30_000), transcript)
      check(
        'the runner is mid-thought (the first stage landed; the tool call is unresolved)',
        await untilAsync(async () => readFileSync(transcript, 'utf8').includes('stage-01 live-body'), 30_000),
      )
      const recBefore = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
      check('the record is WORKING before the enter (no pausedAt)', recBefore !== undefined && recBefore.pausedAt === undefined && recBefore.attachedAt === undefined)
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
    const offsets = [3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000].map(m => S(m))
    const grabs = grabScreens(run, 140, 40, offsets)
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    if (process.env.ENTER_LIVE_KEEP === '1') {
      for (const g of grabs) {
        console.log(`\n═══ frame @${g.atMs}`)
        for (const r of g.rows) if (r.trim()) console.log(r.slice(0, 138))
      }
    }
    // §1 the live transcript paints INSIDE the entered view (the concourse
    // header is absent; streamed tokens are on screen; later frames carry
    // later tokens = it keeps painting).
    const entered = grabs.filter(g => !text(g).includes('SESSION CONCOURSE') && /stage-\d\d live-body/.test(text(g)))
    check('§1 the entered view paints the live transcript', entered.length > 0, `entered frames: ${entered.map(g => g.atMs).join(',') || 'none'}`)
    const tokenMax = (g: { rows: string[] }): number =>
      Math.max(-1, ...[...text(g).matchAll(/stage-(\d\d) live-body/g)].map(m => Number(m[1])))
    const maxes = entered.map(tokenMax)
    check('§1 …and keeps painting as the thought grows (later frames carry later stages)', maxes.length >= 2 && maxes[maxes.length - 1]! > maxes[0]!, `stage highs: ${maxes.join(',')}`)
    // §2 the lift: the header carries the working spinner + elapsed / verb
    // (the FollowBanner is the follow grammar; the LIFT is the spinner row
    // above the composer with the elapsed seconds — present only when
    // isLoading is up).
    const lifted = entered.filter(g => /\b\d+s\b/.test(text(g)) && /esc|interrupt|thinking|✳|✶|responding/i.test(text(g)))
    check('§2 THE ONE THINKING LIFT is up while the followed runner works', lifted.length > 0, `lifted frames: ${lifted.map(g => g.atMs).join(',') || 'none'}`)
    // §3 the record never reads PAUSED during the drain.
    const recDuring = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sessionId)
    const { concourseRecordState } = await import('../../src/services/concourse/concourseSnapshot.ts')
    const stateDuring = recDuring ? concourseRecordState(recDuring, { needsYou: false, alive: true }) : 'missing'
    check("§3 the record never reads PAUSED while the operator watches (enter valve ≠ pause)", stateDuring !== 'paused', `state=${stateDuring} attachRequestedAt=${recDuring?.attachRequestedAt} pausedAt=${recDuring?.pausedAt}`)
    // §4 the read law: the host terminal's own transcript home gained no
    // rows during the follow; the followed transcript is the runner's alone.
    // Same-project now: the FOLLOWED transcript lives in the host project
    // home by construction — the read law asserts the host wrote no OTHER
    // file (every .jsonl there is the followed session's own).
    const hostHome = paths.getProjectDir(run.paths.cwd)
    const foreignFiles = ((): string[] => {
      try {
        return readdirSync(hostHome).filter(f => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`)
      } catch {
        return []
      }
    })()
    check('§4 the host terminal wrote ZERO transcript rows of its own during the follow (a follow is a READ)', foreignFiles.length === 0, `${hostHome}: ${foreignFiles.join(',')}`)
    const followedText = readFileSync(transcript, 'utf8')
    check("§4 the followed transcript carries no synthetic continuation rows", !followedText.includes('Continue from where you left off') && !followedText.includes('No response requested'))
    check("§4 the followed transcript carries no foreign session id", !followedText.split('\n').some(l => l.includes('"sessionId"') && !l.includes(sessionId)))
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
  if (process.env.ENTER_LIVE_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-enter-live-journey: ALL LAWS HOLD' : `\nprove-enter-live-journey: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
