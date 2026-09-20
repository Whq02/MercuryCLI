#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stream-cut-forensics-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.js')
const forensicsOwner = await import('../../src/services/providers/openai/streamCutForensics.js')
type OpenaiFault = import('../../src/services/providers/openai/openaiWire.js').OpenaiFault

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const REQUEST = { model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tell the story' }] }], stream: true }
const HEADERS = {
  'content-type': 'text/event-stream',
  'cf-ray': '8f1c2d3e4a5b6c7d-LHR',
  'x-request-id': 'req_fixture_0001',
  'openai-processing-ms': '1234',
  authorization: 'Bearer never-logged',
  'set-cookie': 'session=never-logged',
}

function terminated(): Error {
  const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  return Object.assign(new TypeError('terminated'), { cause })
}

type Cut = { chunks: string[]; gapMs: number; end: 'terminated' | 'close' | 'complete' }
function fetchOf(cut: Cut, seen: { authorization?: string }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.authorization = headers.authorization
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of cut.chunks) {
          controller.enqueue(encoder.encode(chunk))
          await new Promise(r => setTimeout(r, cut.gapMs))
        }
        if (cut.end === 'terminated') controller.error(terminated())
        else controller.close()
      },
    })
    return new Response(body, { status: 200, headers: HEADERS })
  }) as typeof fetch
}

async function play(cut: Cut): Promise<{ faults: OpenaiFault[]; events: string[]; authorization?: string }> {
  const seen: { authorization?: string } = {}
  const faults: OpenaiFault[] = []
  const events: string[] = []
  for await (const event of streamOpenaiResponses({
    baseUrl: 'http://127.0.0.1:9/chatgpt',
    headers: { authorization: 'Bearer never-logged' },
    request: REQUEST as never,
    fetchImpl: fetchOf(cut, seen),
    idleTimeoutMs: 5_000,
  })) {
    events.push(event.type)
    if (event.type === 'stream-fault') faults.push(event.fault)
  }
  return { faults, events, ...(seen.authorization !== undefined ? { authorization: seen.authorization } : {}) }
}

section('1 · a peer close mid-text is the read-failed fault the record shows, with the forensics on it')
{
  const r = await play({
    chunks: [
      sse({ type: 'response.created', response: { id: 'resp_cut' } }),
      sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_cut', type: 'message', role: 'assistant', content: [] } }),
      sse({ type: 'response.output_text.delta', item_id: 'msg_cut', delta: 'Once upon a time, ' }),
    ],
    gapMs: 30,
    end: 'terminated',
  })
  const fault = r.faults[0]
  check('one fault', r.faults.length === 1, String(r.faults.length))
  check('the fault is read-failed', fault?.kind === 'transport-error' && fault.code === 'read-failed', JSON.stringify(fault))
  check("the fault's words are the transport's own", fault?.message === 'terminated', String(fault?.message))
  check('the text delta was yielded before the cut', r.events.includes('text-delta'), r.events.join(','))
  const f = fault?.forensics
  check('the fault carries its forensics', f !== undefined, JSON.stringify(fault))
  check('the phase is mid-text', f?.phase === 'mid-text', String(f?.phase))
  check('one text delta, no reasoning delta', f?.textDeltas === 1 && f?.reasoningDeltas === 0, JSON.stringify(f))
  check('three events were received', f?.events === 3, String(f?.events))
  check('the bytes received are counted', (f?.bytes ?? 0) > 100, String(f?.bytes))
  check('the timings are non-negative milliseconds', f !== undefined && f.sinceStartMs >= 0 && f.sinceHeadersMs >= 0 && f.sinceLastByteMs >= 0 && f.sinceStartMs >= f.sinceHeadersMs, JSON.stringify(f))
  check('the edge headers ride, by their names', f?.headers['cf-ray'] === '8f1c2d3e4a5b6c7d-LHR' && f?.headers['x-request-id'] === 'req_fixture_0001' && f?.headers['content-type'] === 'text/event-stream' && f?.headers['openai-processing-ms'] === '1234', JSON.stringify(f?.headers))
  check('the credential headers never ride', f !== undefined && !('authorization' in f.headers) && !('set-cookie' in f.headers), JSON.stringify(f?.headers))
  check('the request size class is named', f?.requestSizeClass === 'small (under 16 KB)' && (f?.requestBytes ?? 0) > 0, JSON.stringify({ c: f?.requestSizeClass, b: f?.requestBytes }))
  check('the protocol is named for an injected fetch', f?.protocol === 'unknown (an injected fetch)', String(f?.protocol))
  check("the transport's cause rides with its code", f?.cause === 'other side closed (UND_ERR_SOCKET)', String(f?.cause))
  const line = f === undefined ? '' : forensicsOwner.streamCutForensicsLine('ChatGPT pro subscription', fault!, f)
  check('the debug line names the road, the code and what the provider sent', line.includes('road=ChatGPT pro subscription') && line.includes('code=read-failed') && line.includes('sent=terminated'), line.slice(0, 200))
  check('the debug line carries every forensic field', ['protocol=', 'since-start=', 'since-headers=', 'since-last-byte=', 'bytes=', 'events=', 'phase=mid-text', 'text-deltas=1', 'reasoning-deltas=0', 'tool-argument-deltas=0', 'items-settled=', 'request=small (under 16 KB)', 'cf-ray=8f1c2d3e4a5b6c7d-LHR', 'cause=other side closed (UND_ERR_SOCKET)'].every(needle => line.includes(needle)), line)
  check('the debug line carries no credential', !line.includes('never-logged') && !line.includes('Bearer'), line)
  const detail = f === undefined ? '' : forensicsOwner.streamCutForensicsDetail(fault!, f)
  check('the record detail is code-first and carries the same fields', detail.startsWith('read-failed · protocol=') && detail.includes('phase=mid-text'), detail.slice(0, 120))
}

section('2 · a cut during reasoning, before any visible token, reads mid-reasoning')
{
  const r = await play({
    chunks: [
      sse({ type: 'response.created', response: { id: 'resp_cut_r' } }),
      sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking about it' }),
    ],
    gapMs: 30,
    end: 'terminated',
  })
  const f = r.faults[0]?.forensics
  check('the phase is mid-reasoning', f?.phase === 'mid-reasoning', String(f?.phase))
  check('no visible token was counted', f?.textDeltas === 0 && f?.reasoningDeltas === 1, JSON.stringify(f))
}

section('3 · a close with no bytes after the headers reads before-first-event')
{
  const r = await play({ chunks: [], gapMs: 0, end: 'terminated' })
  const f = r.faults[0]?.forensics
  check('the fault is read-failed', r.faults[0]?.code === 'read-failed', JSON.stringify(r.faults[0]))
  check('the phase is before-first-event', f?.phase === 'before-first-event', String(f?.phase))
  check('zero bytes and events', f?.bytes === 0 && f?.events === 0, JSON.stringify(f))
}

section('4 · a quiet close without a terminal event carries the forensics too')
{
  const r = await play({
    chunks: [
      sse({ type: 'response.created', response: { id: 'resp_close' } }),
      sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the whole reply' }] } }),
    ],
    gapMs: 30,
    end: 'close',
  })
  const fault = r.faults[0]
  check('the fault is no-terminal-event', fault?.code === 'no-terminal-event', JSON.stringify(fault))
  check('its phase is between-items with one item settled', fault?.forensics?.phase === 'between-items' && fault.forensics.itemsSettled === 1, JSON.stringify(fault?.forensics))
}

section('5 · a completed stream carries no fault and no forensics')
{
  const r = await play({
    chunks: [
      sse({ type: 'response.created', response: { id: 'resp_ok' } }),
      sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fine' }] } }),
      sse({ type: 'response.completed', response: { id: 'resp_ok', usage: { input_tokens: 3, output_tokens: 1 } } }),
    ],
    gapMs: 10,
    end: 'complete',
  })
  check('no fault', r.faults.length === 0, JSON.stringify(r.faults))
  check('the finish event came', r.events.includes('finish'), r.events.join(','))
}

section('6 · the pure owners')
{
  check('size classes', forensicsOwner.requestSizeClassOf(1024) === 'small (under 16 KB)' && forensicsOwner.requestSizeClassOf(64 * 1024) === 'medium (16 KB to 128 KB)' && forensicsOwner.requestSizeClassOf(300 * 1024) === 'large (128 KB to 512 KB)' && forensicsOwner.requestSizeClassOf(2 * 1024 * 1024) === 'very large (512 KB or more)')
  check('the header allowlist never names a credential header', !forensicsOwner.EDGE_HEADER_NAMES.some(name => /authorization|cookie|token|key/i.test(name)), forensicsOwner.EDGE_HEADER_NAMES.join(','))
  check('a long header value is capped', forensicsOwner.edgeHeadersOf({ get: (name: string) => (name === 'server' ? 'x'.repeat(200) : null) }).server?.length === 81)
  check('the phase reader', forensicsOwner.streamCutPhaseOf({ last: 'tool-args-delta', events: 4 }) === 'mid-tool-arguments' && forensicsOwner.streamCutPhaseOf({ last: 'text-item-done', events: 2 }) === 'between-items' && forensicsOwner.streamCutPhaseOf({ last: 'none', events: 0 }) === 'before-first-event')
  check('the protocol words under this runtime', /^(HTTP\/1\.1 \(the dispatcher allows no HTTP\/2\)|unknown \(the platform fetch\))$/.test(forensicsOwner.dispatcherProtocolWords(false)), forensicsOwner.dispatcherProtocolWords(false))
  check('the cause words read the code', forensicsOwner.causeWordsOf(terminated()) === 'other side closed (UND_ERR_SOCKET)' && forensicsOwner.causeWordsOf(new Error('bare')) === undefined)
}

console.log(failures === 0 ? '\nprove-stream-cut-forensics: ALL LAWS HOLD' : `\nprove-stream-cut-forensics: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
