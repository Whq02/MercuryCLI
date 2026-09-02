#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-warm-parity.ts — PARITY 1:1 (the trio's line
//  10, warm edition): a CLAIMED warm runner is indistinguishable from a
//  cold-spawned one. One live scratch daemon hosts both: workspace A's
//  session lands on a pre-warmed runner (the claim path), workspace B's
//  spawns cold; both run the SAME fixture turn on the SAME model. The
//  session transcript, the daemon-published facts projection and the
//  durable worker record must then be byte-identical once identity and
//  clocks are normalised (ids, timestamps, pids, paths, durations). The
//  first differing line pair prints on any mismatch.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'warm-parity-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const wsClaimed = join(SCRATCH, 'ws-claimed')
const wsCold = join(SCRATCH, 'ws-cold')
for (const d of [home, daemonDir, wsClaimed, wsCold]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'

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
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [wsClaimed, wsCold])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
// The SAME turn served twice — one per session, order-independent.
const api = await startFixtureApi([
  { kind: 'text', text: 'The parity reply, identical for both sessions.' },
  { kind: 'text', text: 'The parity reply, identical for both sessions.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', wsClaimed], {
  cwd: wsClaimed,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: api.url,
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
  },
  stdio: ['ignore', logFd, logFd],
})

/** Identity/clock normalisation: everything that MAY differ between two
 *  equal sessions collapses to a token; every remaining byte must match. */
function normalize(text: string): string {
  return text
    .replaceAll(wsClaimed, '<WS>')
    .replaceAll(wsCold, '<WS>')
    // BOARD CONTROLS item 6: the dispatched prompt opens with the ground
    // note, which names the workspace by its BASENAME — identity, so it
    // collapses to a token exactly like the full paths above.
    .replaceAll('ws-claimed', '<WSNAME>')
    .replaceAll('ws-cold', '<WSNAME>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>')
    .replace(/msg_[A-Za-z0-9_]+/g, 'msg_<ID>')
    .replace(/req_[A-Za-z0-9_]+/g, 'req_<ID>')
    .replace(/concourse-w\d+/g, 'concourse-w<N>')
    .replace(/"pid":\s*\d+/g, '"pid":<P>')
    .replace(/"(atMs|resolvedAt|spawnedAt|lastLiveAt|lastDeliveryAt|lastTurnSettledAt|startedAt|askedAt|totalDurationMs|totalAPIDurationMs|durationMs|duration_ms|snapshotId)":\s*("[^"]*"|\d+(?:\.\d+)?)/g, '"$1":<VAR>')
    .replace(/"(costUSD|totalCostUSD|total_cost_usd)":\s*\d+(?:\.\d+)?(e-?\d+)?/g, '"$1":<COST>')
}

/** First differing line pair, for the honest failure message. */
function firstDiff(a: string, b: string): string {
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}:\n  claimed: ${(la[i] ?? '<absent>').slice(0, 220)}\n  cold:    ${(lb[i] ?? '<absent>').slice(0, 220)}`
    }
  }
  return 'no line diff (lengths equal)'
}

try {
  const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  // ── the claimed session: warm first, then dispatch ──
  const warmed = (await daemonControlRpc({ op: 'concourseWarm', workspaceDir: wsClaimed } as never)) as { ok?: boolean; state?: string; detail?: string }
  check('workspace A warms a runner', warmed.ok === true && (warmed.state === 'warmed' || warmed.state === 'kept'), JSON.stringify(warmed))
  const daemonLog = (): string => {
    try {
      return readFileSync(join(SCRATCH, 'daemon.log'), 'utf8')
    } catch {
      return ''
    }
  }
  const warmLine = (): string | undefined => daemonLog().split('\n').find(l => l.includes('warm runner pre-spawned') && l.includes(wsClaimed))
  check('the pre-spawn is named', await untilAsync(() => warmLine() !== undefined, 10_000))
  const warmShort = /pre-spawned: (concourse-w\d+)/.exec(warmLine() ?? '')?.[1] ?? ''
  check('the warm runner reaches ready before the claim', await untilAsync(async () => {
    const h = (await daemonControlRpc({ op: 'has', proto: 1, short: warmShort } as never)) as { ready?: boolean }
    return h.ready === true
  }, 45_000))

  const dispatch = async (workspaceDir: string, id: string): Promise<{ sessionId: string; workerId: string }> => {
    const d = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: id,
      prompt: 'run the parity turn',
      workspaceDir,
      modelKey: 'claude-opus-5',
      effort: 'high',
      title: 'Parity probe',
    } as never)) as { ok?: boolean; sessionId?: string; workerId?: string; error?: string }
    check(`${id} dispatches`, d.ok === true && typeof d.sessionId === 'string', JSON.stringify(d))
    return { sessionId: d.sessionId ?? '', workerId: d.workerId ?? '' }
  }

  const claimed = await dispatch(wsClaimed, 'parity-claimed')
  check('the claimed session rode the warm runner (claim-over-spawn, live)', claimed.workerId === warmShort, `admitted ${claimed.workerId}, warm was ${warmShort}`)
  const cold = await dispatch(wsCold, 'parity-cold')
  check('the cold session spawned its own runner', cold.workerId !== warmShort && cold.workerId !== '', cold.workerId)

  // The transcript is found BY SESSION ID over the whole projects root: the
  // prover runs under bun while the runner is node, and an overlong scratch
  // path slugs with DIFFERENT hash suffixes per runtime (the tree's own
  // findProjectDir carries the tolerant prefix-scan for exactly this) — a
  // strict getProjectDir read here would miss the runner's real directory.
  const projectsRoot = join(home, 'projects')
  const transcriptOf = (sid: string): string | null => {
    if (!existsSync(projectsRoot)) return null
    for (const entry of readdirSync(projectsRoot)) {
      const candidate = join(projectsRoot, entry, `${sid}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const settled = (sid: string): boolean => {
    const path = transcriptOf(sid)
    return path !== null && readFileSync(path, 'utf8').includes('The parity reply, identical for both sessions.')
  }
  check('the claimed session settled its turn', await untilAsync(() => settled(claimed.sessionId), 60_000))
  check('the cold session settled its turn', await untilAsync(() => settled(cold.sessionId), 60_000))

  // ── the transcript diff ──
  const tClaimed = normalize(readFileSync(transcriptOf(claimed.sessionId) ?? '/nonexistent', 'utf8'))
  const tCold = normalize(readFileSync(transcriptOf(cold.sessionId) ?? '/nonexistent', 'utf8'))
  check('PARITY the transcripts are byte-identical modulo ids/clocks', tClaimed === tCold, tClaimed === tCold ? '' : firstDiff(tClaimed, tCold))

  // ── the facts diff (the daemon-published projection of each session) ──
  const factsOf = (sid: string): string => join(daemonDir, 'session-facts', `${sid}.json`)
  check('both facts projections published', await untilAsync(() => existsSync(factsOf(claimed.sessionId)) && existsSync(factsOf(cold.sessionId)), 20_000))
  // Both sessions idle: busy flips settle within the facts cadence.
  await untilAsync(() => {
    const a = JSON.parse(readFileSync(factsOf(claimed.sessionId), 'utf8')) as { busy?: boolean }
    const b = JSON.parse(readFileSync(factsOf(cold.sessionId), 'utf8')) as { busy?: boolean }
    return a.busy === false && b.busy === false
  }, 20_000)
  const fClaimed = normalize(JSON.stringify(JSON.parse(readFileSync(factsOf(claimed.sessionId), 'utf8')), null, 1))
  const fCold = normalize(JSON.stringify(JSON.parse(readFileSync(factsOf(cold.sessionId), 'utf8')), null, 1))
  check('PARITY the facts projections are identical modulo ids/clocks', fClaimed === fCold, fClaimed === fCold ? '' : firstDiff(fClaimed, fCold))

  // ── the record diff (the durable board row) ──
  const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
  const records = readSessionWorkers(daemonDir)
  const rowOf = (workerId: string): string => normalize(JSON.stringify(records[workerId] ?? {}, null, 1))
  check('PARITY the worker records are identical modulo ids/clocks', rowOf(claimed.workerId) === rowOf(cold.workerId), rowOf(claimed.workerId) === rowOf(cold.workerId) ? '' : firstDiff(rowOf(claimed.workerId), rowOf(cold.workerId)))
} finally {
  try {
    await (await import('../../src/daemon/controlSocket.ts')).daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* already down */
  }
  daemon.kill('SIGTERM')
  await api.close()
  if (process.env.WARM_PARITY_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-warm-parity: ALL LAWS HOLD' : `\nprove-warm-parity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
