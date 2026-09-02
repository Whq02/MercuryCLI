#!/usr/bin/env bun
// ============================================================================
//  prove-busy-stall-drive — B16's DRIVEN half (the queue's dead-runner
//  drive): the chat's turn indicator over a runner that DIED mid-turn
//  settles idle through the deadline road, on the REAL artifact.
//
//  The staged death (the class exactly): a daemon-hosted session runs a
//  turn whose wire HANGS (fixture 'hang' — bytes then an open stream), so
//  its facts say busy; the WHOLE tree (worker + daemon) is SIGKILLed — the
//  facts file freezes at busy, the feed goes quiet, and nothing will ever
//  write busy:false. The attached chat must not spin forever: 45s after the
//  last facts movement the connector's ONE probe finds no live answer and
//  settles the live view idle (daemonConnector settleStalledTurn).
//
//  Verdicts:
//   · GROUND TRUTH (required): the debug log carries the settle line —
//     'busy turn stalled 45000ms … settling idle' — the deadline road
//     fired, not any other settle.
//   · FRAMES (kept): pre-kill the attached chat stands; the post-deadline
//     grab differs from the frozen-busy grab. Captures land in the kept
//     dir for the eye.
//
//  DRIVEN — runs only inside a granted PTY window (the box law); wall time
//  ≈ 95s (attach ≈15s + the 45s deadline + margin).
//  Run: ~/.bun/bin/bun run scripts/engine-connector/prove-busy-stall-drive.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SUITE GUARD: this suite is gate-class cpu — a 95s PTY drive must never
// ride a pooled run. The drive is OPT-IN (the granted window sets it); the
// pooled suite sees a skip, exit 0 (prove-busy-stall-deadline is the
// suite's standing structural pin).
if (process.env.BUSY_STALL_DRIVE !== '1') {
  console.log('prove-busy-stall-drive: SKIPPED (driven — set BUSY_STALL_DRIVE=1 inside a granted PTY window)')
  process.exit(0)
}

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

// EVERY turn hangs: bytes land (the turn is real, busy is real), the stream
// never closes — the worker stays mid-turn until it is killed.
const api = await startFixtureApi([
  { kind: 'hang', deltas: ['holding this turn open…'] },
  { kind: 'hang', deltas: ['still holding…'] },
])

const daemonDir = join(mkdirSyncTemp('busy-stall-daemon'), 'daemon')
mkdirSync(daemonDir, { recursive: true })
function mkdirSyncTemp(tag: string): string {
  const d = join(tmpdir(), `${tag}-${process.pid}`)
  mkdirSync(d, { recursive: true })
  return d
}
process.env.MERCURY_DAEMON_DIR = daemonDir
const logFd = openSync(join(daemonDir, 'drive-daemon.log'), 'a')

let daemon: ReturnType<typeof spawn> | null = null
let work = ''
let sessionId = ''
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
const factsBusy = (): boolean => {
  try {
    const facts = JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sessionId}.json`), 'utf8')) as { busy?: boolean }
    return facts.busy === true
  } catch {
    return false
  }
}
const reap = (): void => {
  for (const w of workerPids()) {
    if (w.pid !== undefined) {
      try {
        process.kill(w.pid, 'SIGKILL')
      } catch {
        /* down */
      }
    }
  }
  try {
    if (daemon?.pid !== undefined) process.kill(daemon.pid, 'SIGKILL')
  } catch {
    /* down */
  }
}
const watchdog = setTimeout(() => {
  console.error('\n[watchdog] prover deadline 220s — failing loud (the hang law)')
  reap()
  process.exit(124)
}, 220_000)
watchdog.unref()

// The kill leg: anchored to the ARENA'S OWN BOOT (the tee file's birth),
// never the prover's start — the first cut killed during seedHome and the
// chat booted onto an already-dead world (the board's 'its process is
// gone' road answered instead of B16's). Order: worker live + facts busy
// + the arena booted + 15s of arena time (the tab/enter sends land by
// ~12s), THEN the whole tree dies.
const KILL_AT_ARENA_MS = 15_000
let teePathForKill = ''
const killLeg = (async () => {
  const staged = await untilAsync(() => workerPids().some(w => w.pid !== undefined) && factsBusy(), 90_000)
  if (!staged) {
    console.error('  [bail] the worker never staged busy — nothing to kill')
    return
  }
  const booted = await untilAsync(() => teePathForKill !== '' && existsSync(teePathForKill), 90_000)
  if (!booted) {
    console.error('  [bail] the arena never booted — nothing to drive')
    return
  }
  const arenaBootAt = Date.now()
  await new Promise(r => setTimeout(r, KILL_AT_ARENA_MS))
  reap()
  console.log(`  [info] tree SIGKILLed at arena+${Date.now() - arenaBootAt}ms (facts frozen busy)`)
})()

const runPromise = runArtifactArena({
  turns: [],
  // Time-anchored board entry: the boot region is the coordinator (the
  // arrow-focus law keeps its enter OFF the rows) — tab to the list, then
  // the arm/enter pair; the attached chat by ~12s.
  sends: ['8500:\t', '10000:\r', '11500:\r'],
  seconds: 92,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, cwd) => {
    work = cwd
    execSync('git init -q && git -c user.email=busy@proof.invalid -c user.name=busy commit -q --allow-empty -m seed', {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    seedFirstRun(configDir, [work])
    process.env.MERCURY_CONFIG_DIR = configDir
    daemon = spawn('node', [DIST, 'daemon', 'run', work], {
      cwd: work,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: configDir,
        MERCURY_DAEMON_DIR: daemonDir,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: api.url,
        MERCURY_CACHE_CLOCK: '0',
        MERCURY_PARTY: '0',
      },
      stdio: ['ignore', logFd, logFd],
    })
    const served = await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000)
    check('the daemon serves', served)
    const dispatched = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'busy-stall-hold',
      prompt: 'hold this turn open',
      workspaceDir: work,
      title: 'Hold the turn',
      modelKey: 'claude-opus-5',
      effort: 'xhigh',
    } as never)) as { ok?: boolean; sessionId?: string }
    check('the holding session dispatched', dispatched.ok === true, JSON.stringify(dispatched))
    sessionId = dispatched.sessionId ?? ''
    check('its facts say BUSY (the hanging turn is real)', await untilAsync(() => factsBusy(), 45_000))
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
    DEBUG: '1',
  },
})
// Hand the tee path to the kill leg as soon as the arena settles it; the
// run promise resolves only AFTER the whole capture, so watch the temp
// namespace for the arena's tee birth in parallel.
const proverStartedAt = Date.now()
const teeWatcher = (async () => {
  const { readdirSync: rd, statSync: st } = await import('node:fs')
  const os = await import('node:os')
  const base = os.tmpdir()
  await untilAsync(() => {
    try {
      for (const name of rd(base)) {
        if (!name.startsWith('flux-arena-home-')) continue
        const candidate = join(base, name, 'tee.jsonl')
        // Only THIS run's arena: earlier kept arenas leave stale tees
        // behind — accept a tee born after this prover started.
        if (existsSync(candidate) && st(candidate).mtimeMs > proverStartedAt) {
          teePathForKill = candidate
          return true
        }
      }
    } catch {
      /* keep watching */
    }
    return false
  }, 120_000)
})()
const run = await runPromise
await teeWatcher
await killLeg

// ── verdicts ────────────────────────────────────────────────────────────────
const KEEP_DIR = process.env.BUSY_STALL_CAPTURE_DIR ?? join(tmpdir(), `busy-stall-captures-${process.pid}`)
mkdirSync(KEEP_DIR, { recursive: true })
{
  const grabs = grabScreens(run, 120, 40, [13_000, 24_000, 88_000])
  for (const g of grabs) {
    writeFileSync(join(KEEP_DIR, `at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n') + '\n')
  }
  const text = (g: { rows: string[] } | undefined): string => (g ? g.rows.join('\n') : '')
  const attached = grabs.find(g => g.atMs === 13_000)
  const frozen = grabs.find(g => g.atMs === 24_000)
  const settled = grabs.find(g => g.atMs === 88_000)
  check('pre-kill: the chat ATTACHED (the held prompt on screen, the board header gone)', text(attached).includes('hold this turn open') && !text(attached).includes('STATUS & TITLE'), 'see the kept capture')
  check('post-kill: the frame still stands (the freeze is painted, not a crash)', text(frozen).length > 0)
  check('post-deadline: the frame stands and differs from the frozen-busy paint', text(settled).length > 0 && text(settled) !== text(frozen))

  // GROUND TRUTH: the deadline road itself — the connector's own settle
  // line in the chat process's debug log (DEBUG=1 rides the arena env; the
  // log lands at <config-dir>/debug/<sessionId>.txt, and the arena's config
  // dir sits INSIDE the arena home — walk the home whole, no path guess).
  let settleSeen = false
  let looked = 0
  const walkForSettle = (dir: string, depth: number): void => {
    if (depth > 6 || settleSeen) return
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walkForSettle(p, depth + 1)
        else if (st.size > 0 && st.size < 32 * 1024 * 1024 && (name.endsWith('.txt') || name.endsWith('.log'))) {
          looked++
          const body = readFileSync(p, 'utf8')
          if (body.includes('busy turn stalled') && body.includes('settling idle')) settleSeen = true
        }
      } catch {
        /* unreadable — skip */
      }
      if (settleSeen) return
    }
  }
  walkForSettle(run.paths.home, 0)
  check('GROUND TRUTH: the 45s deadline road fired — the settle line in the debug log', settleSeen, `walked ${looked} log file(s) under ${run.paths.home}`)
  console.log(`  captures kept: ${KEEP_DIR}`)
}

await api.close()
run.cleanup()
console.log(failures === 0 ? '\nprove-busy-stall-drive: ALL LAWS HOLD' : `\nprove-busy-stall-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
