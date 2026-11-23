#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
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

async function main(): Promise<void> {
  const wire = await import('../../src/models/roads/openai/openaiWire.js')
  const callModel = await import('../../src/models/roads/openai/openaiCallModel.js')
  type WireEvent = import('../../src/models/roads/openai/openaiWire.js').OpenaiStreamEvent

  section('C01/C02/C07 — the fold forwards identified argument deltas promptly, byte-exactly')
  {
    const fold = new wire.ResponsesStreamFold()
    const added = fold.fold({
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'EchoTool', arguments: '' },
    })
    const argPieces = ['{"text":"caf\\u00', 'e9 \\"π\\" ', '✓"}']
    const forwarded: string[] = []
    let sameCallForwarding = true
    for (const piece of argPieces) {
      const out = fold.fold({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: piece })
      const deltas = out.filter(e => e.type === 'tool-args-delta')
      if (deltas.length !== 1 || (deltas[0] as { delta: string }).delta !== piece) sameCallForwarding = false
      forwarded.push(...deltas.map(e => (e as { delta: string }).delta))
    }
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
      `start=${JSON.stringify(start)} done=${doneEvt !== undefined}; change ResponsesStreamFold.fold in src/models/roads/openai/openaiWire.ts so function_call added/delta/done emit tool-args-start/delta/done with the same itemId, callId and name`,
    )
    check(
      'C07: every delta forwards on the SAME fold() call that ingested it (zero buffering)',
      sameCallForwarding && forwarded.join('') === exact,
      `forwarded=${JSON.stringify(forwarded.join(''))}; change ResponsesStreamFold.fold in src/models/roads/openai/openaiWire.ts to return one tool-args-delta per function_call_arguments.delta event, unbuffered`,
    )
    check(
      'C02: escaped JSON + multibyte text reconstruct byte-exactly through hostile chunk boundaries',
      doneEvt?.argsRaw === exact &&
        JSON.parse(doneEvt?.argsRaw ?? '{}').text === 'café "π" ✓',
      `argsRaw=${JSON.stringify(doneEvt?.argsRaw)}; change ResponsesStreamFold.fold in src/models/roads/openai/openaiWire.ts so tool-args-done argsRaw is the exact concatenation of the delta strings`,
    )
  }

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
      `forwarded=${forwardedCount}/500 p95=${p95.toFixed(3)}ms; check the function_call_arguments.delta path of ResponsesStreamFold.fold in src/models/roads/openai/openaiWire.ts for dropped events or per-delta work`,
    )
  }

  const { assertRefusedCallResult } = await import('../providers/lib/refused-call-result.ts')
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
    mintedMessages: import('../../src/engine/message-shapes/message.ts').AssistantMessage[]
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
      contractDigest: 'prover-digest',
    })
    const streamEvents: Array<Record<string, unknown>> = []
    const mintedContent: Array<Record<string, unknown>> = []
    const mintedMessages: import('../../src/engine/message-shapes/message.ts').AssistantMessage[] = []
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
        mintedMessages.push(v as unknown as import('../../src/engine/message-shapes/message.ts').AssistantMessage)
        const msg = v.message as { content: Array<Record<string, unknown>> }
        for (const block of msg.content) mintedContent.push(block)
      }
    }
    return { streamEvents, mintedContent, mintedMessages, outcome }
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
      `starts=${starts.length} bytes=${JSON.stringify(argBytes(streamEvents))}; change the tool-args-start/delta/done cases in src/models/roads/openai/call-model/attempt.ts to emit one tool_use content_block_start, the input_json_delta bytes, then content_block_stop`,
    )
    check(
      'C04: settlement mints exactly ONE tool_use and replays NOTHING (painted bytes == argument bytes, none after stop)',
      toolMints.length === 1 &&
        JSON.stringify(toolMints[0]!.input) === JSON.stringify({ text: 'four' }) &&
        !deltasAfterStop &&
        outcome.kind === 'done',
      `mints=${toolMints.length} afterStop=${deltasAfterStop} outcome=${outcome.kind}; change the finish settlement in src/models/roads/openai/call-model/attempt.ts so it mints one tool_use and does not repeat bytes already painted`,
    )
    const stopReasonEvt = streamEvents.find(e => e.type === 'message_delta') as
      | { delta: { stop_reason: string } }
      | undefined
    check(
      'C01: the settled turn carries stop_reason tool_use through the canonical message_delta/message_stop tail',
      stopReasonEvt?.delta.stop_reason === 'tool_use' &&
        streamEvents.at(-1)?.type === 'message_stop',
      `stop_reason=${stopReasonEvt?.delta.stop_reason} last=${String(streamEvents.at(-1)?.type)}; change the finish settlement in src/models/roads/openai/call-model/attempt.ts to end with message_delta stop_reason tool_use then message_stop`,
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
      `deltas=${deltas.length}; change the tool-args-done case in src/models/roads/openai/call-model/attempt.ts to paint argsRaw once at close when no delta arrived`,
    )
  }

  section('C03/C05 — malformed terminal arguments: one refused call, one error result, no execution')
  {
    const bad = '{"text": four'
    const call = {
      callId: 'call_bad',
      itemId: 'fc_bad',
      name: 'EchoTool',
      argumentsRaw: bad,
      malformed: true,
    }
    const { mintedContent, mintedMessages, outcome } = await drain([
      { type: 'tool-args-start', itemId: 'fc_bad', callId: 'call_bad', name: 'EchoTool' },
      { type: 'tool-args-delta', itemId: 'fc_bad', delta: bad },
      { type: 'tool-args-done', itemId: 'fc_bad', argsRaw: bad },
      mkFinish([call]),
    ])
    const toolMints = mintedContent.filter(b => b.type === 'tool_use')
    check(
      'C05: malformed settles as one call carrying its raw refusal and receives one error result without executing',
      toolMints.length === 1 && outcome.kind === 'done' && await assertRefusedCallResult(mintedMessages, { id: 'call_bad', name: 'EchoTool', raw: bad }),
      `mints=${toolMints.length}; change the malformed-argument settlement in src/models/roads/openai/call-model/attempt.ts to mint one tool_use carrying the raw text and one error result`,
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
      `outcome=${outcome.kind}; change the abort handling in streamOneOpenaiAttempt (src/models/roads/openai/call-model/attempt.ts) to return cancelled with no tool_use mint and no message_stop`,
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
      `stream=${startKinds.join(',')} minted=${mintKinds.join(',')}; change block ordering in src/models/roads/openai/call-model/attempt.ts so thinking, text and tool_use keep arrival order`,
    )
  }


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
