#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-tool-delta-grammar.ts
//  Responses-codec streaming truth:
//  the openai lane surfaces tool-call argument bytes LIVE through the ONE
//  canonical stream grammar, with settlement staying exactly-once from the
//  validated done item. The field spec this closes: sol T3's 328 seconds of
//  recorded silence during a big Write — first visible tool-input activity
//  now rides the first provider byte.
//
//  Two layers, both driven deterministically (no network):
//   · the SSE fold (ResponsesStreamFold) — identity, prompt forwarding,
//     byte-exact accumulation;
//   · the attempt translator (streamOneOpenaiAttempt via _eventsForTesting) —
//     canonical block grammar, one-mint settlement, no-replay, malformed and
//     interruption laws (C01/C03/C04/C05).
//  C08/ pin the honest-waiting + one-grammar dispositions at their owners;
//  §7.3 ties each route's advertisement to the mechanism proven here.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-cgrammar-home-'))

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

async function main(): Promise<void> {
  const wire = await import('../../src/services/providers/openai/openaiWire.js')
  const callModel = await import('../../src/services/providers/openai/openaiCallModel.js')
  type WireEvent = import('../../src/services/providers/openai/openaiWire.js').OpenaiStreamEvent

  // ── C01/C02/ · the fold: identity → prompt forwarding → byte truth ─────
  section('C01/C02/C07 — the fold forwards identified argument deltas promptly, byte-exactly')
  {
    const fold = new wire.ResponsesStreamFold()
    const added = fold.fold({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'EchoTool', arguments: '' },
    })
    // Hostile chunking: split inside a \uXXXX textual escape AND between the
    // surrogate-ish pieces of multibyte text — the deltas must join byte-exact.
    const argPieces = ['{"text":"caf\\u00', 'e9 \\"π\\" ', '✓"}']
    const forwarded: string[] = []
    let sameCallForwarding = true
    for (const piece of argPieces) {
      const out = fold.fold({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: piece })
      const deltas = out.filter(e => e.type === 'tool-args-delta')
      if (deltas.length !== 1 || (deltas[0] as { delta: string }).delta !== piece) sameCallForwarding = false
      forwarded.push(...deltas.map(e => (e as { delta: string }).delta))
    }
    // The done item arrives ARGUMENT-LESS — the fold
    // settles from the joined deltas and closes the live stream.
    const done = fold.fold({
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'EchoTool' },
    })
    const start = added.find(e => e.type === 'tool-args-start') as
      | { itemId: string; callId: string; name: string }
      | undefined
    const doneEvt = done.find(e => e.type === 'tool-args-done') as { argsRaw: string } | undefined
    const exact = argPieces.join('')
    check(
      'C01: added → delta ×n → done emits tool-args-start / tool-args-delta / tool-args-done with stable identity',
      start?.itemId === 'fc_1' && start?.callId === 'call_1' && start?.name === 'EchoTool' && doneEvt !== undefined,
      `start=${JSON.stringify(start)} done=${doneEvt !== undefined}`,
    )
    check(
      'C07: every delta forwards on the SAME fold() call that ingested it (zero buffering)',
      sameCallForwarding && forwarded.join('') === exact,
    )
    check(
      'C02: escaped JSON + multibyte text reconstruct byte-exactly through hostile chunk boundaries',
      doneEvt?.argsRaw === exact &&
        JSON.parse(doneEvt?.argsRaw ?? '{}').text === 'café "π" ✓',
      `argsRaw=${JSON.stringify(doneEvt?.argsRaw)}`,
    )
  }

  // ── · forwarding overhead p95 ≤100ms (deterministic probe) ────────────
  section('C07 — provider-event → canonical-event forwarding p95 ≤ 100ms')
  {
    const fold = new wire.ResponsesStreamFold()
    fold.fold({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_p', call_id: 'call_p', name: 'ProbeTool', arguments: '' },
    })
    const durations: number[] = []
    let forwardedCount = 0
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now()
      const out = fold.fold({ type: 'response.function_call_arguments.delta', item_id: 'fc_p', delta: `{"i":${i}}` })
      durations.push(performance.now() - t0)
      forwardedCount += out.filter(e => e.type === 'tool-args-delta').length
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95)]!
    check(
      'C07: 500-delta probe — every event forwarded, p95 fold latency ≤ 100ms',
      forwardedCount === 500 && p95 <= 100,
      `forwarded=${forwardedCount}/500 p95=${p95.toFixed(3)}ms`,
    )
  }

  // ── the attempt translator (seam-driven, no network) ──────────────────────
  // The session catalog the translator validates settled calls against
  // (the transport-boundary gate): a call to a tool outside it, or with
  // arguments outside its schema, never mints.
  const catalog = [
    { name: 'EchoTool', inputSchema: z.object({ text: z.string() }), prompt: async () => 'echo' },
    { name: 'ReadTool', inputSchema: z.object({ path: z.string() }), prompt: async () => 'read' },
  ] as never
  const mkFinish = (calls: Array<Record<string, unknown>>): WireEvent =>
    ({
      type: 'finish',
      reason: 'tool_calls',
      toolCalls: calls,
      reasoningItems: [],
      orderedItems: calls
        .filter(c => !c.malformed)
        .map(c => ({
          type: 'function_call',
          call_id: c.callId,
          name: c.name,
          arguments: c.argumentsRaw,
          id: c.itemId,
        })),
      finalText: '',
      refusalText: '',
      unknownItemTypes: [],
    }) as never

  const drain = async (
    events: WireEvent[],
    opts: { abortAfter?: number } = {},
  ): Promise<{
    streamEvents: Array<Record<string, unknown>>
    mintedContent: Array<Record<string, unknown>>
    outcome: { kind: string }
  }> => {
    const ac = new AbortController()
    let emitted = 0
    const source = (async function* () {
      for (const e of events) {
        if (opts.abortAfter !== undefined && emitted >= opts.abortAfter) {
          ac.abort()
          return
        }
        emitted++
        yield e
      }
    })()
    const gen = callModel.streamOneOpenaiAttempt({
      _eventsForTesting: source,
      request: { model: 'gpt-test', input: [], stream: true } as never,
      auth: {
        baseUrl: 'https://unused.invalid',
        headers: {},
        account: { kind: 'test-key', label: 'test source' },
      } as never,
      signal: ac.signal,
      tools: catalog,
      options: { querySource: 'sdk' } as never,
      modelId: 'gpt-test',
      messages: [] as never,
      settlementNotes: [] as never,
      pulseMain: false,
      pulseGeneration: 0,
      contractDigest: 'prover-digest',
    })
    const streamEvents: Array<Record<string, unknown>> = []
    const mintedContent: Array<Record<string, unknown>> = []
    let outcome: { kind: string } = { kind: 'unknown' }
    while (true) {
      const r = await gen.next()
      if (r.done) {
        outcome = (r.value ?? { kind: 'unknown' }) as { kind: string }
        break
      }
      const v = r.value as Record<string, unknown>
      if (v.type === 'stream_event') {
        streamEvents.push(v.event as Record<string, unknown>)
      } else if (v.type === 'assistant') {
        const msg = v.message as { content: Array<Record<string, unknown>> }
        for (const block of msg.content) mintedContent.push(block)
      }
    }
    return { streamEvents, mintedContent, outcome }
  }

  const toolStarts = (evs: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    evs.filter(
      e =>
        e.type === 'content_block_start' &&
        (e.content_block as Record<string, unknown> | undefined)?.type === 'tool_use',
    )
  const argBytes = (evs: Array<Record<string, unknown>>): string =>
    evs
      .filter(
        e =>
          e.type === 'content_block_delta' &&
          (e.delta as Record<string, unknown> | undefined)?.type === 'input_json_delta',
      )
      .map(e => (e.delta as { partial_json: string }).partial_json)
      .join('')

  section('C01/C04 — live deltas paint once; settlement mints ONE tool_use without replay')
  {
    const raw = '{"text":"four"}'
    const call = {
      callId: 'call_live',
      itemId: 'fc_live',
      name: 'EchoTool',
      argumentsRaw: raw,
      arguments: { text: 'four' },
      malformed: false,
    }
    const { streamEvents, mintedContent, outcome } = await drain([
      { type: 'response-id', id: 'resp_1' } as never,
      { type: 'tool-args-start', itemId: 'fc_live', callId: 'call_live', name: 'EchoTool' },
      { type: 'tool-args-delta', itemId: 'fc_live', delta: '{"text":' },
      { type: 'tool-args-delta', itemId: 'fc_live', delta: '"four"}' },
      { type: 'tool-args-done', itemId: 'fc_live', argsRaw: raw },
      mkFinish([call]),
    ])
    const starts = toolStarts(streamEvents)
    const startIdx = streamEvents.findIndex(e => e === starts[0])
    const stopIdx = streamEvents.findIndex(
      (e, i) => i > startIdx && e.type === 'content_block_stop',
    )
    const deltasAfterStop = streamEvents
      .slice(stopIdx + 1)
      .some(e => (e.delta as Record<string, unknown> | undefined)?.type === 'input_json_delta')
    const toolMints = mintedContent.filter(b => b.type === 'tool_use')
    check(
      'C01: the canonical grammar — ONE tool_use content_block_start (id+name) → input_json_delta bytes → content_block_stop',
      starts.length === 1 &&
        (starts[0]!.content_block as { id: string; name: string }).id === 'call_live' &&
        (starts[0]!.content_block as { id: string; name: string }).name === 'EchoTool' &&
        argBytes(streamEvents) === raw &&
        stopIdx > startIdx,
      `starts=${starts.length} bytes=${JSON.stringify(argBytes(streamEvents))}`,
    )
    check(
      'C04: settlement mints exactly ONE tool_use and replays NOTHING (painted bytes == argument bytes, none after stop)',
      toolMints.length === 1 &&
        JSON.stringify(toolMints[0]!.input) === JSON.stringify({ text: 'four' }) &&
        !deltasAfterStop &&
        outcome.kind === 'done',
      `mints=${toolMints.length} afterStop=${deltasAfterStop} outcome=${outcome.kind}`,
    )
    const stopReasonEvt = streamEvents.find(e => e.type === 'message_delta') as
      | { delta: { stop_reason: string } }
      | undefined
    check(
      'C01: the settled turn carries stop_reason tool_use through the canonical message_delta/message_stop tail',
      stopReasonEvt?.delta.stop_reason === 'tool_use' &&
        streamEvents.at(-1)?.type === 'message_stop',
    )
  }

  section('C04/C08 — done-carried arguments paint exactly once at close (no invented bytes while waiting)')
  {
    const raw = '{"path":"/tmp/x"}'
    const call = {
      callId: 'call_done',
      itemId: 'fc_done',
      name: 'ReadTool',
      argumentsRaw: raw,
      arguments: { path: '/tmp/x' },
      malformed: false,
    }
    const { streamEvents, mintedContent } = await drain([
      { type: 'tool-args-start', itemId: 'fc_done', callId: 'call_done', name: 'ReadTool' },
      { type: 'tool-args-done', itemId: 'fc_done', argsRaw: raw },
      mkFinish([call]),
    ])
    const deltas = streamEvents.filter(
      e => (e.delta as Record<string, unknown> | undefined)?.type === 'input_json_delta',
    )
    const startIdx = streamEvents.findIndex(e => toolStarts([e]).length === 1)
    check(
      'C04: a no-delta stream paints its settled bytes EXACTLY once at close — never twice, never before the provider settled them',
      deltas.length === 1 &&
        argBytes(streamEvents) === raw &&
        streamEvents.findIndex(e => e === deltas[0]) > startIdx &&
        mintedContent.filter(b => b.type === 'tool_use').length === 1,
      `deltas=${deltas.length}`,
    )
  }

  section('C03/C05 — malformed terminal arguments: typed note, ZERO tool_use mints')
  {
    const bad = '{"text": four'
    const call = {
      callId: 'call_bad',
      itemId: 'fc_bad',
      name: 'EchoTool',
      argumentsRaw: bad,
      malformed: true,
    }
    const { mintedContent, outcome } = await drain([
      { type: 'tool-args-start', itemId: 'fc_bad', callId: 'call_bad', name: 'EchoTool' },
      { type: 'tool-args-delta', itemId: 'fc_bad', delta: bad },
      { type: 'tool-args-done', itemId: 'fc_bad', argsRaw: bad },
      mkFinish([call]),
    ])
    const toolMints = mintedContent.filter(b => b.type === 'tool_use')
    const note = mintedContent.find(
      b => b.type === 'text' && String(b.text).includes('malformed'),
    )
    check(
      'C05: malformed settles as ONE typed adapter note and executes zero tools (no tool_use mint; partial JSON never parsed into an input)',
      toolMints.length === 0 && note !== undefined && outcome.kind === 'done',
      `mints=${toolMints.length} note=${note !== undefined}`,
    )
  }

  section('C06 — interruption mid-arguments: settles once as cancelled, no stale execution')
  {
    const { mintedContent, outcome, streamEvents } = await drain(
      [
        { type: 'tool-args-start', itemId: 'fc_int', callId: 'call_int', name: 'EchoTool' },
        { type: 'tool-args-delta', itemId: 'fc_int', delta: '{"text":' },
        { type: 'tool-args-delta', itemId: 'fc_int', delta: '"never"}' },
        mkFinish([]),
      ],
      { abortAfter: 2 },
    )
    check(
      'C06: abort mid-arguments ⇒ outcome cancelled, zero tool_use mints, no terminal settlement events',
      outcome.kind === 'cancelled' &&
        mintedContent.filter(b => b.type === 'tool_use').length === 0 &&
        !streamEvents.some(e => e.type === 'message_stop'),
      `outcome=${outcome.kind}`,
    )
  }

  section('C09 — text, reasoning and tool streams keep their true order')
  {
    const raw = '{"text":"last"}'
    const call = {
      callId: 'call_ord',
      itemId: 'fc_ord',
      name: 'EchoTool',
      argumentsRaw: raw,
      arguments: { text: 'last' },
      malformed: false,
    }
    const { streamEvents, mintedContent } = await drain([
      { type: 'reasoning-delta', text: 'thinking first' },
      { type: 'text-delta', text: 'answer second' },
      { type: 'tool-args-start', itemId: 'fc_ord', callId: 'call_ord', name: 'EchoTool' },
      { type: 'tool-args-delta', itemId: 'fc_ord', delta: raw },
      { type: 'tool-args-done', itemId: 'fc_ord', argsRaw: raw },
      mkFinish([call]),
    ])
    const startKinds = streamEvents
      .filter(e => e.type === 'content_block_start')
      .map(e => (e.content_block as { type: string }).type)
    const mintKinds = mintedContent.map(b => b.type)
    check(
      'C09: block stream order thinking → text → tool_use matches arrival; minted transcript order agrees',
      JSON.stringify(startKinds) === JSON.stringify(['thinking', 'text', 'tool_use']) &&
        JSON.stringify(mintKinds) === JSON.stringify(['thinking', 'text', 'tool_use']),
      `stream=${startKinds.join(',')} minted=${mintKinds.join(',')}`,
    )
  }

  // ── C08/ dispositions + §7.3 advertisement ─────────────────────────────
  section('C08/C10 — honest waiting + ONE canonical grammar; §7.3 advertisement backed by mechanism')
  {
    const streaming = src('src/utils/messages/streaming.ts')
    const callModelSrc = src('src/services/providers/openai/openaiCallModel.ts')
    check(
      'C10: the SHARED canonical consumer serves the openai lane (input_json_delta → pulse activity + silent tool-input accumulation) — no second grammar',
      streaming.includes("case 'input_json_delta'") &&
        streaming.includes("'tool-input'") &&
        callModelSrc.includes("type: 'input_json_delta'") &&
        !callModelSrc.includes('openai_tool_delta'),
    )
    check(
      'C08: stream-activity marks ride REAL provider events only (first-chunk mark in the lane; per-delta marks in the shared consumer) — no timer-invented bytes',
      callModelSrc.includes("notePulseStreamActivity(ctx.pulseGeneration, 'chunk')") &&
        streaming.includes('notePulseStreamActivity(') &&
        !callModelSrc.includes('setInterval'),
    )
    check(
      '§7.3: the openai route advertises toolArgsDelta and the mechanism exists in the SAME codec (fold emits tool-args-delta)',
      wire.OPENAI_STREAM_ADVERTISEMENT.toolArgsDelta === true &&
        src('src/services/providers/openai/openaiWire.ts').includes("out.push({ type: 'tool-args-delta'"),
    )
    const streamCoreSrc = src('src/services/providers/anthropic/streamCore.ts')
    check(
      '§7.3: the anthropic route declares its native advertisement at its codec owner',
      streamCoreSrc.includes('ANTHROPIC_STREAM_ADVERTISEMENT'),
    )
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log('')
  let red = 0
  for (const leg of legs) {
    const mark = leg.pass ? '[PASS]' : '[FAIL]'
    if (!leg.pass) red++
    console.log(`  ${mark} ${leg.label}${leg.detail && !leg.pass ? ` — ${leg.detail}` : ''}`)
  }
  console.log(
    `\n${legs.length} legs: ${legs.length - red} green, ${red} red — 3.5.1 C-grammar ${red === 0 ? 'HOLDS' : 'BROKEN'}`,
  )
  if (red > 0) process.exit(1)
}

await main()
