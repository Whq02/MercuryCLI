#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'append-growth-home-'))
const TRACE = join(process.env.MERCURY_CONFIG_DIR, 'connector-trace.jsonl')
process.env.MERCURY_CONNECTOR_TRACE = TRACE

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

type Seam = {
  transcriptPart: { tickOnce: () => Promise<void>; rawRecords: unknown[] }
  recomputeLive: () => void
  feedCadencesForProofs: () => { transcript: number; facts: number; asks: number; tail: number; progress: number }
  attach: () => Promise<void>
  detach: () => void
}

function transcriptLines(sessionId: string, cwd: string, turns: number, textBytes: number): string[] {
  const base = { isSidechain: false, entrypoint: 'cli', cwd, sessionId, version: '1.0.0', gitBranch: 'main' }
  const rows: Record<string, unknown>[] = []
  let prev: string | null = null
  const filler = 'the ledger row holds steady against the recorded baseline and needs no further survey. '
  const text = filler.repeat(Math.max(1, Math.ceil(textBytes / filler.length)))
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  for (let n = 1; n <= turns; n++) {
    const u = uuid(n * 2)
    const a = uuid(n * 2 + 1)
    rows.push({ ...base, parentUuid: prev, type: 'user', uuid: u, message: { role: 'user', content: `turn ${n}` }, timestamp: '2026-06-19T12:00:00.000Z' })
    rows.push({ ...base, parentUuid: u, type: 'assistant', uuid: a, requestId: `req_${n}`, message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:00.500Z' })
    prev = a
  }
  rows.push({ ...base, parentUuid: prev, type: 'user', uuid: uuid(turns * 2 + 2), message: { role: 'user', content: 'one more' }, timestamp: '2026-06-19T12:00:01.000Z' })
  return encodeSeedTranscript(rows, sessionId).split('\n').filter(Boolean)
}

type LoadRow = { ev?: string; sid?: string; rawLen?: number; prevLen?: number; since?: number; rewound?: boolean }
function lastLoadRow(sessionId: string): LoadRow | null {
  if (!existsSync(TRACE)) return null
  const rows = readFileSync(TRACE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as LoadRow)
  return rows.filter(row => row.ev === 'load' && row.sid === sessionId).at(-1) ?? null
}

async function appendPass(label: string, turns: number): Promise<{ ms: number; ok: boolean; load: LoadRow | null; cadences: ReturnType<Seam['feedCadencesForProofs']> }> {
  const home = mkdtempSync(join(tmpdir(), `append-growth-${label}-`))
  mkdirSync(home, { recursive: true })
  const sessionId = '12345678-1234-4123-8123-123456789abc'
  const lines = transcriptLines(sessionId, home, turns, 700)
  const path = join(home, `${sessionId}.jsonl`)
  writeFileSync(path, lines.slice(0, -1).join('\n') + '\n')
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w1', title: label, projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  const before = conn.transcriptPart.rawRecords.length
  const first = conn.transcriptPart.rawRecords[0]
  conn.recomputeLive()
  const cadences = conn.feedCadencesForProofs()
  appendFileSync(path, lines[lines.length - 1] + '\n')
  const t0 = performance.now()
  await conn.transcriptPart.tickOnce()
  const ms = performance.now() - t0
  const after = conn.transcriptPart.rawRecords.length
  const ok = after === before + 1 && conn.transcriptPart.rawRecords[0] === first
  check(`${label}: the append landed as one row (${before} → ${after}) and the first row kept its object`, ok, `rows ${before} → ${after}; fix the merge in the tick in src/engine/connector/daemon/transcript.ts (mergeRecordsContentKeyed) so an append adds one row and keeps the earlier row objects`)
  const load = lastLoadRow(sessionId)
  conn.detach()
  return { ms, ok, load, cadences }
}

const small = await appendPass('six-rows', 3)
const large = await appendPass('twenty-four-hundred-rows', 1200)
console.log(`  append pass: ${small.ms.toFixed(2)} ms at 6 rows · ${large.ms.toFixed(2)} ms at ${1200 * 2} rows`)
const tookAppendRoad = (pass: { load: LoadRow | null }, seeded: number): boolean =>
  pass.load !== null && pass.load.prevLen === seeded && pass.load.since === seeded && pass.load.rawLen === seeded + 1 && pass.load.rewound === false
check(
  '§1 the 6-row append took the append road (the merge started at the previous length, only the tail deserialised)',
  tookAppendRoad(small, 6),
  `${JSON.stringify(small.load)} — the last load trace row must show prevLen 6, since 6, rawLen 7, rewound false; fix the tick in src/engine/connector/daemon/transcript.ts (readTranscriptChainSince cursor)`,
)
check(
  '§1 the 2,400-row append took the append road too — never the chain',
  tookAppendRoad(large, 2400),
  `${JSON.stringify(large.load)} — the last load trace row must show prevLen 2400, since 2400, rawLen 2401, rewound false; fix the tick in src/engine/connector/daemon/transcript.ts (readTranscriptChainSince cursor)`,
)

check('§2 at rest the transcript heartbeat is its idle floor (2 s) behind a live watch', large.cadences.transcript === 2000, `${JSON.stringify(large.cadences)} — the idle floor is IDLE_TRANSCRIPT_FLOOR_MS in src/engine/connector/daemon/transcript.ts`)
check(
  '§2 at rest the projection feeds heartbeat at their idle floor (10 s)',
  large.cadences.facts === 10_000 && large.cadences.asks === 10_000 && large.cadences.tail === 10_000 && large.cadences.progress === 10_000,
  `${JSON.stringify(large.cadences)} — the idle floor is IDLE_PROJECTION_FLOOR_MS in src/engine/connector/daemonConnector.ts`,
)
{
  const home = mkdtempSync(join(tmpdir(), 'append-growth-turn-'))
  const sessionId = '12345678-1234-4123-8123-123456789abd'
  const lines = transcriptLines(sessionId, home, 2, 40)
  writeFileSync(join(home, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w2', title: 'turn', projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  const runnerSays = (busy: boolean, atMs: number): void => publishSessionFacts({ schema: 1, sessionId, atMs, busy, pendingModel: null, model: { effective: 'claude-sonnet-5', setting: null }, usage: {}, queue: [] } as never)
  const feedReads = async (factsMs: number): Promise<void> => {
    for (let waited = 0; conn.feedCadencesForProofs().facts !== factsMs && waited < 15_000; waited += 20) await sleep(20)
  }
  const saidAt = Date.now()
  runnerSays(true, saidAt)
  await feedReads(400)
  const busy = conn.feedCadencesForProofs()
  check(
    '§2 a turn in flight puts every feed at the full heartbeat (400 ms)',
    busy.transcript === 400 && busy.facts === 400 && busy.asks === 400 && busy.tail === 400 && busy.progress === 400,
    `${JSON.stringify(busy)} — each feed must use HEARTBEAT_MS while turnInFlight; see syncFeedCadence in src/engine/connector/daemonConnector.ts`,
  )
  runnerSays(false, saidAt + 1)
  await feedReads(10_000)
  const idle = conn.feedCadencesForProofs()
  check('§2 the turn settling returns every feed to its floor', idle.transcript === 2000 && idle.facts === 10_000, `${JSON.stringify(idle)} — a settled turn must return the feeds to their idle floor; see syncFeedCadence in src/engine/connector/daemonConnector.ts`)
  conn.detach()
  const gone = conn.feedCadencesForProofs()
  check('§2 detach stops every heartbeat', gone.transcript === 0 && gone.facts === 0 && gone.asks === 0 && gone.tail === 0 && gone.progress === 0, `${JSON.stringify(gone)} — detach in src/engine/connector/daemonConnector.ts must stop every feed heartbeat`)
}
{
  const home = mkdtempSync(join(tmpdir(), 'append-growth-absent-'))
  const sessionId = '12345678-1234-4123-8123-123456789abf'
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w4', title: 'absent', projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  const loadsFor = (): number => (existsSync(TRACE) ? readFileSync(TRACE, 'utf8').split('\n').filter(l => l.includes('"ev":"load"') && l.includes(sessionId)).length : 0)
  await conn.attach()
  const afterAttach = loadsFor()
  for (let i = 0; i < 5; i++) await conn.transcriptPart.tickOnce()
  check('§3 an absent transcript is read once (the attach) and gated on every heartbeat after', afterAttach === 1 && loadsFor() === 1, `loads after attach=${afterAttach} after 5 ticks=${loadsFor()}; the tick in src/engine/connector/daemon/transcript.ts must skip the read while the file is absent`)
  const lines = transcriptLines(sessionId, home, 1, 40)
  writeFileSync(join(home, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  await conn.transcriptPart.tickOnce()
  check('§3 the file appearing is read on the next pass', loadsFor() === 2 && conn.transcriptPart.rawRecords.length === 3, `loads=${loadsFor()} rows=${conn.transcriptPart.rawRecords.length}; the tick in src/engine/connector/daemon/transcript.ts must read the file once it exists`)
  conn.detach()
}
{
  const home = join(mkdtempSync(join(tmpdir(), 'append-growth-nodir-')), 'missing')
  const sessionId = '12345678-1234-4123-8123-123456789abe'
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w3', title: 'nodir', projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  await sleep(20)
  const c = conn.feedCadencesForProofs()
  check('§2 a transcript whose directory does not exist keeps the full heartbeat (no watch can arm)', c.transcript === 400, `${JSON.stringify(c)} — with no watch armed the transcript heartbeat must stay at HEARTBEAT_MS; see armTranscriptWatcher in src/engine/connector/daemon/transcript.ts`)
  conn.detach()
}

console.log(`\n${failures === 0 ? '✅ TRANSCRIPT APPEND GROWTH: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
