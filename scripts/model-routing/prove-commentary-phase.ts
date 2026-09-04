#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'commentary-phase-'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(join(import.meta.dir, '..', '..'))

const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.ts')
const { buildOpenaiResponsesRequest, decodeOpenaiTurnRecord, mapMessagesToOpenaiInput } = await import(
  '../../src/services/providers/openai/responsesBridge.ts'
)
const { streamOneOpenaiAttempt } = await import('../../src/services/providers/openai/openaiCallModel.ts')
import type { OpenaiStreamEvent } from '../../src/services/providers/openai/openaiWire.ts'
import type { BridgeMessage } from '../../src/services/providers/openai/responsesBridge.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Responses message phase — fold · runtime · replay (pure)')
console.log('============================================================')

function foldAll(payloads: unknown[]): OpenaiStreamEvent[] {
  const fold = new ResponsesStreamFold()
  const out: OpenaiStreamEvent[] = []
  for (const p of payloads) out.push(...fold.fold(p))
  return out
}
const openedMessage = (id: string, phase?: unknown): Record<string, unknown> => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'in_progress',
  content: [],
  ...(phase !== undefined ? { phase } : {}),
})
const doneMessage = (id: string, text: string, phase?: unknown): Record<string, unknown> => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
  ...(phase !== undefined ? { phase } : {}),
})
const finishOf = (events: OpenaiStreamEvent[]): Extract<OpenaiStreamEvent, { type: 'finish' }> => {
  const finish = events.find(e => e.type === 'finish')
  if (finish?.type !== 'finish') throw new Error('no finish event')
  return finish
}
const typeList = (events: OpenaiStreamEvent[]): string[] => events.map(e => e.type)

section('1 · the fold — the register rides the item events and the replay record')
{
  const events = foldAll([
    { type: 'response.created', response: { id: 'resp_p1' } },
    { type: 'response.output_item.added', output_index: 0, item: openedMessage('msg_1', 'commentary') },
    { type: 'response.content_part.added', item_id: 'msg_1', part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Checking ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'the sum.' },
    { type: 'response.output_text.done', item_id: 'msg_1', text: 'Checking the sum.' },
    { type: 'response.output_item.done', output_index: 0, item: doneMessage('msg_1', 'Checking the sum.', 'commentary') },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'EchoTool', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"text":"four"}' },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}' },
    },
    { type: 'response.completed', response: { id: 'resp_p1', usage: { input_tokens: 10, output_tokens: 5 } } },
  ])
  const types = typeList(events)
  const start = events.filter(e => e.type === 'text-item-start')
  const done = events.filter(e => e.type === 'text-item-done')
  check('ONE text-item-start, carrying the register', start.length === 1 && start[0]?.type === 'text-item-start' && start[0].phase === 'commentary')
  check('ONE text-item-done, carrying the register', done.length === 1 && done[0]?.type === 'text-item-done' && done[0].phase === 'commentary')
  check(
    'order: item start → deltas → item done → the tool call opens',
    types.indexOf('text-item-start') < types.indexOf('text-delta') &&
      types.lastIndexOf('text-delta') < types.indexOf('text-item-done') &&
      types.indexOf('text-item-done') < types.indexOf('tool-args-start'),
    types.join(','),
  )
  check('the deltas still stream (2), the settled text is whole', events.filter(e => e.type === 'text-delta').length === 2 && finishOf(events).finalText === 'Checking the sum.')
  const finish = finishOf(events)
  const message = finish.orderedItems[0]
  check(
    'the replay record’s message item carries phase commentary, content intact',
    message?.type === 'message' && message.phase === 'commentary' && message.content[0]?.type === 'output_text' && message.content[0].text === 'Checking the sum.',
    JSON.stringify(message),
  )
  check('the record order is message → function_call (unchanged)', JSON.stringify(finish.orderedItems.map(i => i.type)) === JSON.stringify(['message', 'function_call']))
  check('no unknown item type was recorded (a register is a field, not a kind)', finish.unknownItemTypes.length === 0)

  const answer = foldAll([
    { type: 'response.output_item.added', output_index: 0, item: openedMessage('msg_2', 'final_answer') },
    { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'The answer is 4.' },
    { type: 'response.output_item.done', output_index: 0, item: doneMessage('msg_2', 'The answer is 4.', 'final_answer') },
    { type: 'response.completed', response: {} },
  ])
  const answerStart = answer.find(e => e.type === 'text-item-start')
  check('final_answer rides the item events too', answerStart?.type === 'text-item-start' && answerStart.phase === 'final_answer')
  check('…and the replay item', finishOf(answer).orderedItems[0]?.type === 'message' && finishOf(answer).orderedItems[0]?.phase === 'final_answer')

  const plain = foldAll([
    { type: 'response.output_item.added', output_index: 0, item: openedMessage('msg_3') },
    { type: 'response.output_text.delta', item_id: 'msg_3', delta: 'Plain.' },
    { type: 'response.output_item.done', output_index: 0, item: doneMessage('msg_3', 'Plain.') },
    { type: 'response.completed', response: {} },
  ])
  const plainStart = plain.find(e => e.type === 'text-item-start')
  const plainDone = plain.find(e => e.type === 'text-item-done')
  check('an unlabelled item: item events WITHOUT a phase key', plainStart !== undefined && !('phase' in plainStart) && plainDone !== undefined && !('phase' in plainDone))
  check(
    'an unlabelled item: the replay item is the exact prior shape (no phase key)',
    JSON.stringify(finishOf(plain).orderedItems[0]) === JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plain.' }] }),
    JSON.stringify(finishOf(plain).orderedItems[0]),
  )

  for (const [label, word] of [
    ['phase null', null],
    ['an unknown register word', 'analysis'],
  ] as const) {
    const odd = foldAll([
      { type: 'response.output_item.added', output_index: 0, item: openedMessage('msg_4', word) },
      { type: 'response.output_text.delta', item_id: 'msg_4', delta: 'Odd.' },
      { type: 'response.output_item.done', output_index: 0, item: doneMessage('msg_4', 'Odd.', word) },
      { type: 'response.completed', response: {} },
    ])
    const s = odd.find(e => e.type === 'text-item-start')
    const item = finishOf(odd).orderedItems[0]
    check(`${label}: treated as absent (no key on the events or the replay item), text intact`, s !== undefined && !('phase' in s) && item?.type === 'message' && !('phase' in item) && finishOf(odd).finalText === 'Odd.')
  }

  const carried = foldAll([
    { type: 'response.output_item.added', output_index: 0, item: openedMessage('msg_5', 'commentary') },
    { type: 'response.output_item.done', output_index: 0, item: doneMessage('msg_5', 'Carried whole.', 'commentary') },
    { type: 'response.completed', response: {} },
  ])
  const carriedTypes = typeList(carried)
  check(
    'a delta-less item: exactly one carried text-delta, then the item done',
    carried.filter(e => e.type === 'text-delta').length === 1 &&
      carriedTypes.indexOf('text-delta') < carriedTypes.indexOf('text-item-done') &&
      finishOf(carried).finalText === 'Carried whole.',
    carriedTypes.join(','),
  )
}

section('2 · the runtime — one message item mints one text block, labelled')
type Minted = { text: string; phase?: string; hasKey: boolean }
type StartBlock = { phase?: string; hasKey: boolean }
async function mint(events: Array<Record<string, unknown>>): Promise<{ blocks: Minted[]; starts: StartBlock[] }> {
  const source = (async function* () {
    for (const e of events) yield e
  })() as never
  const gen = streamOneOpenaiAttempt({
    _eventsForTesting: source,
    request: { model: 'gpt-test', input: [], stream: true } as never,
    auth: {
      baseUrl: 'https://unused.invalid',
      headers: {},
      account: { kind: 'test-key', label: 'test source' },
    } as never,
    signal: new AbortController().signal,
    tools: [] as never,
    options: { querySource: 'sdk' } as never,
    modelId: 'gpt-test',
    messages: [] as never,
    settlementNotes: [] as never,
    pulseMain: false,
    pulseGeneration: 0,
    contractDigest: 'prover-digest',
  })
  const blocks: Minted[] = []
  const starts: StartBlock[] = []
  let r = await gen.next()
  while (!r.done) {
    const v = r.value as { type: string; message?: { content?: Array<Record<string, unknown>> }; event?: Record<string, unknown> }
    if (v.type === 'assistant') {
      for (const b of v.message?.content ?? []) {
        if (b.type === 'text') blocks.push({ text: String(b.text), hasKey: 'phase' in b, ...(typeof b.phase === 'string' ? { phase: b.phase } : {}) })
      }
    }
    if (v.type === 'stream_event' && v.event?.type === 'content_block_start') {
      const block = v.event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'text') starts.push({ hasKey: 'phase' in block, ...(typeof block.phase === 'string' ? { phase: block.phase } : {}) })
    }
    r = await gen.next()
  }
  return { blocks, starts }
}
const finishEvent = (finalText: string): Record<string, unknown> => ({
  type: 'finish',
  reason: 'completed',
  toolCalls: [],
  reasoningItems: [],
  orderedItems: [],
  finalText,
  refusalText: '',
  unknownItemTypes: [],
  webSearchCalls: [],
  citations: [],
})
{
  const two = await mint([
    { type: 'text-item-start', phase: 'commentary' },
    { type: 'text-delta', text: 'Working ' },
    { type: 'text-delta', text: 'note.' },
    { type: 'text-item-done', phase: 'commentary' },
    { type: 'text-item-start', phase: 'final_answer' },
    { type: 'text-delta', text: 'The answer.' },
    { type: 'text-item-done', phase: 'final_answer' },
    finishEvent('Working note.The answer.'),
  ])
  check(
    'two message items mint TWO text blocks, each with its own register',
    two.blocks.length === 2 &&
      two.blocks[0]!.text === 'Working note.' &&
      two.blocks[0]!.phase === 'commentary' &&
      two.blocks[1]!.text === 'The answer.' &&
      two.blocks[1]!.phase === 'final_answer',
    JSON.stringify(two.blocks),
  )
  check(
    'the streaming grammar’s content_block_start carries the register (live paint can read it)',
    two.starts.length === 2 && two.starts[0]!.phase === 'commentary' && two.starts[1]!.phase === 'final_answer',
    JSON.stringify(two.starts),
  )

  const late = await mint([
    { type: 'text-item-start' },
    { type: 'text-delta', text: 'Late label.' },
    { type: 'text-item-done', phase: 'commentary' },
    finishEvent('Late label.'),
  ])
  check('a register stated on the done item alone still lands on the block', late.blocks.length === 1 && late.blocks[0]!.phase === 'commentary', JSON.stringify(late.blocks))

  const plain = await mint([{ type: 'text-delta', text: 'Plain.' }, finishEvent('Plain.')])
  check('the item-less shape (every earlier fixture) mints ONE block with NO phase key', plain.blocks.length === 1 && plain.blocks[0]!.text === 'Plain.' && !plain.blocks[0]!.hasKey, JSON.stringify(plain.blocks))
  check('…and its content_block_start carries no phase key', plain.starts.length === 1 && !plain.starts[0]!.hasKey)

  const boundary = await mint([
    { type: 'text-item-start' },
    { type: 'text-delta', text: 'First item.' },
    { type: 'text-item-done' },
    { type: 'text-item-start' },
    { type: 'text-delta', text: 'Second item.' },
    { type: 'text-item-done' },
    finishEvent('First item.Second item.'),
  ])
  check(
    'two unlabelled items are still two blocks (the item is the boundary), neither with a phase key',
    boundary.blocks.length === 2 && boundary.blocks[0]!.text === 'First item.' && boundary.blocks[1]!.text === 'Second item.' && boundary.blocks.every(b => !b.hasKey),
    JSON.stringify(boundary.blocks),
  )
}

section('3 · the bridge — verbatim replay · derived items per register · a phase-less history unchanged')
{
  const record = decodeOpenaiTurnRecord({
    provider: 'openai',
    responseId: 'resp_p1',
    items: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the sum.' }], phase: 'commentary' },
      { type: 'function_call', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}', id: 'fc_1' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Odd word.' }], phase: 'analysis' },
    ],
  })
  check('decode keeps phase commentary on the recorded message item', record?.items[0]?.type === 'message' && record.items[0].phase === 'commentary')
  check('decode drops a foreign register word (no key), content intact', record?.items[2]?.type === 'message' && !('phase' in record.items[2]) && record.items[2].content[0]?.text === 'Odd word.')

  const recorded: BridgeMessage[] = [
    { role: 'user', content: 'add 2+2' },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking the sum.', phase: 'commentary' }], turnId: 't1' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'EchoTool', input: { text: 'four' } }],
      turnId: 't1',
      turnRecord: record!,
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'four' }] },
  ]
  const replayed = mapMessagesToOpenaiInput(recorded)
  check(
    'a recorded turn replays the labelled message item VERBATIM (phase after content, as decoded)',
    JSON.stringify(replayed[1]) === JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the sum.' }], phase: 'commentary' }),
    JSON.stringify(replayed[1]),
  )

  const derived = mapMessagesToOpenaiInput([
    { role: 'user', content: 'add 2+2' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking the sum.', phase: 'commentary' },
        { type: 'tool_use', id: 'call_1', name: 'EchoTool', input: { text: 'four' } },
      ],
      turnId: 'gpt_a',
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'four' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.', phase: 'final_answer' }], turnId: 'gpt_b' },
  ])
  const derivedShape = derived.map(i => (i.type === 'message' ? `message:${i.role}${'phase' in i && i.phase ? `:${i.phase}` : ''}` : i.type))
  check(
    'a recordless turn derives labelled message items in true positions',
    JSON.stringify(derivedShape) === JSON.stringify(['message:user', 'message:assistant:commentary', 'function_call', 'function_call_output', 'message:assistant:final_answer']),
    derivedShape.join(','),
  )

  const runs = mapMessagesToOpenaiInput([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'One.', phase: 'commentary' },
        { type: 'text', text: 'Two.', phase: 'commentary' },
        { type: 'text', text: 'Three.', phase: 'final_answer' },
        { type: 'text', text: 'Four.' },
      ],
      turnId: 'runs',
    },
  ])
  check(
    'consecutive equally-labelled blocks group into ONE item; a register change or an unlabelled block starts another',
    runs.length === 3 &&
      runs[0]?.type === 'message' && runs[0].phase === 'commentary' && runs[0].content.length === 2 &&
      runs[1]?.type === 'message' && runs[1].phase === 'final_answer' && runs[1].content.length === 1 &&
      runs[2]?.type === 'message' && !('phase' in runs[2]) && runs[2].content.length === 1,
    JSON.stringify(runs),
  )

  const frozenHistory: BridgeMessage[] = [
    { role: 'user', content: 'add 2+2' },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking the sum.' }], turnId: 't1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'EchoTool', input: { text: 'four' } }], turnId: 't1' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'four' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }], turnId: 't2' },
  ]
  const expectedInput = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add 2+2' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the sum.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'four' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] },
  ]
  check(
    'a phase-less history maps to the SAME items (the pre-tool text replays exactly as before)',
    JSON.stringify(mapMessagesToOpenaiInput(frozenHistory)) === JSON.stringify(expectedInput),
    JSON.stringify(mapMessagesToOpenaiInput(frozenHistory)),
  )
  const request = buildOpenaiResponsesRequest({
    model: 'gpt-5.6-sol',
    instructions: 'You are a specialist.',
    messages: frozenHistory,
    tools: [{ name: 'EchoTool', input_schema: { type: 'object' } }],
    reasoningEffort: 'high',
    promptCacheKey: 'mercury:s:main',
  })
  const expectedRequest = {
    model: 'gpt-5.6-sol',
    instructions: 'You are a specialist.',
    input: expectedInput,
    tools: [{ type: 'function', name: 'EchoTool', parameters: { type: 'object' } }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'high', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'mercury:s:main',
  }
  check(
    'the request Mercury sends after the tool result is byte-identical for that history (frozen)',
    JSON.stringify(request) === JSON.stringify(expectedRequest),
    JSON.stringify(request),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL COMMENTARY-PHASE PROOFS PASS')
else console.log(`${failures} COMMENTARY-PHASE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
