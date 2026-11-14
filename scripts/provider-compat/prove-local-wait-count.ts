#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const HOME = childHome ?? mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'local-wait-count-proof-'))
if (childHome === undefined) {
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', HOME], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(HOME)) throw new Error('The wait-count proof requires its scratch HOME at process start.')
const DAEMON = join(HOME, 'daemon')
mkdirSync(DAEMON, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_HOME
delete process.env.MERCURY_COMPAT_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const { onSeatRow } = await import('../../src/daemon/sessionSeat.ts')
const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const projections = await import('../../src/services/engine-connector/seatProjections.ts')
const { daemonSessionConnectorFor } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { fitStatusLine, statusLine, statusRowPlan } = await import('../../src/components/SwitchboardTagBar.tsx')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { localStreamLawFor } = await import('../../src/services/providers/localLiveness.ts')
const { waitRow, heartbeatRow } = await import('../../src/rows/project.ts')
type Wait = import('../../src/services/providers/streamIdleBudget.ts').RequestWaitV1
type SeatStatus = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1
type SeatLive = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1

updateSettingsForSource('userSettings', { compatProvider: { lab: { baseUrl: 'http://127.0.0.1:1/lab/v1', dialect: 'llamacpp', models: ['fixture-model'] }, pod: { baseUrl: 'http://127.0.0.1:1/pod/v1', hostPodId: 'pod0fixture', models: ['fixture-model'] }, cloud: { baseUrl: 'http://127.0.0.1:1/cloud/v1', models: ['fixture-model'] } } } as never)

const realNow = Date.now.bind(Date)
const BASE = realNow()
let virtual = 0
Date.now = () => BASE + virtual
const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
type Due = { id: number; at: number; fn: () => void }
const queue = new Map<number, Due>()
let nextTimer = 1
const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => {
    const id = nextTimer++
    queue.set(id, { id, at: virtual + Math.max(0, Number(ms) || 0), fn })
    return id
  },
  clearTimeout: (handle: unknown): void => {
    queue.delete(handle as number)
  },
}
async function advanceTo(target: number): Promise<void> {
  for (;;) {
    await settle()
    const due = [...queue.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (due === undefined) break
    queue.delete(due.id)
    virtual = Math.max(virtual, due.at)
    due.fn()
  }
  virtual = Math.max(virtual, target)
  await settle()
}
async function until(pred: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = realNow() + ms
  while (realNow() < deadline) {
    if (pred()) return true
    await settle(25)
  }
  return pred()
}

const encoder = new TextEncoder()
const sse = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
const KEEP_ALIVE = encoder.encode(':\n\n')
const chunkOf = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })

type Road = 'local' | 'self-hosted compat' | 'hosted compat'
type Scene = { road: Road; model: string; shown: string; keepAlives: number[]; firstTokenAt: number; samples: number[] }
type Seen = { waits: Array<Wait | null>; waitRows: string[]; activityAt: number[]; lastEventAt: number[]; rows: Map<number, string>; after: string }

let sessions = 0
async function play(scene: Scene): Promise<Seen> {
  const n = ++sessions
  virtual = 0
  queue.clear()
  const sid = `aaaaaaaa-bbbb-4ccc-8ddd-waitcount000${n}`
  const short = `concourse-wc${n}`
  updateConcourseWorkers(workers => {
    workers[short] = { schema: 1, runnerId: short, sessionId: sid, workspaceId: `ws-wc${n}`, isolation: 'exclusive', modelKey: scene.model, effort: 'high', spawnedAt: Date.now(), lastLiveAt: Date.now(), settingsSnapshot: { schema: 1, snapshotId: 's', sessionId: sid, profileRevision: 0, profileDigest: 'd', resolvedAt: Date.now(), rows: [] }, workspaceKind: 'plain-folder' } as never
  }, DAEMON)
  const roster = { door: () => undefined, list: () => [], patchSeatModel: () => true, patchSeatEffort: () => true }
  const scope = { session_id: sid, turn: 1 }
  let seq = 0
  const feed = (row: Record<string, unknown>): void => onSeatRow(short, { seq: ++seq, timestamp: 't', ...row } as never, roster as never, DAEMON)
  projections.publishSessionFacts({
    schema: 1,
    sessionId: sid,
    atMs: Date.now(),
    pendingModel: null,
    busy: true,
    model: { effective: scene.model, setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default',
    workspace: { cwd: HOME, originalCwd: HOME, projectRoot: HOME, instructionRoots: [] },
    queue: [],
  } as never)
  projections.publishSessionTail({ schema: 1, sessionId: sid, atMs: Date.now(), text: null } as never)
  const c = daemonSessionConnectorFor({ sessionId: sid, runnerId: short, title: 'wait count fixture', projectLabel: 'proj', workspaceId: HOME, home: HOME } as never)
  await c.attach()
  await until(() => c.live().inFlight)
  const line = (): string => statusLine(c.live() as SeatLive, c.status() as SeatStatus)

  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
    },
  })
  const fixtureFetch = (async (): Promise<Response> => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch
  const probeFetch = (async (): Promise<Response> => Response.json({ status: 'ok', object: 'list', data: [] })) as unknown as typeof fetch
  const seen: Seen = { waits: [], waitRows: [], activityAt: [], lastEventAt: [], rows: new Map(), after: '' }
  const law = scene.road === 'local' ? localStreamLawFor({ wireModel: scene.shown, cold: false, promptTokens: 4400, record: { id: scene.shown, server: 'tensorfold', baseUrl: 'http://127.0.0.1:1/v1', loaded: true } as never, io: { fetchImpl: probeFetch } }) : undefined
  const events = streamCompatChat({
    url: 'http://127.0.0.1:1/v1/chat/completions',
    request: { model: scene.shown, messages: [{ role: 'user', content: 'And exactly five words about rain.' }] },
    signal: new AbortController().signal,
    fetchImpl: fixtureFetch,
    timers,
    idleTimeoutMs: scene.road === 'local' ? 900_000 : 90_000,
    silentAfterHeadersMs: null,
    firstByte: {
      cold: false,
      promptTokens: 4400,
      model: scene.shown,
      onWait: (wait: Wait | null) => {
        seen.waits.push(wait === null ? null : { ...wait })
        if (wait !== null && wait.kind === 'retry') return
        const row = waitRow(scope, wait)
        seen.waitRows.push(JSON.stringify(row))
        feed(row as never)
      },
    },
    onStreamActivity: () => {
      seen.activityAt.push(virtual)
      feed(heartbeatRow(scope) as never)
    },
    ...(law !== undefined ? { local: law } : {}),
  } as never)
  const consumed = (async () => {
    for await (const _event of events) void _event
  })()
  await advanceTo(0)
  await until(() => c.status().wait !== null)

  const moments = [...scene.keepAlives.map(at => ({ at, what: 'keep-alive' as const })), ...scene.samples.map(at => ({ at, what: 'sample' as const }))].sort((a, b) => a.at - b.at || (a.what === 'keep-alive' ? -1 : 1))
  for (const moment of moments) {
    await advanceTo(moment.at * 1000)
    if (moment.what === 'keep-alive') {
      const before = seen.activityAt.length
      stream.enqueue(KEEP_ALIVE)
      await until(() => seen.activityAt.length > before, 2000)
      await until(() => projections.readSessionTail(sid, DAEMON)?.lastEventAtMs === BASE + virtual)
      seen.lastEventAt.push(((projections.readSessionTail(sid, DAEMON)?.lastEventAtMs ?? 0) - BASE) / 1000)
      await until(() => c.status().quietMs === 0)
    } else {
      seen.rows.set(moment.at, line())
    }
  }
  await advanceTo(scene.firstTokenAt * 1000)
  stream.enqueue(sse(chunkOf({ content: 'Heavy drops wash streets clean.' })))
  stream.enqueue(sse(chunkOf({}, 'stop')))
  stream.enqueue(encoder.encode('data: [DONE]\n\n'))
  stream.close()
  await Promise.race([consumed, settle(3000)])
  await until(() => c.status().wait === null)
  seen.after = line()
  return seen
}

const countOf = (row: string): number | null => {
  const match = / · (\d+)(s|m) so far/.exec(row)
  return match === null ? null : Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}
const show = (rows: Map<number, string>): string => [...rows].map(([at, row]) => `+${at}s ${JSON.stringify(row)}`).join(' · ')

section('1 · a local server that sends its headers at once and a comment line every thirty seconds while it reads the prompt (llama.cpp since its SSE ping; the first token after 3m 35s)')
const PROMISE = 'waiting for the first byte from qwen3.5-4b — expected in about 1m'
const PASSED = 'waiting for the first byte from qwen3.5-4b'
const local = await play({ road: 'local', model: 'local/qwen3.5-4b', shown: 'qwen3.5-4b', keepAlives: [30, 60, 90, 120, 150, 180, 210], firstTokenAt: 215, samples: [7, 14, 28, 36, 43, 58, 61, 65, 94, 124, 153, 183, 190, 212] })
{
  const first = local.waits[0]
  check('the lane makes one promise for the request: a first-byte wait that expects it in about a minute', first !== null && first !== undefined && first.kind === 'first-byte' && first.promise === true && first.budgetMs === 60_000, JSON.stringify(first))
  const second = local.waits[1]
  check('at the headers it goes to its first-token phase and renews nothing until the first token: three waits in all, the promise, that phase, the end', local.waits.length === 3 && second !== null && second !== undefined && second.kind === 'first-byte' && second.phase === 'tokens' && local.waits[2] === null, JSON.stringify(local.waits))
  check('the row written for that phase is the promise\'s own row, state first_byte with the same budget and clock', local.waitRows.length === 3 && local.waitRows[1] === local.waitRows[0] && local.waitRows[0]!.includes('"state":"first_byte"'), local.waitRows.slice(0, 2).join(' | '))
  check('each of the seven keep-alives is relayed as stream activity', JSON.stringify(local.activityAt.map(at => at / 1000)) === JSON.stringify([30, 60, 90, 120, 150, 180, 210]), JSON.stringify(local.activityAt))
  check('and the seat takes each for the session\'s last event', JSON.stringify(local.lastEventAt) === JSON.stringify([30, 60, 90, 120, 150, 180, 210]), JSON.stringify(local.lastEventAt))
}

section('2 · the status row of a window over that wait: one count, from the request\'s start to its first byte')
{
  const rows = local.rows
  const counts = [...rows].map(([at, row]) => [at, countOf(row)] as const)
  check('the count never starts again: at every reading it is the wait\'s own age', counts.every(([at, count]) => (at < 10 ? count === null : count === (at < 60 ? at : Math.floor(at / 60) * 60))), JSON.stringify(counts))
  check('it passes thirty seconds (36s so far, where it read no count)', rows.get(36) === `${PROMISE} · 36s so far`, String(rows.get(36)))
  check('it passes a minute (1m so far)', rows.get(65) === `${PASSED} · 1m so far` && rows.get(94) === `${PASSED} · 1m so far`, `${rows.get(65)} · ${rows.get(94)}`)
  check('it passes three minutes (3m so far)', rows.get(183) === `${PASSED} · 3m so far` && rows.get(212) === `${PASSED} · 3m so far`, `${rows.get(183)} · ${rows.get(212)}`)
  check('the estimate is gone once it has passed: no reading after the first minute states one', [...rows].every(([at, row]) => (at > 60 ? !row.includes('expected in about') && row.startsWith(`${PASSED} · `) : true)), show(rows))
  check('before the first keep-alive every reading is as it was: the promise, the count beside it from ten seconds on', rows.get(7) === PROMISE && rows.get(14) === `${PROMISE} · 14s so far` && rows.get(28) === `${PROMISE} · 28s so far`, show(rows))
  check('after a keep-alive and inside the estimate the words are still the promise\'s, the count the wait\'s age (43s so far, 58s so far)', rows.get(43) === `${PROMISE} · 43s so far` && rows.get(58) === `${PROMISE} · 58s so far`, show(rows))
  check('once the first token arrives the row says nothing', local.after === '', local.after)
}

section('3 · a self-hosted endpoint on the compatible road (dialect llamacpp), held ninety seconds with a keep-alive every thirty')
const WITHIN = 'waiting for the first byte from fixture-model — within 1m 30s'
const selfHosted = await play({ road: 'self-hosted compat', model: 'compat/lab/fixture-model', shown: 'fixture-model', keepAlives: [30, 60], firstTokenAt: 90, samples: [7, 14, 28, 36, 45, 58, 65, 89] })
{
  const rows = selfHosted.rows
  check('the road\'s own form stands, estimate included, for the whole wait', [...rows.values()].every(row => row === WITHIN || row.startsWith(`${WITHIN} · `)), show(rows))
  check('its count is the wait\'s own age: it passes thirty (36s so far) and sixty (1m so far)', rows.get(36) === `${WITHIN} · 36s so far` && rows.get(45) === `${WITHIN} · 45s so far` && rows.get(65) === `${WITHIN} · 1m so far` && rows.get(89) === `${WITHIN} · 1m so far`, show(rows))
  check('before the first keep-alive it reads as it did', rows.get(7) === WITHIN && rows.get(14) === `${WITHIN} · 14s so far` && rows.get(28) === `${WITHIN} · 28s so far`, show(rows))
}

const pod = await play({ road: 'self-hosted compat', model: 'compat/pod/fixture-model', shown: 'fixture-model', keepAlives: [30], firstTokenAt: 50, samples: [14, 36, 45] })
{
  const rows = pod.rows
  check('a rented machine on that road (a pod id, no dialect) counts the same way: 36s so far, 45s so far past its keep-alive', rows.get(14) === `${WITHIN} · 14s so far` && rows.get(36) === `${WITHIN} · 36s so far` && rows.get(45) === `${WITHIN} · 45s so far`, show(rows))
}

section('4 · a hosted endpoint on the compatible road (no dialect, no pod): every reading as it was')
const hosted = await play({ road: 'hosted compat', model: 'compat/cloud/fixture-model', shown: 'fixture-model', keepAlives: [30, 60], firstTokenAt: 90, samples: [7, 14, 28, 36, 45, 58, 65, 89] })
{
  const rows = hosted.rows
  const asItWas = new Map<number, string>([[7, WITHIN], [14, `${WITHIN} · 14s so far`], [28, `${WITHIN} · 28s so far`], [36, WITHIN], [45, `${WITHIN} · 15s so far`], [58, `${WITHIN} · 28s so far`], [65, WITHIN], [89, `${WITHIN} · 29s so far`]])
  check('the eight readings are the eight a keep-alive leaves today, the count from the session\'s last event', [...asItWas].every(([at, row]) => rows.get(at) === row), show(rows))
}

section('5 · the row\'s words, reading by reading')
{
  const live = { inFlight: true, phase: 'thinking', agentsWaiting: 0, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: 0 } as SeatLive
  const seat = (wait: Wait, quietMs: number, waitAgeMs?: number): SeatStatus => ({ title: 't', projectLabel: 'p', interrupting: false, hardStopping: false, wait, quietMs, watchdogMs: 900_000, phaseMs: null, toolBudgetMs: null, stuck: false, ...(waitAgeMs !== undefined ? { waitAgeMs } : {}) }) as SeatStatus
  const promise: Wait = { kind: 'first-byte', cold: false, promptTokens: 4400, model: 'qwen3.5-4b', budgetMs: 60_000, sinceMs: 0, attempt: 1, promise: true }
  check('past its estimate, narrow: the model is "the model" and the count stands alone', statusLine(live, seat(promise, 5_000, 125_000), null, true) === 'waiting for the first byte from the model · 2m so far', statusLine(live, seat(promise, 5_000, 125_000), null, true))
  check('past its estimate, a cold prompt: what it ingests, then the count', statusLine(live, seat({ ...promise, cold: true }, 5_000, 125_000)) === 'ingesting a 4k-token prompt on qwen3.5-4b · 2m so far' && statusLine(live, seat({ ...promise, cold: true }, 5_000, 125_000), null, true) === 'ingesting prompt · 2m so far', statusLine(live, seat({ ...promise, cold: true }, 5_000, 125_000)))
  check('a second attempt keeps its mark', statusLine(live, seat({ ...promise, attempt: 2 }, 5_000, 125_000)) === 'waiting for the first byte from qwen3.5-4b (attempt 2) · 2m so far', statusLine(live, seat({ ...promise, attempt: 2 }, 5_000, 125_000)))
  const extended: Wait = { ...promise, cold: true, budgetMs: 120_000, checkedMs: 60_000 }
  check('the extended promise of a server that holds its headers stands as it was, its own clock and no count', statusLine(live, seat(extended, 5_000, 65_000)) === 'still ingesting a 4k-token prompt on qwen3.5-4b — about 1m more (its server answered at 1m)', statusLine(live, seat(extended, 5_000, 65_000)))
  check('a wait that names no age of its own reads by the session\'s last event, as every hosted wait does', statusLine(live, seat({ ...promise, promise: undefined } as Wait, 14_000)) === 'waiting for the first byte from qwen3.5-4b — within 1m · 14s so far', statusLine(live, seat({ ...promise, promise: undefined } as Wait, 14_000)))
}

section('6 · a row too narrow for the words: the count is what stays')
{
  const past = 'waiting for the first byte from nemotron-lightning · 3m so far'
  const cold = 'ingesting a 12k-token prompt on nemotron-lightning · 3m so far'
  const fit = (line: string, budget: number): string => fitStatusLine(line, budget + 40, 40)
  check('a wait past its estimate is shortened at the model and keeps its count', fit(past, 44) === 'waiting for the first byte from… · 3m so far' && fit(past, 30) === 'waiting for the f… · 3m so far', `${fit(past, 44)} · ${fit(past, 30)}`)
  check('the cold form the same', fit(cold, 44) === 'ingesting a 12k-token prompt on… · 3m so far', fit(cold, 44))
  check('wide enough, the words stand whole', fit(past, 62) === past && fit(cold, 62) === cold)
  const loading = 'loading nemotron-lightning (19 GB) · 14s so far'
  const promise = 'waiting for the first byte from nemotron-lightning — expected in about 1m · 14s so far'
  check('every other row is shortened as it was: a row with a dash keeps its clause, a row without one is left to the row\'s own end', fit(promise, 44) === 'waiting… — expected in about 1m · 14s so far' && fit(loading, 30) === loading, `${fit(promise, 44)} · ${fit(loading, 30)}`)
  const plan = (rest: string, columns: number): string => statusRowPlan({ columns, head: 'local/qwen3.5-4b · high', rest, samples: [], folder: 'proj', branch: null, backHint: 'esc interrupts · shift+← back' }).rest
  const PROMISED = 'waiting for the first byte from qwen3.5-4b — expected in about 1m · 28s so far'
  const WAITED = 'waiting for the first byte from qwen3.5-4b · 3m so far'
  check('the whole row at a hundred and twenty columns: the promise shortened to its clause as it was, the wait past its estimate whole', plan(PROMISED, 120) === 'waiting for the fir… — expected in about 1m · 28s so far' && plan(WAITED, 120) === WAITED, `${plan(PROMISED, 120)} · ${plan(WAITED, 120)}`)
  check('the same row at a hundred columns: the wait past its estimate shortened at its head, its count kept', plan(WAITED, 100).startsWith('waiting for the') && plan(WAITED, 100).includes('…') && plan(WAITED, 100).endsWith(' · 3m so far'), plan(WAITED, 100))
}

console.log(`\nprove-local-wait-count: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
