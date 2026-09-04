#!/usr/bin/env bun
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'append-growth-home-'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

type Seam = {
  tickOnce: () => Promise<void>
  rawRecords: unknown[]
  factsBusy: boolean
  recomputeLive: () => void
  feedCadencesForProofs: () => { transcript: number; facts: number; asks: number; tail: number; progress: number }
  attach: () => Promise<void>
  detach: () => void
}

function transcriptLines(sessionId: string, cwd: string, turns: number, textBytes: number): string[] {
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '1.0.0', gitBranch: 'main' }
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

async function appendPass(label: string, turns: number): Promise<{ ms: number; ok: boolean; cadences: ReturnType<Seam['feedCadencesForProofs']> }> {
  const home = mkdtempSync(join(tmpdir(), `append-growth-${label}-`))
  mkdirSync(home, { recursive: true })
  const sessionId = '12345678-1234-4123-8123-123456789abc'
  const lines = transcriptLines(sessionId, home, turns, 700)
  const path = join(home, `${sessionId}.jsonl`)
  writeFileSync(path, lines.slice(0, -1).join('\n') + '\n')
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w1', title: label, projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  const before = conn.rawRecords.length
  const first = conn.rawRecords[0]
  conn.factsBusy = false
  conn.recomputeLive()
  const cadences = conn.feedCadencesForProofs()
  appendFileSync(path, lines[lines.length - 1] + '\n')
  const t0 = performance.now()
  await conn.tickOnce()
  const ms = performance.now() - t0
  const after = conn.rawRecords.length
  const ok = after === before + 1 && conn.rawRecords[0] === first
  check(`${label}: the append landed as one row (${before} → ${after}) and the first row kept its object`, ok)
  conn.detach()
  return { ms, ok, cadences }
}

const small = await appendPass('six-rows', 3)
const large = await appendPass('twenty-four-hundred-rows', 1200)
console.log(`  append pass: ${small.ms.toFixed(2)} ms at 6 rows · ${large.ms.toFixed(2)} ms at ${1200 * 2} rows`)
check(
  '§1 a 2,400-row append pass costs about a 6-row one (never the chain)',
  large.ms <= Math.max(small.ms * 8, 15),
  `small=${small.ms.toFixed(2)}ms large=${large.ms.toFixed(2)}ms`,
)

check('§2 at rest the transcript heartbeat is its idle floor (2 s) behind a live watch', large.cadences.transcript === 2000, JSON.stringify(large.cadences))
check(
  '§2 at rest the projection feeds heartbeat at their idle floor (10 s)',
  large.cadences.facts === 10_000 && large.cadences.asks === 10_000 && large.cadences.tail === 10_000 && large.cadences.progress === 10_000,
  JSON.stringify(large.cadences),
)
{
  const home = mkdtempSync(join(tmpdir(), 'append-growth-turn-'))
  const sessionId = '12345678-1234-4123-8123-123456789abd'
  const lines = transcriptLines(sessionId, home, 2, 40)
  writeFileSync(join(home, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w2', title: 'turn', projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  conn.factsBusy = true
  conn.recomputeLive()
  const busy = conn.feedCadencesForProofs()
  check(
    '§2 a turn in flight puts every feed at the full heartbeat (400 ms)',
    busy.transcript === 400 && busy.facts === 400 && busy.asks === 400 && busy.tail === 400 && busy.progress === 400,
    JSON.stringify(busy),
  )
  conn.factsBusy = false
  conn.recomputeLive()
  const idle = conn.feedCadencesForProofs()
  check('§2 the turn settling returns every feed to its floor', idle.transcript === 2000 && idle.facts === 10_000, JSON.stringify(idle))
  conn.detach()
  const gone = conn.feedCadencesForProofs()
  check('§2 detach stops every heartbeat', gone.transcript === 0 && gone.facts === 0 && gone.asks === 0 && gone.tail === 0 && gone.progress === 0, JSON.stringify(gone))
}
{
  const home = mkdtempSync(join(tmpdir(), 'append-growth-nofile-'))
  const sessionId = '12345678-1234-4123-8123-123456789abe'
  const conn = new DaemonSessionConnector({ sessionId, runnerId: 'concourse-w3', title: 'nofile', projectLabel: 'scratch', workspaceId: home, home }) as unknown as Seam
  await conn.attach()
  await sleep(20)
  const c = conn.feedCadencesForProofs()
  check('§2 a transcript whose watch cannot arm keeps the full heartbeat', c.transcript === 400, JSON.stringify(c))
  conn.detach()
}

console.log(`\n${failures === 0 ? '✅ TRANSCRIPT APPEND GROWTH: green' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
