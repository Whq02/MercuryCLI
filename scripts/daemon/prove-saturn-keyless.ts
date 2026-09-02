#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-saturn-keyless.ts — SATURN's ACCOUNT-LESS ARM: the schema's keyless source is first-class and honest
//  end to end — derivation, verdict, ticker holds, box validation, screen
//  words — never a borrowed credential-family spelling.
//
//  The laws proven:
//    K1 a keyless presence derives source 'keyless' (never the key-shaped
//       word for a server that takes no key at all), capture = {family,
//       source} exactly.
//    K2 THE REAL ROAD: with a fixture Ollama discovered, the PRODUCTION
//       derivation (no injected reads — router snapshot → local adapter →
//       discovery cache) captures {family:'local', source:'keyless'}.
//    K3 the login-less family's refusal names ITS OWN doors: no server ⇒
//       'unreachable:local — <the probe route>' with code 'unreachable';
//       NEVER '/logins' (local has no login) and never the L26 sentence.
//    K4 THE ONE VERDICT over the account-less arm: server present ⇒ ready;
//       server gone ⇒ 'unreachable' (a keyless family is never 'signed-out'
//       — nothing was ever signed into); keyless never expires (no
//       'expiring'/'expired' under any live facts; a standing limit window
//       still holds as 'rate-limited').
//    K5 fire-time: the ticker holds a keyless fire whose server is gone with
//       HeldFireV1.reason 'unreachable' (both arms: the derivation miss and
//       the verdict), the held line names the local road, and the server's
//       return releases the debt exactly once (the M2 replay law).
//    K6 the box tier admits the widened truth: a keyless account row
//       validates; an 'unreachable' hold row validates.
//    K7 the screen sentence for 'unreachable' speaks the probe road — no
//       sign-in words, no /logins.
//
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-saturn-keyless.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'saturn-keyless-home-'))
const DAEMON_DIR = mkdtempSync(join(tmpdir(), 'saturn-keyless-daemon-'))
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
mkdirSync(DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
// Hermetic local discovery: this box may be running a REAL local server
// (this box's own installed runtime included) — every section pins the
// probe set (fixture root or 'none') so nothing real is ever discovered.
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const acct = await import('../../src/daemon/saturnAccount.ts')
const { deriveScheduleAccountForModel, scheduleAccountVerdict, readLiveAccountFacts } = acct
const saturn = await import('../../src/daemon/saturn.ts')
const { applyConcourseScheduleOp } = saturn
const ticker = await import('../../src/daemon/saturnTicker.ts')
const { tickSaturnOnce } = ticker
const box = await import('../../src/daemon/saturnBoxSchedules.ts')
const { boxScheduleProblem, boxHeldFireProblem } = box
const { updateConcourseWorkers, concourseWorkersPath } = await import(
  '../../src/daemon/concourseSupervisor.ts'
)
const receipts = await import('../../src/services/switchboard/sessionReceipts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = discovery

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// ── the fixture Ollama (the documented shapes; K2's real road) ──────────────
function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const fixture: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', c => {
    body += String(c)
  })
  req.on('end', () => {
    void body
    if (req.url === '/api/tags')
      return json(res, {
        models: [
          {
            name: 'qwen3:1.7b',
            model: 'qwen3:1.7b',
            details: { family: 'qwen3', parameter_size: '2.0B', quantization_level: 'Q4_K_M' },
          },
        ],
      })
    if (req.url === '/api/version') return json(res, { version: '0.33.2' })
    if (req.url === '/api/ps') return json(res, { models: [] })
    if (req.url === '/api/show')
      return json(res, {
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
        parameters: '',
      })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
})
const fixtureRoot: string = await new Promise(resolve => {
  fixture.listen(0, '127.0.0.1', () => {
    const a = fixture.address()
    resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`)
  })
})

// ── §K1 the derivation's account-less arm (injected presence) ───────────────
console.log('§K1 keyless derivation (injected)')
{
  const derived = deriveScheduleAccountForModel('local/qwen3:1.7b', {
    familyOf: () => 'local',
    presenceOf: () => ({ credentialed: true, kind: 'keyless' }) as never,
  })
  check('a keyless presence derives ok', derived.ok === true)
  if (derived.ok) {
    check(
      "the capture is {family:'local', source:'keyless'} exactly — never the key-shaped word",
      derived.account.family === 'local' &&
        (derived.account.source as string) === 'keyless' &&
        Object.keys(derived.account).length === 2,
      JSON.stringify(derived.account),
    )
  }
}

// ── §K2 THE REAL ROAD (fixture server → production derivation) ──────────────
console.log('§K2 the real road: discovered server ⇒ keyless capture (no injected reads)')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${fixtureRoot}`
  await refreshLocalDiscovery({ force: true })
  const { primeLocalDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
  primeLocalDiscovery()
  const real = deriveScheduleAccountForModel('local/qwen3:1.7b')
  check('the production road derives ok with a discovered server', real.ok === true, real.ok ? '' : real.reason)
  if (real.ok) {
    check(
      "the production capture says source 'keyless' (the router's own keyless answer, un-borrowed)",
      (real.account.source as string) === 'keyless' && real.account.family === 'local',
      JSON.stringify(real.account),
    )
  }
}

// ── §K3 the login-less refusal names its own doors ──────────────────────────
console.log('§K3 no server ⇒ the probe route, never a login door')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  const { primeLocalDiscovery } = await import('../../src/utils/router/providerDiscovery.ts')
  primeLocalDiscovery()
  const missed = deriveScheduleAccountForModel('local/ghost')
  check('an undiscovered local model refuses (never throws)', missed.ok === false)
  if (!missed.ok) {
    const code = (missed as { code?: string }).code
    check("the refusal is typed code 'unreachable'", code === 'unreachable', JSON.stringify(missed))
    check("the head is 'unreachable:local'", missed.reason.startsWith('unreachable:local'), missed.reason)
    check(
      'the words are the probe route (servers + MERCURY_LOCAL_BASE_URL)',
      missed.reason.includes('Ollama') && missed.reason.includes('MERCURY_LOCAL_BASE_URL'),
      missed.reason,
    )
    check("NO login door — local has none ('/logins' absent)", !missed.reason.includes('/logins'), missed.reason)
    check('no key door either — the family is keyless by default', !missed.reason.includes('/router key'), missed.reason)
  }
}

// ── §K4 THE ONE VERDICT over the account-less arm ───────────────────────────
console.log('§K4 the verdict: ready / unreachable; keyless never expires, never signs out')
{
  const NOW = Date.parse('2026-08-29T12:00:00Z')
  const keyless = { source: 'keyless' as never }
  const present = { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
  const gone = { credentialed: false, stranded: false, expiresAt: null, refreshable: false }
  check(
    'server present ⇒ ready',
    scheduleAccountVerdict({ account: keyless, nextFireMs: NOW + 60_000, nowMs: NOW, live: present }).state === 'ready',
  )
  const goneVerdict = scheduleAccountVerdict({ account: keyless, nextFireMs: NOW + 60_000, nowMs: NOW, live: gone })
  check(
    "server gone ⇒ 'unreachable' (never the signed-out borrow — nothing was signed into)",
    (goneVerdict.state as string) === 'unreachable',
    goneVerdict.state,
  )
  // Totality: across live-fact combinations a keyless account NEVER yields
  // a sign-in-family state ('expiring'/'expired'/'signed-out'); the limit
  // window still holds honestly.
  let borrowed = 0
  for (const credentialed of [true, false]) {
    for (const stranded of [false, true]) {
      for (const expiresAt of [null, NOW + 30_000]) {
        for (const refreshable of [false, true]) {
          for (const rateLimitedUntil of [undefined, NOW + 90_000]) {
            const v = scheduleAccountVerdict({
              account: keyless,
              nextFireMs: NOW + 60_000,
              nowMs: NOW,
              live: { credentialed, stranded, expiresAt, refreshable, ...(rateLimitedUntil !== undefined ? { rateLimitedUntil } : {}) },
            })
            if (v.state === 'expiring' || v.state === 'expired' || v.state === 'signed-out') borrowed++
          }
        }
      }
    }
  }
  check('keyless never speaks a sign-in state across the fact sweep', borrowed === 0, `${borrowed} borrowed verdicts`)
  check(
    'a standing limit window still holds as rate-limited',
    scheduleAccountVerdict({ account: keyless, nextFireMs: NOW, nowMs: NOW, live: { ...present, rateLimitedUntil: NOW + 90_000 } }).state === 'rate-limited',
  )
  // The assembly is honest for the family too: an injected keyless presence
  // yields credentialed facts with nothing oauth-shaped.
  const facts = readLiveAccountFacts({ family: 'local', source: 'keyless' as never }, {
    presenceOf: () => ({ credentialed: true, kind: 'keyless' }) as never,
  })
  check(
    'assembled live facts: credentialed (server present), never stranded, no expiry',
    facts.credentialed === true && facts.stranded === false && facts.expiresAt === null,
    JSON.stringify(facts),
  )
}

// ── §K5 fire-time: hold 'unreachable', release on return ────────────────────
console.log("§K5 the ticker's account-less holds (both arms) + the release")
{
  const SESSION = 'sess-keyless-1'
  const WORKSPACE = '/scratch/keyless-repo'
  const HOME = getProjectDir(WORKSPACE)
  const KEYLESS_ACCOUNT = { family: 'local', source: 'keyless' } as never
  const seed = (): void => {
    updateConcourseWorkers(workers => {
      for (const key of Object.keys(workers)) delete workers[key]
      workers['concourse-k1'] = {
        schema: 1,
        runnerId: 'concourse-k1',
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        isolation: 'shared',
        modelKey: 'local/qwen3:1.7b',
        spawnedAt: Date.now(),
        lastLiveAt: Date.now(),
      } as never
    }, DAEMON_DIR)
  }
  const rawRecord = (): Record<string, unknown> =>
    (JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, Record<string, unknown>> })
      .workers['concourse-k1']!
  const heldRows = () => ((rawRecord().heldFires ?? []) as Array<Record<string, unknown>>)
  const keylessDeps = {
    deriveAccount: (_modelKey: string) => ({ ok: true as const, account: { ...(KEYLESS_ACCOUNT as object) } as never }),
  }
  const T0 = Date.parse('2026-08-29T12:00:30Z')
  const UNREACHABLE_REFUSAL = 'unreachable:local — no local server lists this model'

  const makePorts = (state: {
    nowMs: number
    server: 'up' | 'gone'
    deriveMiss?: boolean
  }) => {
    const delivered: Array<{ prompt: string }> = []
    const ports = {
      now: () => state.nowMs,
      records: () =>
        Object.values(
          (JSON.parse(readFileSync(concourseWorkersPath(DAEMON_DIR), 'utf8')) as { workers: Record<string, never> }).workers,
        ).filter((r: { endedAt?: number }) => r.endedAt === undefined) as never[],
      liveFacts: () =>
        state.server === 'up'
          ? { credentialed: true, stranded: false, expiresAt: null, refreshable: false }
          : { credentialed: false, stranded: false, expiresAt: null, refreshable: false },
      deriveAccount: (_modelKey: string) =>
        state.deriveMiss === true
          ? ({ ok: false, reason: UNREACHABLE_REFUSAL, code: 'unreachable' } as never)
          : ({ ok: true, account: { ...(KEYLESS_ACCOUNT as object) } } as never),
      deliver: async (d: { prompt: string }) => {
        delivered.push(d)
        return { ok: true }
      },
      birth: async () => ({ ok: true, sessionId: 'born-x' }),
      screenOpen: () => true,
      dir: DAEMON_DIR,
    } as never
    return { ports, delivered }
  }

  // K5a the DERIVATION-MISS arm: the server is gone at fire time, the
  // production derivation refuses code 'unreachable' — the hold says so.
  seed()
  const add = applyConcourseScheduleOp(
    SESSION,
    { op: 'add', schedule: { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'local beat' } } },
    'operator:test',
    keylessDeps as never,
    DAEMON_DIR,
  )
  check('K5 seed: the keyless schedule lands', add.outcome === 'applied', add.outcome)
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      const row = ((r as { schedules?: Array<Record<string, unknown>> }).schedules ?? [])[0]
      if (row) row.createdAt = T0 - 120_000
    }
  }, DAEMON_DIR)
  const s1 = { nowMs: T0, server: 'gone' as 'up' | 'gone', deriveMiss: true }
  const m1 = makePorts(s1)
  const r1 = await tickSaturnOnce(m1.ports)
  check('K5a the due fire held (server gone at derivation)', r1.held === 1 && heldRows().length === 1, `held=${r1.held}`)
  check(
    "K5a the hold reason is 'unreachable' — never the signed-out borrow",
    heldRows()[0]?.reason === 'unreachable',
    String(heldRows()[0]?.reason),
  )
  const heldReceipts = receipts
    .readSessionReceipts(HOME, SESSION)
    .filter(r => r.kind === 'schedule-held')
  const lastHeldLine = heldReceipts[heldReceipts.length - 1]?.summary ?? ''
  check(
    'K5a the held line names the local road (no sign-in words)',
    lastHeldLine.includes('server') && !lastHeldLine.includes('/logins') && !lastHeldLine.toLowerCase().includes('signed out'),
    lastHeldLine,
  )

  // K5b the release: the server returns, the debt replays exactly once.
  s1.server = 'up'
  s1.deriveMiss = false
  const r2 = await tickSaturnOnce(m1.ports)
  check(
    'K5b the server returning releases the held fire exactly once',
    r2.replayed === 1 && m1.delivered.length === 1 && heldRows().length === 0,
    `replayed=${r2.replayed} delivered=${m1.delivered.length} held=${heldRows().length}`,
  )

  // K5c the VERDICT arm: the derivation still answers (a cached account)
  // but the live facts say gone — the verdict holds 'unreachable' too.
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
  const add2 = applyConcourseScheduleOp(
    SESSION,
    { op: 'add', schedule: { when: { kind: 'every', cron: '* * * * *' }, action: { kind: 'fire', prompt: 'verdict arm' } } },
    'operator:test',
    keylessDeps as never,
    DAEMON_DIR,
  )
  check('K5c seed: the second keyless schedule lands', add2.outcome === 'applied', add2.outcome)
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      const row = ((r as { schedules?: Array<Record<string, unknown>> }).schedules ?? [])[0]
      if (row) row.createdAt = T0 - 120_000
    }
  }, DAEMON_DIR)
  const s2 = { nowMs: T0, server: 'gone' as 'up' | 'gone' }
  const m2 = makePorts(s2)
  const r3 = await tickSaturnOnce(m2.ports)
  check('K5c the verdict arm holds too', r3.held === 1 && heldRows().length === 1, `held=${r3.held}`)
  check(
    "K5c the verdict arm's reason is 'unreachable'",
    heldRows()[0]?.reason === 'unreachable',
    String(heldRows()[0]?.reason),
  )
  updateConcourseWorkers(workers => {
    for (const r of Object.values(workers)) {
      delete (r as { schedules?: unknown }).schedules
      delete (r as { heldFires?: unknown }).heldFires
    }
  }, DAEMON_DIR)
}

// ── §K6 the box tier admits the widened truth ───────────────────────────────
console.log('§K6 box validation: keyless accounts + unreachable holds')
{
  const row = {
    schema: 1,
    id: 'abcd1234',
    when: { kind: 'at', atMs: Date.now() + 60_000 },
    action: { kind: 'birth', birth: { workspaceDir: '/scratch/w', modelKey: 'local/qwen3:1.7b', presence: 'headless' } },
    account: { family: 'local', source: 'keyless' },
    createdAt: Date.now(),
    createdBy: 'operator:test',
  }
  check('a keyless account row validates at the box door', boxScheduleProblem(row) === null, String(boxScheduleProblem(row)))
  const held = {
    scheduleId: 'abcd1234',
    dueAt: Date.now(),
    reason: 'unreachable',
    heldAt: Date.now(),
    envelope: { scheduleId: 'abcd1234', kind: 'birth', dueAt: Date.now(), birth: { workspaceDir: '/scratch/w', modelKey: 'local/qwen3:1.7b', presence: 'headless' } },
  }
  check("an 'unreachable' hold row validates at the box door", boxHeldFireProblem(held) === null, String(boxHeldFireProblem(held)))
}

// ── §K7 the screen sentence ─────────────────────────────────────────────────
console.log('§K7 the screen speaks the probe road')
{
  const { saturnVerdictSentence } = await import('../../src/components/BootSaturnScreen.tsx')
  const words = saturnVerdictSentence({ state: 'unreachable' } as never)
  check('the unreachable sentence exists and names the server road', typeof words === 'string' && words.includes('server'), String(words))
  check('no sign-in words on the account-less arm', typeof words === 'string' && !words.includes('/logins') && !words.toLowerCase().includes('sign'), String(words))
}

fixture.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
