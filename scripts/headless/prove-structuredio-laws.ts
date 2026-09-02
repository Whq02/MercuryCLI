#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-structuredio-laws.ts — StructuredIO's protocol
//  laws, in-process.
//
//  Instantiates the REAL StructuredIO over a harness-controlled input stream
//  and freezes the output-sink layer's laws (the Phase-1 banked ownership
//  item):
//
//    S1 line framing — partial lines buffer across input blocks; the final
//       unterminated line still processes; empty lines skip
//    S2 prepend — prependUserMessage lands BEFORE the next input message,
//       both pre-iteration and mid-stream
//    S3 swallowed control types — keep_alive ignored;
//       update_environment_variables applies to process.env and is swallowed
//    S4 request/response — sendRequest enqueues to the OUTBOUND stream (the
//       one-writer FIFO law) and a matching control_response resolves it
//       through the zod schema; an error response rejects
//    S5 the duplicate/orphan law — an unknown request_id routes to the
//       unexpected-response callback; a duplicate for an ALREADY-RESOLVED
//       tool_use is ignored entirely (the 400 tool_use-uniqueness guard)
//    S6 the abort law — aborting a pending request enqueues
//       control_cancel_request, rejects with AbortError, and marks the
//       tool_use resolved so a LATE response is ignored
//    S7 the close law — input end rejects every pending request and
//       subsequent sendRequest calls throw 'Stream closed'
//
//  Run:  ~/.bun/bin/bun run scripts/headless/prove-structuredio-laws.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sio-laws-'))

import { z } from 'zod/v4'

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — structuredIO laws exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

// ── harness ─────────────────────────────────────────────────────────────────

/** A push-driven async input the harness owns; push() feeds raw blocks. */
function makeInput(): {
  iterable: AsyncIterable<string>
  push: (block: string) => void
  end: () => void
} {
  const queue: string[] = []
  let done = false
  let wake: (() => void) | null = null
  return {
    push: b => {
      queue.push(b)
      wake?.()
    },
    end: () => {
      done = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (done) return
          await new Promise<void>(r => {
            wake = r
          })
          wake = null
        }
      },
    },
  }
}

type Harness = {
  io: InstanceType<typeof StructuredIO>
  push: (o: unknown) => void
  pushRaw: (raw: string) => void
  end: () => void
  received: Array<Record<string, unknown>>
  outbound: Array<Record<string, unknown>>
  settle: () => Promise<void>
}

function makeHarness(replayUserMessages?: boolean): Harness {
  const input = makeInput()
  const io = new StructuredIO(input.iterable, replayUserMessages)
  const received: Array<Record<string, unknown>> = []
  const outbound: Array<Record<string, unknown>> = []
  // Consume the parsed-input generator continuously.
  void (async () => {
    for await (const m of io.structuredInput) {
      received.push(m as Record<string, unknown>)
    }
  })()
  // Drain the outbound FIFO continuously (print.ts's drain-loop stand-in).
  void (async () => {
    for await (const m of io.outbound) {
      outbound.push(m as Record<string, unknown>)
    }
  })()
  return {
    io,
    push: o => input.push(JSON.stringify(o) + '\n'),
    pushRaw: raw => input.push(raw),
    end: () => input.end(),
    received,
    outbound,
    settle: () => new Promise(r => setTimeout(r, 40)),
  }
}

console.log('============================================================')
console.log(' StructuredIO — the protocol-layer laws')
console.log('============================================================')

// ── S1 + S2 framing and prepend ─────────────────────────────────────────────
section('S1/S2 — line framing across blocks · prepend ordering · trailing line')
{
  const h = makeHarness()
  h.io.prependUserMessage('prepended first')
  const userMsg = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  // One message split across two blocks + an empty line.
  const whole = userMsg('split across blocks')
  h.pushRaw(whole.slice(0, 25))
  await h.settle()
  check('a partial line does NOT yield early', h.received.filter(m => m.type === 'user').length <= 1)
  h.pushRaw(whole.slice(25) + '\n\n')
  await h.settle()
  const users = () => h.received.filter(m => m.type === 'user').map(m => j(m))
  check('the PREPENDED message yielded FIRST', users()[0]?.includes('prepended first') === true, j(users()))
  check('the split message reassembled exactly once', users().filter(u => u.includes('split across blocks')).length === 1, j(users()))
  // Mid-stream prepend: lands before the next pushed message.
  h.io.prependUserMessage('prepended mid-stream')
  h.push({ type: 'user', message: { role: 'user', content: 'after mid-prepend' }, parent_tool_use_id: null, session_id: '' })
  await h.settle()
  const u = users()
  check('a mid-stream prepend lands before the next input message', u.indexOf(u.find(x => x.includes('prepended mid-stream'))!) < u.indexOf(u.find(x => x.includes('after mid-prepend'))!), j(u))
  // Trailing unterminated line processes at end.
  h.pushRaw(userMsg('trailing no newline'))
  h.end()
  await h.settle()
  check('the final unterminated line still processes', users().some(x => x.includes('trailing no newline')), j(users()))
}

// ── S3 swallowed types ──────────────────────────────────────────────────────
section('S3 — keep_alive swallowed · update_environment_variables applied + swallowed')
{
  const h = makeHarness()
  delete process.env.SIO_LAW_PROBE
  h.push({ type: 'keep_alive' })
  h.push({ type: 'update_environment_variables', variables: { SIO_LAW_PROBE: 'applied' } })
  await h.settle()
  check('keep_alive never reaches the consumer', !h.received.some(m => m.type === 'keep_alive'))
  check('update_environment_variables applies to process.env', process.env.SIO_LAW_PROBE === 'applied')
  check('…and is swallowed', !h.received.some(m => m.type === 'update_environment_variables'))
  delete process.env.SIO_LAW_PROBE
  h.end()
}

// ── S4 request/response through the outbound FIFO ───────────────────────────
section('S4 — sendRequest rides the outbound FIFO; a response resolves through the schema')
{
  const h = makeHarness()
  const sendRequest = (
    h.io as unknown as {
      sendRequest: (r: Record<string, unknown>, s: z.Schema, sig?: AbortSignal, id?: string) => Promise<unknown>
    }
  ).sendRequest.bind(h.io)
  const p = sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_s4' }, z.object({ ok: z.boolean() }), undefined, 'req_s4')
  await h.settle()
  check('the request was ENQUEUED to outbound (one-writer FIFO), not written directly', h.outbound.some(m => m.type === 'control_request' && j(m).includes('req_s4')), j(h.outbound))
  h.push({ type: 'control_response', response: { subtype: 'success', request_id: 'req_s4', response: { ok: true } } })
  const result = await p
  check('the matching response resolves through the zod schema', j(result) === '{"ok":true}', j(result))

  const pErr = sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_s4e' }, z.object({}), undefined, 'req_s4e')
  h.push({ type: 'control_response', response: { subtype: 'error', request_id: 'req_s4e', error: 'host said no' } })
  const err = await pErr.then(
    () => undefined,
    (e: Error) => e.message,
  )
  check('an error response REJECTS with the host message', err === 'host said no', String(err))
  h.end()
}

// ── S5 duplicate/orphan law ─────────────────────────────────────────────────
section('S5 — unknown ids route to the orphan callback; already-resolved tool_uses are ignored')
{
  const h = makeHarness()
  const orphans: Array<Record<string, unknown>> = []
  h.io.setUnexpectedResponseCallback(async r => {
    orphans.push(r as unknown as Record<string, unknown>)
  })
  h.push({ type: 'control_response', response: { subtype: 'success', request_id: 'req_never_sent', response: {} } })
  await h.settle()
  check('an unknown request_id routes to the orphan callback', orphans.length === 1, `${orphans.length}`)

  // Resolve a real request, then replay a DUPLICATE for the same tool_use.
  const sendRequest = (
    h.io as unknown as {
      sendRequest: (r: Record<string, unknown>, s: z.Schema, sig?: AbortSignal, id?: string) => Promise<unknown>
    }
  ).sendRequest.bind(h.io)
  const p = sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_dup' }, z.object({}).passthrough(), undefined, 'req_dup1')
  h.push({ type: 'control_response', response: { subtype: 'success', request_id: 'req_dup1', response: { toolUseID: 'tu_dup' } } })
  await p
  orphans.length = 0
  h.push({ type: 'control_response', response: { subtype: 'success', request_id: 'req_dup2_unknown', response: { toolUseID: 'tu_dup' } } })
  await h.settle()
  check('a duplicate response for an ALREADY-RESOLVED tool_use is ignored (no orphan handling)', orphans.length === 0, `${orphans.length}`)
  h.end()
}

// ── S6 the abort law ────────────────────────────────────────────────────────
section('S6 — aborting a pending request cancels, rejects, and immunizes the tool_use')
{
  const h = makeHarness()
  const orphans: Array<Record<string, unknown>> = []
  h.io.setUnexpectedResponseCallback(async r => {
    orphans.push(r as unknown as Record<string, unknown>)
  })
  const sendRequest = (
    h.io as unknown as {
      sendRequest: (r: Record<string, unknown>, s: z.Schema, sig?: AbortSignal, id?: string) => Promise<unknown>
    }
  ).sendRequest.bind(h.io)
  const ac = new AbortController()
  const p = sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_abort' }, z.object({}), ac.signal, 'req_abort')
  await h.settle()
  ac.abort()
  const rejected = await p.then(
    () => false,
    (e: Error) => e.constructor.name,
  )
  check('the pending request rejects with AbortError', rejected === 'AbortError', String(rejected))
  await h.settle()
  check('a control_cancel_request is enqueued for the host', h.outbound.some(m => m.type === 'control_cancel_request' && j(m).includes('req_abort')), j(h.outbound.map(m => m.type)))
  h.push({ type: 'control_response', response: { subtype: 'success', request_id: 'req_late', response: { toolUseID: 'tu_abort' } } })
  await h.settle()
  check('a LATE response for the aborted tool_use is ignored', orphans.length === 0, `${orphans.length}`)
  h.end()
}

// ── S7 the close law ────────────────────────────────────────────────────────
section('S7 — input close rejects pending requests; later sends refuse')
{
  const h = makeHarness()
  const sendRequest = (
    h.io as unknown as {
      sendRequest: (r: Record<string, unknown>, s: z.Schema, sig?: AbortSignal, id?: string) => Promise<unknown>
    }
  ).sendRequest.bind(h.io)
  const p = sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_close' }, z.object({}), undefined, 'req_close')
  await h.settle()
  h.end()
  const msg = await p.then(
    () => undefined,
    (e: Error) => e.message,
  )
  check('pending requests reject when the input stream closes', (msg ?? '').includes('stream closed before response'), String(msg))
  const late = await sendRequest({ subtype: 'can_use_tool', tool_name: 'X', input: {}, tool_use_id: 'tu_after' }, z.object({}), undefined, 'req_after').then(
    () => undefined,
    (e: Error) => e.message,
  )
  check("post-close sendRequest throws 'Stream closed'", late === 'Stream closed', String(late))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ STRUCTUREDIO LAWS GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} STRUCTUREDIO LAW FAILURE(S)`)
process.exit(1)
