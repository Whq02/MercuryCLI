#!/usr/bin/env bun
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

section('§1 the seam — the fetch wrapper records a row, scrubs, and never touches the stream')
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

  await wrapped('http://fixture.local/v1/organizations', { method: 'GET' })
  await wrapped('http://fixture.local/v1/messages/count_tokens', { method: 'POST', body: j({ model: 'claude-fable-5-1', messages: [] }) })
  await sleep(100)
  check('a GET off the models road and a count_tokens call write nothing', rowsOf(file).length === 2 && calls.length === 4, `${rowsOf(file).length} rows, ${calls.length} calls`)

  const responsesSse = [
    `event: response.created\ndata: ${j({ type: 'response.created', response: { id: 'resp_seam_1', model: 'gpt-6-astra', status: 'in_progress' } })}\n\n`,
    `event: response.output_item.added\ndata: ${j({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_seam_1', summary: [] } })}\n\n`,
    `event: response.reasoning_summary_text.delta\ndata: ${j({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_seam_1', delta: 'weighing it' })}\n\n`,
    `event: response.output_item.added\ndata: ${j({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_seam_1', role: 'assistant', status: 'in_progress', content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${j({ type: 'response.output_text.delta', item_id: 'msg_seam_1', delta: 'SEAM-' })}\n\n`,
    `event: response.output_text.delta\ndata: ${j({ type: 'response.output_text.delta', item_id: 'msg_seam_1', delta: 'ASTRA' })}\n\n`,
    `event: response.completed\ndata: ${j({ type: 'response.completed', response: { id: 'resp_seam_1', model: 'gpt-6-astra', status: 'completed', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 176 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1230 } } })}\n\n`,
  ].join('')
  const servedList = {
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'max', description: 'max' }], default_reasoning_level: 'high', context_window: 1_050_000, max_context_window: 1_050_000, input_modalities: ['text', 'image'], supported_in_api: true },
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 2, supported_reasoning_levels: [], context_window: 272_000 },
      { display_name: 'no id — skipped' },
    ],
  }
  const openaiFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.endsWith('/backend-api/codex/responses') && method === 'POST') {
      if (String(init?.body).includes('"refuse"')) {
        return new Response(j({ error: { message: 'model not in the live catalogue', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      const parts = [responsesSse.slice(0, 150), responsesSse.slice(150, 500), responsesSse.slice(500)]
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
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.includes('/backend-api/codex/models') && method === 'GET') {
      return new Response(j(servedList), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/v1/models') && method === 'GET') {
      return new Response(j({ object: 'list', data: [{ id: 'gpt-6-astra', object: 'model' }, { id: 'gpt-5.6-sol', object: 'model' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const wrappedOpenai = wrapFetchWithWireDump(openaiFetch, 'openai')
  const responsesBody = j({ model: 'gpt-6-astra', instructions: 'SEAM-INSTRUCTIONS', input: [{ role: 'user', content: [{ type: 'input_text', text: 'seam probe' }] }], reasoning: { effort: 'max', summary: 'auto' }, store: false, stream: true, prompt_cache_key: 'mercury-domain:seam' })
  const astra = await wrappedOpenai('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: responsesBody, headers: { authorization: 'Bearer never-written-token-0123456789', 'content-type': 'application/json' } })
  const astraText = await astra.text()
  check('the OpenAI lane: the caller reads the whole Responses stream through the tee', astraText === responsesSse && astra.status === 200, `${astraText.length} vs ${responsesSse.length}`)
  rows = await waitForRows(file, 3)
  const astraRow = rows[2]
  check('a Responses POST lands as a request row: the body in full, the model, the source, no headers', astraRow !== undefined && astraRow.kind === 'request' && astraRow.url === '/backend-api/codex/responses' && astraRow.model === 'gpt-6-astra' && astraRow.source === 'openai' && (astraRow.body as { reasoning?: { effort?: string } }).reasoning?.effort === 'max' && !j(astraRow).includes('never-written-token'), astraRow ? j(astraRow).slice(0, 300) : 'no row')
  check("the usage is flattened: cached_tokens · cache_write_tokens · reasoning_tokens beside the totals; the reply head, the model and 'completed' ride the row", astraRow?.response.usage?.input_tokens === 1200 && astraRow.response.usage.cached_tokens === 1024 && astraRow.response.usage.cache_write_tokens === 176 && astraRow.response.usage.output_tokens === 30 && astraRow.response.usage.reasoning_tokens === 20 && astraRow.response.text === 'SEAM-ASTRA' && astraRow.response.model === 'gpt-6-astra' && astraRow.response.stop_reason === 'completed', j(astraRow?.response))
  const firstByte = (astraRow?.response as { firstByteMs?: number } | undefined)?.firstByteMs
  check('the first byte is timed on the row (headers), at or before the body end', typeof firstByte === 'number' && firstByte >= 0 && firstByte <= (astraRow?.response.ms ?? -1), `firstByteMs=${String(firstByte)} ms=${String(astraRow?.response.ms)}`)
  const refusedAstra = await wrappedOpenai('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: j({ model: 'gpt-6-astra', refuse: true, input: [] }) })
  check('a refused Responses call still reaches the caller as the 400 it was', refusedAstra.status === 400 && (await refusedAstra.text()).includes('live catalogue'))
  rows = await waitForRows(file, 4)
  check('…and lands as a row with the status and the error message', rows[3]?.response.status === 400 && (rows[3]?.response.error ?? '').includes('live catalogue'), j(rows[3]?.response))
  const listed = await wrappedOpenai('https://chatgpt.com/backend-api/codex/models?client_version=1', { method: 'GET', headers: { authorization: 'Bearer never-written-token-0123456789' } })
  const listedBody = (await listed.json()) as { models?: unknown[] }
  check('the caller reads the models list whole through the tee', listed.status === 200 && listedBody.models?.length === 3)
  rows = await waitForRows(file, 5)
  type CatalogueRow = { kind: string; url: string; source?: string; response: { status: number; ms: number; firstByteMs?: number; models?: Array<Record<string, unknown>>; error?: string } }
  const catalogue = rows[4] as unknown as CatalogueRow | undefined
  check('a models-list GET lands as a catalogue row: the served rows, never a header', catalogue?.kind === 'catalogue' && catalogue.url === '/backend-api/codex/models' && catalogue.source === 'openai' && catalogue.response.status === 200 && !j(catalogue).includes('never-written-token') && typeof catalogue.response.firstByteMs === 'number', catalogue ? j(catalogue).slice(0, 300) : 'no row')
  const served = catalogue?.response.models ?? []
  check("each served row reads to its id and the facts beside it (window · ceiling · ladder · default · modalities · rank · visibility · api); a row without an id is skipped", served.length === 2 && served[0]?.id === 'gpt-6-astra' && served[0].display_name === 'GPT-6 Astra' && served[0].context_window === 1_050_000 && served[0].max_context_window === 1_050_000 && j(served[0].efforts) === j(['low', 'max']) && served[0].default_effort === 'high' && j(served[0].input_modalities) === j(['text', 'image']) && served[0].priority === 1 && served[0].visibility === 'list' && served[0].supported_in_api === true && served[1]?.id === 'gpt-5.6-sol' && j(served[1].efforts) === j([]) && served[1].context_window === 272_000, j(served))
  await (await wrappedOpenai('https://api.openai.com/v1/models', { method: 'GET' })).json()
  rows = await waitForRows(file, 6)
  const bare = rows[5] as unknown as CatalogueRow | undefined
  check('the id-only list (the API base) lands as a catalogue row of ids', bare?.kind === 'catalogue' && bare.url === '/v1/models' && j(bare.response.models?.map(m => m.id)) === j(['gpt-6-astra', 'gpt-5.6-sol']), j(bare?.response))

  const heldFetch: typeof globalThis.fetch = async (_input, init) => {
    const parts = [responsesSse.slice(0, 700), responsesSse.slice(700)]
    let held: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        held = controller
        init?.signal?.addEventListener('abort', () => {
          try {
            controller.error(new DOMException('This operation was aborted', 'AbortError'))
          } catch {
          }
        })
      },
      async pull(controller) {
        const next = parts.shift()
        if (next === undefined) return
        await sleep(5)
        controller.enqueue(new TextEncoder().encode(next))
      },
    })
    void held
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const wrappedHeld = wrapFetchWithWireDump(heldFetch, 'openai')
  const readUntilEnd = async (res: Response): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; seen: string }> => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('response.completed')) {
      const next = await reader.read()
      if (next.done) break
      seen += decoder.decode(next.value, { stream: true })
    }
    return { reader, seen }
  }
  const cancelled = await wrappedHeld('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: responsesBody })
  const cancelledRead = await readUntilEnd(cancelled)
  await cancelledRead.reader.cancel()
  rows = await waitForRows(file, 7)
  check('the caller cancels the body at the end event: the row lands with the usage, the model, the reply head and no fault', rows[6]?.response.usage?.cache_write_tokens === 176 && rows[6].response.stop_reason === 'completed' && rows[6].response.text === 'SEAM-ASTRA' && rows[6].response.error === undefined, j(rows[6]?.response))
  const aborter = new AbortController()
  const aborted = await wrappedHeld('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: responsesBody, signal: aborter.signal })
  const abortedRead = await readUntilEnd(aborted)
  aborter.abort()
  let abortedFault = ''
  try {
    await abortedRead.reader.read()
  } catch (error) {
    abortedFault = String(error)
  }
  rows = await waitForRows(file, 8)
  check('the caller aborts the connection at the end event: the caller sees its abort, the row still carries the usage and no fault', abortedFault.includes('abort') && rows[7]?.response.usage?.cached_tokens === 1024 && rows[7].response.stop_reason === 'completed' && rows[7].response.error === undefined, `${abortedFault} ${j(rows[7]?.response)}`)
  const octetFetch: typeof globalThis.fetch = async () =>
    new Response(new TextEncoder().encode(responsesSse), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  const octet = await wrapFetchWithWireDump(octetFetch, 'openai')('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: responsesBody })
  await octet.text()
  rows = await waitForRows(file, 9)
  check('an event stream under another content-type still reads as SSE: the usage, the text, the model and the content type ride the row', rows[8]?.response.usage?.cache_write_tokens === 176 && rows[8].response.text === 'SEAM-ASTRA' && rows[8].response.stop_reason === 'completed' && (rows[8].response as { contentType?: string }).contentType === 'application/octet-stream', j(rows[8]?.response))
  const cutEarly = await wrappedHeld('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: responsesBody })
  await cutEarly.body!.getReader().cancel()
  rows = await waitForRows(file, 10)
  check('a body cut before its end event lands as the fault it was', (rows[9]?.response.error ?? '').includes('the body ended early') && rows[9]?.response.usage === undefined, j(rows[9]?.response))

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
  rows = await waitForRows(file, 11)
  check('a transport failure lands as status 0 with the error and still throws to the caller', thrown.includes('ECONNRESET') && rows.length === 11 && rows[10]!.response.status === 0 && (rows[10]!.response.error ?? '').includes('ECONNRESET'), `${thrown} rows=${rows.length}`)

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
  const responsesJson = createWireResponseReader('application/json')
  responsesJson.feed(j({ object: 'response', id: 'resp_json', model: 'gpt-6-astra', status: 'completed', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } }))
  const responsesEnd = responsesJson.end()
  check('a non-streamed Responses body flattens its usage too', responsesEnd.usage?.cache_write_tokens === 10 && responsesEnd.usage.input_tokens === 10 && responsesEnd.model === 'gpt-6-astra', j(responsesEnd))
}

section('§1b the replay tool reads Responses rows in the prefix law\'s terms')
{
  const { writeFileSync } = await import('node:fs')
  const { normalizeWireBody, messageRows: rowsOfMessages, printReport, formatPairLine } = await import('./wire-prefix-replay.ts')
  const tools = [{ type: 'function', name: 'Read', description: 'read a file', parameters: { type: 'object' } }]
  const turn1 = { role: 'user', content: [{ type: 'input_text', text: 'first' }] }
  const reply1 = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }] }
  const turn2 = { role: 'user', content: [{ type: 'input_text', text: 'second' }] }
  const rowOf = (seq: number, body: unknown, usage: Record<string, number>): string =>
    j({ kind: 'request', seq, at: 1_725_000_000_000 + seq, url: '/backend-api/codex/responses', model: 'gpt-6-astra', source: 'openai', body, response: { status: 200, ms: 10, firstByteMs: 3, usage, stop_reason: 'completed' } })
  const file = join(PURE_DIR, 'replay-responses.jsonl')
  writeFileSync(
    file,
    [
      rowOf(1, { model: 'gpt-6-astra', instructions: 'SYS', tools, input: [turn1], reasoning: { effort: 'low', summary: 'auto' } }, { input_tokens: 100, cached_tokens: 0, cache_write_tokens: 100, output_tokens: 5 }),
      rowOf(2, { model: 'gpt-6-astra', instructions: 'SYS', tools, input: [turn1, reply1, turn2], reasoning: { effort: 'low', summary: 'auto' } }, { input_tokens: 130, cached_tokens: 100, cache_write_tokens: 30, output_tokens: 5 }),
      rowOf(3, { model: 'gpt-6-astra', instructions: 'SYS-moved', tools, input: [turn1, reply1, turn2], reasoning: { effort: 'low', summary: 'auto' } }, { input_tokens: 130, cached_tokens: 0, cache_write_tokens: 130, output_tokens: 5 }),
    ].join('\n') + '\n',
  )
  const normalized = normalizeWireBody({ model: 'gpt-6-astra', instructions: 'SYS', tools, input: [turn1] })
  check('a Responses body reads instructions as the system and input as the messages (the originals kept)', normalized.system === 'SYS' && Array.isArray(normalized.messages) && normalized.messages.length === 1 && normalized.instructions === 'SYS' && Array.isArray(normalized.input), j(normalized))
  check('a messages body is untouched', j(normalizeWireBody({ model: 'claude-fable-5-1', system: [{ type: 'text', text: 's' }], messages: [] })) === j({ model: 'claude-fable-5-1', system: [{ type: 'text', text: 's' }], messages: [] }))
  const capture = readCapture(file)
  check('the capture reads all three Responses rows as message rows', capture.length === 3 && rowsOfMessages(capture).length === 3, `${capture.length} / ${rowsOfMessages(capture).length}`)
  const pairs = reportPairs(capture)
  check('#1→#2 HELD with two rows appended; the cache read is the wire\'s cached_tokens', pairs[0]?.verdict.held === true && pairs[0].verdict.appended === 2 && pairs[0].cacheRead === 100, pairs[0] ? formatPairLine(pairs[0]) : 'no pair')
  check('#2→#3 BROKE at the system (the instructions moved) with the char named', pairs[1]?.verdict.held === false && pairs[1].verdict.term === 'system' && (pairs[1].verdict.diff?.path ?? '').startsWith('system@char 3') && pairs[1].cacheRead === 0, pairs[1] ? formatPairLine(pairs[1]) : 'no pair')
  const logged: string[] = []
  const original = console.log
  console.log = (line?: unknown) => {
    logged.push(String(line ?? ''))
  }
  try {
    printReport(capture, { quiet: true })
  } finally {
    console.log = original
  }
  check('the report prints the Responses rows with their cache reads', logged.some(l => l.includes('#2  gpt-6-astra') && l.includes('cache_read=100')), logged.slice(0, 5).join(' | '))
}

section('§2 the wire — the built bundle with the dump armed, read back by the replay tool')
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
