#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-first-byte-drive.ts — the watchdog keeps its word on
//  the REAL daemon and a real runner: a cold ingest is waited for under a
//  budget the status row names, a request that never answers is aborted at
//  the promised budget with a typed row, every reissue paints a row, and a
//  Fable → Opus switch waits as a cold prefix on the new model.
//
//  The loopback is first-byte-fixture-server.ts under NODE (its arms are
//  keyed by the ask). The idle budget is shrunk to 3 s so the drive fits a
//  lock slot; the cold allowance scales the fixture's own prompt size.
//
//    A  THE COLD INGEST: a fresh session's first turn holds the headers for
//       6 s (past the 3 s idle budget) — the seat's wait names the ingest,
//       the model and a budget above 6 s; the turn completes with the reply
//       and no abort row
//    B  THE ABORT: a request that never sends a byte — the typed row lands
//       ("no first byte from Opus 5 after N s"), the reissue is a row too,
//       the fixture sees each held request dropped at the budget, the turn
//       ends and the seat goes idle
//    C  (the reissue rows live in prove-reissue-rows-drive.ts — three
//       attempts need a retries budget this drive's abort arm cannot afford)
//    D  THE DAEMON DOOR: an unknown model id refuses typed, a dispatch
//       spelling the model as `modelKey` refuses typed (the door reads
//       `model`), a session born on Sonnet rides Sonnet, is switched to
//       Opus through the seat verb, and its next ask waits cold on Opus
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-first-byte-drive.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await sleep(everyMs)
  }
  return false
}

const IDLE_MS = 3_000
const HOLD_MS = 6_000

// ── the world ───────────────────────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'firstbyte-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# first-byte fixture\n')
// A folder with a repository admits more than one session (each later one
// forks its own worktree); a plain folder holds exactly one.
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']]) {
  const r = spawnSync('git', args, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  if (r.status !== 0) {
    console.log(`FAIL git ${args.join(' ')} exited ${r.status}`)
    process.exit(1)
  }
}
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { decodeRequestWait } = await import('../../src/services/providers/streamIdleBudget.ts')

type Capture = { kind: string; at: number; arm?: string; model?: string; status?: number; nth?: number }
type Rec = { runnerId: string; sessionId: string; modelKey?: string }
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const readWait = (sid: string): ReturnType<typeof decodeRequestWait> => {
  try {
    const tail = JSON.parse(readFileSync(join(daemonDir, 'session-tail', `${sid}.json`), 'utf8')) as { wait?: unknown }
    return decodeRequestWait(tail.wait)
  } catch {
    return null
  }
}
const transcriptOf = (sid: string): string => {
  const p = join(paths.getProjectDir(work), `${sid}.jsonl`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

// ── the fixture server (node) ───────────────────────────────────────────────
const fixture = spawn('node', [join(import.meta.dir, 'first-byte-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_HOLD_MS: String(HOLD_MS) },
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

// ── the daemon ──────────────────────────────────────────────────────────────
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
    MERCURY_MAX_RETRIES: '1',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const dispatch = async (id: string, prompt: string, modelKey: string, sessionId?: string): Promise<string> => {
  const reply = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: id,
    prompt,
    workspaceDir: work,
    title: `first byte ${id}`,
    model: modelKey,
    effort: 'high',
    ...(sessionId !== undefined ? { sessionId } : {}),
  } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  check(`${id}: dispatched`, reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  return reply.sessionId ?? sessionId ?? ''
}
/** Watch the seat's wait while a request is outstanding: the first
 *  first-byte wait and the first retry wait seen, plus the largest budget. */
const watchWaits = async (sid: string, ms: number, stopWhen: () => boolean): Promise<{ firstByte: ReturnType<typeof decodeRequestWait>; retry: ReturnType<typeof decodeRequestWait> }> => {
  let firstByte: ReturnType<typeof decodeRequestWait> = null
  let retry: ReturnType<typeof decodeRequestWait> = null
  const t0 = Date.now()
  while (Date.now() - t0 < ms && !stopWhen()) {
    const w = readWait(sid)
    if (w?.kind === 'first-byte' && firstByte === null) firstByte = w
    if (w?.kind === 'retry' && retry === null) retry = w
    await sleep(40)
  }
  return { firstByte, retry }
}

console.log('first-byte drive — the watchdog keeps its word on the real daemon')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  console.log('\nA the cold ingest waits under a named budget and completes')
  const a = await dispatch('fb-slow', 'ingest slowly please', 'claude-opus-5')
  const aWaits = await watchWaits(a, HOLD_MS + 20_000, () => transcriptOf(a).includes('slow answer arrived'))
  const aBudget = aWaits.firstByte?.kind === 'first-byte' ? aWaits.firstByte.budgetMs : 0
  check("the seat's wait named the cold ingest on Opus 5 with a budget past the 6 s hold and past the 3 s idle budget", aWaits.firstByte?.kind === 'first-byte' && aWaits.firstByte.cold && aWaits.firstByte.model === 'Opus 5' && aBudget > HOLD_MS && aBudget > IDLE_MS && aWaits.firstByte.promptTokens > 1000, JSON.stringify(aWaits.firstByte))
  console.log(`  [info] cold budget ${aBudget} ms for a ${aWaits.firstByte?.kind === 'first-byte' ? aWaits.firstByte.promptTokens : '?'}-token prompt`)
  check('the turn completed: the slow reply landed, no api_error row', await untilAsync(() => transcriptOf(a).includes('slow answer arrived'), 30_000) && !transcriptOf(a).includes('api_error'), transcriptOf(a).slice(-400))
  check('the fixture held the headers for the hold and was never dropped (the wait outlasted the idle budget lawfully)', wire().some(c => c.kind === 'headers-sent' && c.arm === 'slow') && !wire().some(c => c.kind === 'client-dropped' && c.arm === 'slow'), JSON.stringify(wire().filter(c => c.arm === 'slow')))
  check('the wait cleared once the stream flowed', await untilAsync(() => readWait(a) === null, 5_000))
  check('the seat went idle', await untilAsync(() => readFacts(a)?.busy === false, 10_000))

  console.log('\nB a request that never answers is aborted at the promised budget with a typed row')
  const b = await dispatch('fb-never', 'never answer me', 'claude-opus-5')
  const bWaits = await watchWaits(b, 4_000, () => false)
  const bBudget = bWaits.firstByte?.kind === 'first-byte' ? bWaits.firstByte.budgetMs : aBudget
  check("the seat's wait named the first byte's budget", bWaits.firstByte?.kind === 'first-byte' && bBudget > 0, JSON.stringify(bWaits.firstByte))
  const bDeadline = 2 * bBudget + 30_000
  const bDone = await untilAsync(() => readFacts(b)?.busy === false, bDeadline)
  check(`the turn ended and the seat went idle (within twice the budget + 30 s)`, bDone, JSON.stringify(readFacts(b) ?? null))
  const bRows = transcriptOf(b)
  check("the typed row landed: 'no first byte from Opus 5 after N s (… ingesting uncached)'", /no first byte from Opus 5 after \d+ s \(a [\d.]+k-token prompt ingesting uncached\)/.test(bRows), bRows.slice(-600))
  const drops = wire().filter(c => c.kind === 'client-dropped' && c.arm === 'never')
  const holds = wire().filter(c => c.kind === 'held' && c.arm === 'never')
  check('the fixture saw each held request dropped at the budget (the reissue, then the abort)', holds.length === 2 && drops.length === 2, JSON.stringify({ holds: holds.length, drops: drops.length }))
  const dropGaps = drops.map((d, i) => d.at - (holds[i]?.at ?? d.at))
  check(`each drop landed within the budget + 2 s of its request (measured ${dropGaps.map(g => `${g} ms`).join(', ')})`, dropGaps.length === 2 && dropGaps.every(g => g >= bBudget - 500 && g <= bBudget + 2_000), JSON.stringify({ dropGaps, bBudget }))

  console.log('\nD the daemon door: the named model rides, an unknown one refuses, a misspelled field refuses; the switched turn waits cold on Opus')
  {
    const nonesuch = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'fb-nonesuch', prompt: 'hello', workspaceDir: work, title: 'nonesuch', model: 'claude-nonesuch-9', effort: 'high' } as never)) as { ok?: boolean; error?: string }
    check('an unknown model id refuses typed (unknown-model, the way out named) — never a substitute', nonesuch.ok === false && /unknown-model/.test(nonesuch.error ?? '') && /(did you mean|pick one of)/.test(nonesuch.error ?? ''), JSON.stringify(nonesuch))
    const misspelt = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'fb-misspelt', prompt: 'hello', workspaceDir: work, title: 'misspelt', modelKey: 'claude-sonnet-5', effort: 'high' } as never)) as { ok?: boolean; error?: string }
    check("a dispatch spelling the model as `modelKey` refuses typed (the door reads `model`) — never the registry default in silence", misspelt.ok === false && /`modelKey` is not a field of this door/.test(misspelt.error ?? ''), JSON.stringify(misspelt))
  }
  const d = await dispatch('fb-switch', 'hello there', 'claude-sonnet-5')
  check('the Sonnet turn answered on Sonnet (the fixture saw claude-sonnet-5; the record names it)', await untilAsync(() => transcriptOf(d).includes('fixture answers'), 30_000) && wire().some(x => x.kind === 'answered' && x.arm === 'canned') && wire().filter(x => x.kind === 'anthropic' && x.arm === 'canned').every(x => (x.model ?? '').startsWith('claude-sonnet-5')) && readRec(d)?.modelKey === 'claude-sonnet-5', JSON.stringify({ rec: readRec(d)?.modelKey, models: wire().filter(x => x.arm === 'canned').map(x => x.model) }))
  check('the seat went idle after the Sonnet turn', await untilAsync(() => readFacts(d)?.busy === false, 10_000))
  const switched = (await daemonControlRpc({ op: 'sessionControl', action: 'set-model', sessionId: d, by: 'operator', model: 'claude-opus-5' } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  check('the switch to Opus applied through the seat verb', switched.ok === true && switched.outcome === 'applied', JSON.stringify(switched))
  await sleep(500)
  const followUp = (await daemonControlRpc({ op: 'sessionDispatch', clientMessageId: 'fb-switch-2', prompt: 'ingest slowly please', workspaceDir: '', targetSessionId: d, by: 'operator' } as never)) as { ok?: boolean; error?: string }
  check('the follow-up delivered into the same session', followUp.ok === true, JSON.stringify(followUp))
  const dWaits = await watchWaits(d, HOLD_MS + 20_000, () => transcriptOf(d).includes('slow answer arrived'))
  check("the switched turn's wait is COLD and names Opus 5 with a budget past the hold", dWaits.firstByte?.kind === 'first-byte' && dWaits.firstByte.cold && dWaits.firstByte.model === 'Opus 5' && dWaits.firstByte.budgetMs > HOLD_MS, JSON.stringify(dWaits.firstByte))
  check('the switched turn completed on Opus (the fixture saw claude-opus-5 for the slow ask)', await untilAsync(() => transcriptOf(d).includes('slow answer arrived'), 30_000) && wire().some(x => x.kind === 'headers-sent' && x.arm === 'slow' && (x.model ?? '').startsWith('claude-opus-5')), JSON.stringify(wire().filter(x => x.arm === 'slow').map(x => [x.kind, x.model])))
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ FIRST-BYTE DRIVE — the watchdog keeps its word: the cold ingest waits under a named budget, the silent request is aborted at it with a typed row, every reissue paints a row' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
