#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-wire-dump.ts — the wire dump (MERCURY_WIRE_DUMP): one
//  JSONL row per request the Anthropic client sends, the body in full with a
//  credential-shaped string scrubbed, never a header, and the response's
//  status, usage block, drop list and stop reason read off the body as it
//  passes — the record the replay tool reads.
//
//    §1 the seam (pure) — the fetch wrapper: identity when unarmed; a POST to
//       a messages endpoint records a row once the body has passed while the
//       caller still reads the whole stream byte for byte; a key and a
//       bearer value inside the body are scrubbed; a JSON error body lands
//       as status + error; a GET writes nothing; a transport failure lands
//       as status 0 and still throws.
//    §2 the wire — the built bundle, headless, against the fixture API with
//       the dump armed: <dir>/<session-id>.jsonl exists with the request's
//       body and the fixture's usage, no headers, the key in the prompt
//       scrubbed; the replay tool reads the file as it is; unarmed ⇒ no file.
//
//  Run:  ~/.bun/bin/bun run scripts/api/prove-wire-dump.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wire-dump-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL
const PURE_DIR = mkdtempSync(join(tmpdir(), 'wire-dump-rows-'))
process.env.MERCURY_WIRE_DUMP = PURE_DIR

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { readCapture, reportPairs } from './wire-prefix-replay.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type Row = { kind: string; seq: number; url: string; model: string; source?: string; headers?: unknown; body: { model?: string; messages?: unknown }; response: { status: number; ms: number; usage?: Record<string, number>; input_transformations?: unknown[]; model?: string; stop_reason?: string | null; text?: string; error?: string } }
function rowsOf(file: string): Row[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Row)
}
async function waitForRows(file: string, n: number): Promise<Row[]> {
  for (let i = 0; i < 40; i++) {
    const rows = rowsOf(file)
    if (rows.length >= n) return rows
    await sleep(50)
  }
  return rowsOf(file)
}

// ============================================================================
section('§1 the seam — the fetch wrapper records a row, scrubs, and never touches the stream')
// ============================================================================
{
  const { wrapFetchWithWireDump, wireDumpPath, scrubCredentials, createWireResponseReader } = await import('../../src/services/api/dumpPrompts.ts')
  const file = wireDumpPath(PURE_DIR)
  const sse = [
    `event: message_start\ndata: ${j({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }], usage: { input_tokens: 25, cache_read_input_tokens: 4321, cache_creation_input_tokens: 10 } } })}\n\n`,
    `event: content_block_start\ndata: ${j({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${j({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DUMP-SEAM-REPLY' } })}\n\n`,
    `event: content_block_stop\ndata: ${j({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${j({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })}\n\n`,
    `event: message_stop\ndata: ${j({ type: 'message_stop' })}\n\n`,
  ].join('')
  const calls: Array<{ url: string; method: string }> = []
  const baseFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.endsWith('/v1/messages') && init?.method === 'POST') {
      const body = String(init.body)
      if (body.includes('"refuse"')) {
        return new Response(j({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature: `temperature` is deprecated for this model' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      // Stream the body in several chunks so the tee is exercised.
      const parts = [sse.slice(0, 120), sse.slice(120, 400), sse.slice(400)]
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = parts.shift()
          if (next === undefined) {
            controller.close()
            return
          }
          await sleep(5)
          controller.enqueue(new TextEncoder().encode(next))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_seam_1' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const wrapped = wrapFetchWithWireDump(baseFetch, 'prove')
  check('armed: the wrapper is a new fetch (not the base)', wrapped !== baseFetch)

  // The body carries a real-shaped key on purpose (the scrubber's needle);
  // the line self-declares as a fixture so the leak sweep (prove-leak-sweep
  // R2, the marker law) reads it lawful while the scrubber still sees a key.
  const secretBody = j({ model: 'claude-fable-5-1', max_tokens: 10, messages: [{ role: 'user', content: 'my fixture key is sk-ant-api03-ABCDEFGHIJKLMNOP1234 and the fixture token is Bearer abcdefghijklmnopqrstuvwxyz0123' }] })
  const res = await wrapped('http://fixture.local/v1/messages', { method: 'POST', body: secretBody, headers: { 'x-api-key': 'sk-ant-never-written', 'content-type': 'application/json' } })
  const text = await res.text()
  check('the caller reads the whole stream byte for byte through the tee', text === sse && res.status === 200 && res.headers.get('request-id') === 'req_seam_1', `${text.length} vs ${sse.length}; status ${res.status}`)
  let rows = await waitForRows(file, 1)
  check('one row landed at <dir>/<session-id>.jsonl once the body passed', rows.length === 1 && rows[0]!.kind === 'request' && rows[0]!.url === '/v1/messages', `${rows.length} row(s) at ${file}`)
  const row = rows[0]!
  const rowText = j(row)
  check('the row carries the body in full, the model, the source — and no headers', row.body.model === 'claude-fable-5-1' && row.model === 'claude-fable-5-1' && row.source === 'prove' && row.headers === undefined && !rowText.includes('sk-ant-never-written') && !rowText.includes('x-api-key'), rowText.slice(0, 300))
  check('a key and a bearer value inside the body are scrubbed', rowText.includes('sk-ant-***') && rowText.includes('Bearer ***') && !rowText.includes('ABCDEFGHIJKLMNOP1234') && !rowText.includes('abcdefghijklmnopqrstuvwxyz0123'), rowText.slice(0, 300))
  check("the response's status, usage block, drop list, model, stop reason and reply head ride the row", row.response.status === 200 && row.response.usage?.cache_read_input_tokens === 4321 && row.response.usage?.output_tokens === 12 && row.response.input_transformations?.length === 1 && row.response.model === 'claude-fable-5-1' && row.response.stop_reason === 'end_turn' && row.response.text === 'DUMP-SEAM-REPLY' && typeof row.response.ms === 'number', j(row.response))

  const refused = await wrapped('http://fixture.local/v1/messages', { method: 'POST', body: j({ model: 'claude-opus-5', refuse: true, messages: [] }) })
  check('a refused request still reaches the caller as the 400 it was', refused.status === 400 && (await refused.text()).includes('deprecated'))
  rows = await waitForRows(file, 2)
  check('…and lands as a row with the status and the error message', rows.length === 2 && rows[1]!.response.status === 400 && (rows[1]!.response.error ?? '').includes('deprecated') && rows[1]!.model === 'claude-opus-5', j(rows[1]?.response))

  await wrapped('http://fixture.local/v1/models', { method: 'GET' })
  await wrapped('http://fixture.local/v1/messages/count_tokens', { method: 'POST', body: j({ model: 'claude-fable-5-1', messages: [] }) })
  await sleep(100)
  check('a GET and a count_tokens call write nothing', rowsOf(file).length === 2 && calls.length === 4, `${rowsOf(file).length} rows, ${calls.length} calls`)

  const failing: typeof globalThis.fetch = async () => {
    throw new Error('ECONNRESET fixture')
  }
  const wrappedFailing = wrapFetchWithWireDump(failing, 'prove')
  let thrown = ''
  try {
    await wrappedFailing('http://fixture.local/v1/messages', { method: 'POST', body: j({ model: 'claude-fable-5-1', messages: [] }) })
  } catch (error) {
    thrown = String(error)
  }
  rows = await waitForRows(file, 3)
  check('a transport failure lands as status 0 with the error and still throws to the caller', thrown.includes('ECONNRESET') && rows.length === 3 && rows[2]!.response.status === 0 && (rows[2]!.response.error ?? '').includes('ECONNRESET'), `${thrown} rows=${rows.length}`)

  const saved = process.env.MERCURY_WIRE_DUMP
  delete process.env.MERCURY_WIRE_DUMP
  check('unarmed: the wrapper IS the base fetch (identity)', wrapFetchWithWireDump(baseFetch, 'prove') === baseFetch)
  process.env.MERCURY_WIRE_DUMP = '   '
  check('a blank value is unarmed too', wrapFetchWithWireDump(baseFetch, 'prove') === baseFetch)
  process.env.MERCURY_WIRE_DUMP = saved

  check('scrubCredentials leaves ordinary text alone', scrubCredentials('a plain sentence with sk-ant- prefix only') === 'a plain sentence with sk-ant- prefix only')
  const reader = createWireResponseReader('application/json')
  reader.feed(j({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
  check('the JSON reader takes the error body once it has landed', reader.end().error === 'Overloaded')
}

// ============================================================================
section('§2 the wire — the built bundle with the dump armed, read back by the replay tool')
// ============================================================================
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'DUMP-WIRE-DONE', thinking: 'read the probe', usage: { input_tokens: 40, cache_read_input_tokens: 7 } },
      { kind: 'text', text: 'DUMP-WIRE-DONE-2', thinking: 'again', usage: { input_tokens: 60, cache_read_input_tokens: 40 } },
      { kind: 'text', text: 'DUMP-WIRE-UNARMED', thinking: 'control' },
    ]
    const fixture = await startFixtureApi(turns)
    const home = mkdtempSync(join(tmpdir(), 'wire-dump-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'wire-dump-cwd-'))
    const dumpDir = join(home, 'wire')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const env = (extra: Record<string, string>): Record<string, string> => ({
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.claude'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_THINKING_BINDING: 'drop_block',
      ...extra,
    })
    const run = (args: string[], extra: Record<string, string>): Promise<{ exit: number | null; stdout: string; stderr: string }> =>
      new Promise(resolvePromise => {
        const child = spawn(nodeBin, [DIST, ...args], { cwd, env: env(extra) })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    const SID = 'd0d0d0d0-0000-4000-8000-00000000d0d0'
    const common = ['--model', 'claude-opus-4-8', '--output-format', 'stream-json', '--verbose']
    const r1 = await run(['-p', 'wire dump probe; the key sk-ant-api03-QRSTUVWXYZ0123456789 must never land', ...common, '--session-id', SID], { MERCURY_WIRE_DUMP: dumpDir })
    check('the armed turn exits 0 and answers', r1.exit === 0 && r1.stdout.includes('DUMP-WIRE-DONE'), `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
    const file = join(dumpDir, `${SID}.jsonl`)
    const rows = await waitForRows(file, 1)
    check('<dir>/<session-id>.jsonl exists with the request row', rows.length >= 1, `${rows.length} at ${file}`)
    const main = rows.find(r => r.model === 'claude-opus-4-8' && j(r.body).includes('wire dump probe'))
    check('the row carries the full body (model, the prompt), the source, and no headers', main !== undefined && main.headers === undefined && main.source !== undefined, main ? j(main).slice(0, 300) : 'no main row')
    check('the key in the prompt is scrubbed on the way to the file', main !== undefined && j(main.body).includes('sk-ant-***') && !j(main).includes('QRSTUVWXYZ0123456789'))
    check("the fixture's usage rides the row (cache_read 7) with status 200 and the reply head", main?.response.status === 200 && main?.response.usage?.cache_read_input_tokens === 7 && main?.response.text === 'DUMP-WIRE-DONE', j(main?.response))
    const r2 = await run(['-p', 'second turn', ...common, '--resume', SID], { MERCURY_WIRE_DUMP: dumpDir })
    check('a resumed turn appends to the same file', r2.exit === 0 && (await waitForRows(file, 2)).length >= 2, `exit=${r2.exit}`)
    const capture = readCapture(file)
    const pairs = reportPairs(capture.filter(r => r.model === 'claude-opus-4-8'))
    check('the replay tool reads the dump as it is and diffs the pair', capture.length >= 2 && pairs.length >= 1 && typeof pairs[0]!.verdict.held === 'boolean' && pairs[0]!.cacheRead === 40, pairs.map(p => `${p.verdict.held} cache=${p.cacheRead}`).join(' | '))
    const r3 = await run(['-p', 'unarmed turn', ...common, '--session-id', 'd0d0d0d0-0000-4000-8000-00000000d0d1'], {})
    check('unarmed: the turn runs and no file is written', r3.exit === 0 && !existsSync(join(dumpDir, 'd0d0d0d0-0000-4000-8000-00000000d0d1.jsonl')), `exit=${r3.exit}`)
    await fixture.close()
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ WIRE DUMP GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} WIRE DUMP FAILURE(S) (${checks} checks)`)
process.exit(1)
