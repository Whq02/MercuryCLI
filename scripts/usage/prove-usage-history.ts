#!/usr/bin/env bun
// gate-watch: src/utils/usageHistory.ts src/cli/handlers/usageHistory.ts src/main.tsx src/cost-tracker.ts src/utils/modelCost.ts src/services/providers/deepseek/deepseekPins.ts src/services/providers/providerUsage.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'usage-history-')))
const home = join(scratch, 'config')
const project = join(scratch, 'project-alpha')
mkdirSync(project, { recursive: true })
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const netGuard = join(scratch, 'no-network.cjs')
writeFileSync(netGuard, `const fail = () => { throw new Error('network forbidden in usage history proof') }; globalThis.fetch = fail; for (const name of ['http', 'https', 'net', 'tls']) { const mod = require('node:' + name); for (const key of ['request', 'get', 'connect', 'createConnection']) if (typeof mod[key] === 'function') mod[key] = fail; }`)
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const sid = '11111111-1111-4111-8111-111111111111'
const sid2 = '22222222-2222-4222-8222-222222222222'
const file = join(home, 'projects', 'alpha', `${sid}.jsonl`)
const file2 = join(home, 'projects', 'beta', `${sid2}.jsonl`)
const agent = join(home, 'projects', 'alpha', sid, 'subagents', 'agent-fixture.jsonl')
const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }
const row = (id: string, model: string, time: string, sessionId = sid, cwd = project, counts = usage) => ({
  type: 'assistant', uuid: id, parentUuid: null, isSidechain: false, sessionId, cwd, version: '1.0.0', timestamp: time,
  message: { role: 'assistant', model, id: `msg-${id}`, content: [{ type: 'text', text: 'fixture-private-text' }], usage: counts, stop_reason: 'end_turn', stop_sequence: null },
})
const append = (path: string, value: object) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, encodeTranscriptLine(path, value).line) }
append(file, row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'deepseek-flash', '2026-10-23T01:00:00Z'))
append(file, row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'deepseek-flash', '2026-10-23T04:00:00Z'))
append(file, row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'deepseek-flash', '2026-10-23T04:00:00Z'))
append(agent, row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'local/fixture', '2026-10-23T06:00:00Z', sid, project, { ...usage, input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0 }))
append(file2, row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'compat/unpriced-fixture', '2026-10-22T12:00:00Z', sid2, 'project-beta', { ...usage, input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 100 }))
const before = [file, file2, agent].map(path => readFileSync(path, 'utf8'))
const cli = process.argv[2] ?? join(root, 'dist', 'mercury.mjs')
const run = (args: string[], width = 80) => spawnSync('node', ['--require', netGuard, cli, 'usage', ...args], {
  cwd: project, env: { ...process.env, COLUMNS: String(width), TERM: 'dumb' }, encoding: 'utf8', timeout: 60_000,
})
try {
  const first = run(['--history', '--json'])
  assert.equal(first.status, 0, `history verb exit ${first.status}: ${first.stderr}`)
  const report = JSON.parse(first.stdout)
  assert.equal(report.totals.turns, 4)
  assert.equal(report.totals.unpricedTurns, 1)
  assert.equal(report.totals.inputTokens, 4_000_700)
  assert.equal(report.totals.outputTokens, 2_000_250)
  assert.ok(Math.abs(report.totals.costUSD - 2.259) < 1e-9)
  assert.equal(report.byDay.length, 2)
  assert.equal(report.byModel.length, 3)
  assert.equal(report.byProject.length, 2)
  assert.equal(report.filesRead, 3)
  const second = JSON.parse(run(['--history', '--json']).stdout)
  assert.equal(second.filesRead, 0)
  assert.equal(second.filesCached, 3)
  assert.deepEqual(second.totals, report.totals)
  const projectOnly = JSON.parse(run(['--history', '--project', '--json']).stdout)
  assert.equal(projectOnly.totals.turns, 3)
  assert.equal(projectOnly.totals.unpricedTurns, 0)
  assert.equal(run(['--history', '--days', '0']).status, 2)
  assert.equal(run(['--history', '--days', '1x']).status, 2)
  assert.equal(run(['--days', '2']).status, 2)
  for (const width of [80, 120]) {
    const text = run(['--history'], width)
    assert.equal(text.status, 0, text.stderr)
    assert.match(text.stdout, /By day \(UTC\)/)
    assert.match(text.stdout, /By model/)
    assert.match(text.stdout, /By project/)
    assert.match(text.stdout, /^project-alpha +4,000,500/m)
    assert.ok(!text.stdout.includes(project))
    assert.match(text.stdout, /\$2\.2590/)
    assert.match(text.stdout, /Unpriced = turns without a rate/)
    assert.ok(text.stdout.split('\n').every(line => line.length <= width), text.stdout)
    assert.ok(!/\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)\b/i.test(text.stdout))
    if (process.env.USAGE_CAPTURE_DIR) {
      const captures = process.env.USAGE_CAPTURE_DIR
      mkdirSync(captures, { recursive: true })
      writeFileSync(join(captures, `usage-${width}.txt`), text.stdout)
      if (process.platform !== 'win32') {
        const grid = join(captures, `usage-${width}.grid.json`)
        const config = join(scratch, `capture-${width}.json`)
        writeFileSync(config, JSON.stringify({ cols: width, rows: 40, total: 30, cwd: project, argv: ['node', '--require', netGuard, cli, 'usage', '--history'], out: grid }))
        const capture = spawnSync('python3', [join(root, 'scripts/ui/vshot.py'), config], { env: process.env, encoding: 'utf8', timeout: 30_000 })
        assert.equal(capture.status, 0, capture.stderr)
        assert.match(capture.stdout, /By model/)
        const { gridToPng } = await import('../ui/gridToPng.ts')
        await gridToPng(grid, join(captures, `usage-${width}.png`))
      }
    }
    console.log(`PASS CLI ${width} columns`)
  }
  assert.deepEqual([file, file2, agent].map(path => readFileSync(path, 'utf8')), before)
  assert.ok(!readFileSync(join(home, 'usage-history.json'), 'utf8').includes('fixture-private-text'))
  console.log('PASS cross-session totals, unpriced, cache reuse, project selection, read-only transcripts, zero network')

  const { formatUsageHistory } = await import('../../src/cli/handlers/usageHistory.ts')
  const collisions = formatUsageHistory({ ...report, byProject: [
    { ...report.byProject[0], key: '/workspace/alpha/project-x' },
    { ...report.byProject[1], key: 'C:\\workspace\\beta\\project-x' },
  ] }, 80)
  assert.match(collisions, /alpha\/project-x/)
  assert.match(collisions, /beta\/project-x/)
  assert.ok(!collisions.includes('workspace'))
  console.log('PASS short project labels and shortest distinguishing parents')
  const { readUsageHistory, recordUsageObservations, boundUsageHistory, USAGE_HISTORY_MAX_ROWS, USAGE_OBSERVATION_MAX_ROWS, USAGE_HISTORY_MAX_FILES } = await import('../../src/utils/usageHistory.ts')
  globalThis.fetch = (() => { throw new Error('network forbidden') }) as typeof fetch
  const { transcriptReaderCensus } = await import('../../src/utils/sessionStorage/transcriptReader.ts')
  const today = await readUsageHistory({ days: 1, now: Date.parse('2026-10-23T20:00:00Z') })
  assert.equal(today.totals.turns, 3)
  const bytesBefore = transcriptReaderCensus.bytesRead
  await readUsageHistory()
  assert.equal(transcriptReaderCensus.bytesRead, bytesBefore, 'unchanged transcripts are not re-read')
  const { calculateUSDCost, resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const price = (at: string, model = 'deepseek-flash') => calculateUSDCost(model, { ...usage, request_started_at_ms: Date.parse(at) })
  for (const at of ['2026-10-23T01:00:00Z', '2026-10-23T03:59:59Z', '2026-10-23T06:00:00Z', '2026-10-23T09:59:59Z']) assert.ok(Math.abs(price(at) - 1.506) < 1e-9, at)
  for (const at of ['2026-10-23T00:59:59Z', '2026-10-23T04:00:00Z', '2026-10-23T05:59:59Z', '2026-10-23T10:00:00Z', '2026-10-24T02:00:00Z', '2026-10-01T02:00:00Z', '2026-02-23T02:00:00Z']) assert.ok(Math.abs(price(at) - 0.753) < 1e-9, at)
  assert.ok(Math.abs(price('2026-10-23T04:00:00Z', 'deepseek-v4-pro') - 2.662) < 1e-9)
  assert.equal(resolveModelPricing('deepseek-flash', { startedAtMs: Date.parse('2027-01-04T02:00:00Z') }).basis, 'family-estimate')
  console.log('PASS peak boundaries, off-peak, weekend, public holidays, unknown-year estimate')

  const at = Date.parse('2026-10-23T12:00:00Z')
  process.env.OPENROUTER_API_KEY = 'fixture-history-key'
  process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1/api/v1'
  const { refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
  let requests = 0
  await refreshProviderUsage('openrouter', { force: true, now: () => at, fetchImpl: (async () => {
    requests++
    return Response.json({ data: { limit: 100, usage: 25, limit_remaining: 75 } })
  }) as typeof fetch })
  assert.equal(requests, 1)
  const providerReading = (await readUsageHistory()).observations.find(row => row.provider === 'openrouter')
  assert.equal(providerReading?.usedPct, 25)
  assert.equal(providerReading?.source, 'endpoint')
  assert.equal(providerReading?.observedAtMs, at)
  process.env.OPENROUTER_API_KEY = 'fixture-other-history-key'
  await refreshProviderUsage('openrouter', { force: true, now: () => at + 1000, fetchImpl: (async () => Response.json({ data: { limit: 100, usage: 40, limit_remaining: 60 } })) as typeof fetch })
  assert.equal((await readUsageHistory()).observations.filter(row => row.provider === 'openrouter').length, 2)
  assert.ok(!readFileSync(join(home, 'usage-history.json'), 'utf8').includes('fixture-other-history-key'))
  console.log('PASS provider refresh records its observation; changed credentials stay separate and secret-free')
  await recordUsageObservations('fixture', 'account-a', [{ key: '5h', state: 'live', observedAtMs: at, usedPct: 10, source: 'endpoint' }])
  await recordUsageObservations('fixture', 'account-a', [{ key: '5h', state: 'live', observedAtMs: at + 1000, usedPct: 20, source: 'endpoint' }])
  await recordUsageObservations('fixture', 'account-b', [{ key: '5h', state: 'live', observedAtMs: at + 1000, usedPct: 30, source: 'headers' }])
  const observed = (await readUsageHistory()).observations.filter(row => row.provider === 'fixture')
  assert.equal(observed.length, 2)
  assert.deepEqual(observed.map(row => row.usedPct).sort(), [20, 30])
  assert.ok(!observed.some(row => row.account === 'account-a'))
  const lots = Array.from({ length: USAGE_OBSERVATION_MAX_ROWS + 3 }, (_, i) => ({ ...observed[0]!, observedAtMs: at + i * 3_600_000, hour: new Date(at + i * 3_600_000).toISOString() }))
  assert.equal(await recordUsageObservations('fixture', 'account-c', lots.map(row => ({ ...row, key: row.window }))), true)
  assert.equal(JSON.parse(readFileSync(join(home, 'usage-history.json'), 'utf8')).observations.length, USAGE_OBSERVATION_MAX_ROWS)
  const sample = JSON.parse(readFileSync(join(home, 'usage-history.json'), 'utf8')).files[join('alpha', sid + '.jsonl')]
  const cache = boundUsageHistory({ revision: 1, files: { big: { ...sample, rows: Array.from({ length: USAGE_HISTORY_MAX_ROWS + 1 }, () => sample.rows[0]) } }, observations: lots })
  assert.equal(Object.keys(cache.files).length, 0)
  assert.equal(cache.observations.length, USAGE_OBSERVATION_MAX_ROWS)
  assert.equal(cache.observations[0]!.observedAtMs, at + 3 * 3_600_000)
  const files = Object.fromEntries(Array.from({ length: USAGE_HISTORY_MAX_FILES + 2 }, (_, i) => [String(i), sample]))
  assert.equal(Object.keys(boundUsageHistory({ revision: 1, files, observations: [] }).files).length, USAGE_HISTORY_MAX_FILES)
  console.log('PASS hourly downsampling, account separation, file/row/observation bounds')
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => recordUsageObservations('concurrent', `account-${i}`, [{ key: '5h', state: 'live', observedAtMs: at + (USAGE_OBSERVATION_MAX_ROWS + i) * 3_600_000, usedPct: i }])))
  assert.ok(concurrent.every(Boolean))
  assert.equal((await readUsageHistory()).observations.filter(row => row.provider === 'concurrent').length, 8)
  if (process.platform !== 'win32') assert.equal(statSync(join(home, 'usage-history.json')).mode & 0o777, 0o600)
  console.log('PASS concurrent observations are serialized and the published history stays private')

  append(file, row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'local/fixture', '2026-10-23T12:00:00Z', sid, project, { ...usage, input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 }))
  const changed = await readUsageHistory()
  assert.equal(changed.filesRead, 1)
  assert.equal(changed.totals.turns, 5)
  rmSync(file2)
  assert.equal((await readUsageHistory()).totals.unpricedTurns, 0)
  writeFileSync(join(home, 'usage-history.json'), '{broken cache')
  assert.equal((await readUsageHistory()).totals.turns, 4)
  console.log('PASS changed/deleted transcripts and corrupt-cache rebuild')
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log('usage-history: PASS')
