#!/usr/bin/env bun
// ============================================================================
//  prove-crash-visible-drive — THE SESSION-END VISIBILITY LAW on the real
//  product (the operator's word: "sessions never silently
//  vanish"): a session's end is a VISIBLE state — finished paints READY TO
//  REVIEW, crashed paints NEEDS YOU with the reason line, and only the
//  operator's own release removes a row.
//
//  Two legs against a real daemon + the scripted-stream fixture:
//   A  LIVE-DAEMON CRASH — two counting sessions on the board (real UI, PTY
//      arena); both workers SIGKILLed mid-count under the LIVE daemon. The
//      frames must show the pair as NEEDS YOU with the crash reason —
//      never the pre-fix READY TO REVIEW masquerade (the silent
//      respawn + settled-stamp), and never a vanished row.
//   B  WHOLE-TREE CRASH + REBOOT — workers and daemon SIGKILLed, a fresh
//      daemon boots on the same records dir (the operator's reboot). The
//      boot reconcile must stamp the CRASH fact and KEEP the rows: the
//      board snapshot carries both sessions as NEEDS YOU ('found dead'),
//      and only settleConcourseWorker (the operator's release) drops one.
//      Poison = the pre-fix endedAt sweep that emptied the board.
// ============================================================================
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'crash-visible-'))
const daemonDir = join(SCRATCH, 'daemon')
// THE BOARD IS PROJECT-SCOPED (the control-plane model): the product boots in
// the arena cwd and its board shows THAT project's sessions only, so both
// crash subjects run there. The ground is made a REAL git repo and beta's
// launch is DEFAULTED: the coexistence law refuses read-only beside an
// exclusive claim, and the ruling-1 road answers a defaulted collision on a
// git ground with a silent worktree fork — the mainline second session, on
// the same board. Assigned once the arena mints its cwd.
let work = join(SCRATCH, 'work-alpha')
let workB = join(SCRATCH, 'work-beta')
for (const d of [daemonDir, work, workB]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
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
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const countingTurn = (n: number) => ({
  kind: 'paced_tool_use' as const,
  preDeltas: [`counting ${String(n).padStart(3, '0')} `, 'still going '],
  gapMs: 400,
  tools: [{ name: 'Bash', input: { command: `sleep 3; echo tick-${n}`, description: 'one counted beat' } }],
  whenModel: 'opus',
})
const api = await startFixtureApi([
  ...Array.from({ length: 24 }, (_, i) => countingTurn(i + 1)),
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemon = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn('node', [DIST, 'daemon', 'run', work], {
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

// PROVER DEADLINE (the hang law — gate run 33148028015 wedged shard 6 on this
// drive): every wait below carries its own bound, but a half-open daemon
// socket wedges a single RPC await outside those bounds, and a child that
// never spawns never emits 'exit'. The unref'd timer fires only while
// something still holds the loop — exactly the wedge — and turns it into a
// loud bounded red instead of a tree-killed shard.
const PROVER_DEADLINE_MS = 240_000
const reapDaemon = (): void => {
  try {
    if (daemon?.pid !== undefined) process.kill(daemon.pid, 'SIGKILL')
  } catch {
    /* down */
  }
}
const watchdog = setTimeout(() => {
  console.error(`\n[watchdog] prover deadline ${PROVER_DEADLINE_MS / 1000}s — failing loud (the hang law)`)
  reapDaemon()
  process.exit(124)
}, PROVER_DEADLINE_MS)
watchdog.unref()
const bail = (why: string): never => {
  console.error(`  [bail] ${why} — failing loud without the wait ladder`)
  reapDaemon()
  process.exit(1)
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
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
const workerPids = (): Array<{ runnerId: string; pid?: number }> => {
  try {
    const raw = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as {
      workers: Record<string, { pid?: number; runnerId: string }>
    }
    return Object.values(raw.workers)
  } catch {
    return []
  }
}

// ── leg A: the live-daemon crash, on the real board ─────────────────────────
console.log('leg A — live-daemon crash paints NEEDS YOU + reason (no vanish, no ready-to-review lie)')
let alphaId = ''
let betaId = ''
// The workers are SIGKILLed the moment both records carry live pids and the
// counting is demonstrably rolling (state-anchored, not clock-anchored).
const killLeg = (async () => {
  await untilAsync(() => workerPids().filter(w => w.pid !== undefined).length >= 2, 60_000)
  await new Promise(r => setTimeout(r, 9_000)) // a few counted beats on screen
  for (const w of workerPids()) {
    if (w.pid !== undefined) {
      try {
        process.kill(w.pid, 'SIGKILL')
        console.log(`  [info] SIGKILLed ${w.runnerId} pid ${w.pid}`)
      } catch {
        /* already down */
      }
    }
  }
})()
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [],
  seconds: 38,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, _cwd) => {
    work = _cwd
    workB = _cwd
    // The ground becomes a real repo (one seed commit — a worktree fork
    // needs a born HEAD), so beta's defaulted collision forks lawfully.
    execSync('git init -q && git -c user.email=crashvis@proof.invalid -c user.name=crashvis commit -q --allow-empty -m seed', {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    seedFirstRun(configDir, [_cwd, work, workB])
    spawnDaemon(configDir)
    const served = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000)
    check('the daemon serves', served)
    if (!served) bail('the daemon never served')
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'crashvis-alpha',
      prompt: 'count slowly with sleeps',
      workspaceDir: work,
      title: 'Alpha count',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('alpha dispatched', a.ok === true, JSON.stringify(a))
    if (a.ok !== true) bail('alpha refused — the crash pair never staged')
    alphaId = a.sessionId ?? ''
    const alphaTranscript = join(paths.getProjectDir(work), `${alphaId}.jsonl`)
    check('alpha transcript born', await untilAsync(() => existsSync(alphaTranscript) && statSync(alphaTranscript).size > 100, 30_000))
    const b = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'crashvis-beta',
      prompt: 'count slowly with sleeps too',
      workspaceDir: workB,
      title: 'Beta count',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('beta dispatched (defaulted → the worktree fork)', b.ok === true, JSON.stringify(b))
    if (b.ok !== true) bail('beta refused — the crash pair never staged')
    betaId = b.sessionId ?? ''
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
  },
})
await killLeg
{
  const grabs = grabScreens(run, 120, 40, [8000, 20000, 26000, 32000, 36000].map(m => S(m)))
  const KEEP_DIR = process.env.MERCURY_CRASHVIS_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    for (const g of grabs) {
      writeFileSync(join(KEEP_DIR, `legA-at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n'))
    }
  }
  const text = (g: { rows: string[] }): string => g.rows.join('\n')
  const late = grabs.filter(g => g.atMs >= 20000 && text(g).includes('SESSIONS'))
  check('the board painted after the kill', late.length >= 2, `frames: ${late.map(g => g.atMs).join(',')}`)
  const bothRows = (g: { rows: string[] }): boolean => text(g).includes('Alpha count') && text(g).includes('Beta count')
  check('NO VANISH — both rows stand in every post-kill frame (poison: the silent removal)', late.every(bothRows), late.map(g => `${g.atMs}:${bothRows(g)}`).join(' '))
  const needsYou = late.filter(g => /NEEDS YOU/.test(text(g)) && /crashed mid-run/.test(text(g)))
  check('the pair paints NEEDS YOU with the crash reason line', needsYou.length >= 1, `frames: ${needsYou.map(g => g.atMs).join(',') || 'none'}`)
  const reviewLie = late.filter(g => {
    const alphaRow = g.rows.find(r => r.includes('Alpha count')) ?? ''
    const betaRow = g.rows.find(r => r.includes('Beta count')) ?? ''
    return /READY TO REVIEW/.test(text(g)) && /●/.test(alphaRow) && /●/.test(betaRow) && !/NEEDS YOU/.test(text(g))
  })
  check('…never the READY TO REVIEW masquerade (poison: the pre-fix settled-stamp lie)', reviewLie.length === 0, reviewLie.map(g => String(g.atMs)).join(','))
}
// The arena home + cwd LIVE until leg B ends: the reboot daemon spawns at the
// arena cwd, and the old leg-A cleanup handed it a DELETED working directory
// (posix_spawn ENOENT wears the binary's name for a missing cwd — the latent
// bug the wedge always masked). Cleaned with the scratch sweep below.

// ── leg B: whole-tree crash + reboot — the rows survive the reconcile ──────
console.log('leg B — reboot reconcile keeps the rows as NEEDS YOU; only release removes')
// The daemon dies FIRST: a daemon that outlives its screen parks every
// record on its owner-orphaned road (the operator closed the screen —
// nothing about that is a crash), and on a slow runner that park landed
// between leg A's capture ending and this kill, so the reboot read the
// records parked. A whole-tree crash kills the daemon with its workers;
// the order here makes the crash the only fact the reconcile can find.
if (daemon?.pid !== undefined) {
  try {
    process.kill(daemon.pid, 'SIGKILL')
  } catch {
    /* down */
  }
}
for (const w of workerPids()) {
  if (w.pid !== undefined) {
    try {
      process.kill(w.pid, 'SIGKILL')
    } catch {
      /* down */
    }
  }
}
await new Promise(r => setTimeout(r, 800))
const home2 = join(SCRATCH, 'home2')
mkdirSync(home2, { recursive: true })
seedFirstRun(home2, [work, workB])
spawnDaemon(home2)
check('daemon2 serves (the reboot)', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
const sup = await import('../../src/daemon/concourseSupervisor.ts')
check(
  'the boot reconcile keeps the CRASH fact on both records (endedAt UNSET — rows kept)',
  await untilAsync(() => {
    const recs = Object.values(sup.readSessionWorkers(daemonDir)).filter(r => r.sessionId === alphaId || r.sessionId === betaId)
    return recs.length === 2 && recs.every(r => r.crash !== undefined && r.endedAt === undefined)
  }, 30_000),
  JSON.stringify(Object.values(sup.readSessionWorkers(daemonDir)).map(r => ({ w: r.runnerId, crash: r.crash?.reason, endedAt: r.endedAt }))),
)
// The snapshot builder is the board's one row source — reading it here IS
// the reboot board. Config reads arm first (the prover's own boot boundary).
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const snapshot = await import('../../src/services/concourse/concourseSnapshot.ts')
const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
const snap = await snapshot.buildConcourseSnapshot({ recordsDir: daemonDir, project: projectIdentity(work) })
const boardRows = snap.groups.flatMap((g: { rows: Array<{ sessionId: string; state: string; nowLabel: string | null }> }) => g.rows)
const crashedRows = boardRows.filter(r => r.sessionId === alphaId || r.sessionId === betaId)
check('the reboot board carries BOTH sessions', crashedRows.length === 2, JSON.stringify(boardRows.map(r => r.sessionId)))
check(
  // The reason may be the roster's own mid-run stamp (leg A's episode
  // lawfully persists — one crash, one fact) or the reconcile's found-dead
  // line on a fresh crash; either way the row is NEEDS YOU + a crash line.
  'both paint NEEDS YOU with a crash reason line',
  crashedRows.every(r => r.state === 'needs-you' && /crashed/.test(r.nowLabel ?? '')),
  JSON.stringify(crashedRows.map(r => ({ state: r.state, now: r.nowLabel }))),
)
// Only the operator's own release removes a row.
const victimWorker = Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === alphaId)
check('release (the operator\'s x x) settles the row', victimWorker !== undefined && sup.settleConcourseWorker(victimWorker.runnerId, daemonDir) === true)
const snap2 = await snapshot.buildConcourseSnapshot({ recordsDir: daemonDir, project: projectIdentity(work) })
const after = snap2.groups.flatMap((g: { rows: Array<{ sessionId: string; state: string }> }) => g.rows)
const alphaAfter = after.filter(r => r.sessionId === alphaId)
const betaAfter = after.filter(r => r.sessionId === betaId)
check(
  // L11 (nothing is ever removed): release settles the RUNNER and clears the
  // crash CLAIM — alpha may stand on as a parked past chat, but never as
  // NEEDS YOU; beta's own claim is untouched. (The pre-L11 spelling demanded
  // the whole row vanish — the retired board semantics.)
  '…and only then does alpha\'s crash claim clear (row may park, never NEEDS YOU) — beta stays crashed',
  alphaAfter.every(r => r.state !== 'needs-you') && betaAfter.length >= 1 && betaAfter.every(r => r.state === 'needs-you'),
  JSON.stringify(after.map(r => ({ id: r.sessionId.slice(0, 8), state: r.state }))),
)

try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
  /* down */
}
daemon?.kill('SIGTERM')
await api.close()
reapDaemon()
run.cleanup()
const { rmSync } = await import('node:fs')
rmSync(SCRATCH, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-crash-visible-drive: ALL LAWS HOLD' : `\nprove-crash-visible-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
