#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'flow-dead-turn-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'flow-dead-turn-daemon-'))
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_TIME_BASED_MC',
  'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage, createAssistantAPIErrorMessage } = await import(
  '../../src/engine/messages/messages.ts'
)
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { streamFaultAfterPartialText, STREAM_FAULT_RECOVERY_NUDGE } = await import(
  '../../src/engine/requests/apiErrorRows.ts'
)

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const loopHint = 'the run loop is query in src/engine/turnDoor.ts; the stream-fault words and recovery nudge come from src/engine/requests/apiErrorRows.ts'
const openaiStreamHint = 'see streamOneOpenaiAttempt in src/models/roads/openai/openaiCallModel.ts and ResponsesStreamFold in src/models/roads/openai/openaiWire.ts'
const healHint = 'see healWalkableForWire in src/engine/messages/wirePairing.ts'
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — flow dead-turn prover exceeded 120s')
  console.log('a section is still waiting; the last section header above names it. ' + loopHint + ' (a scripted model call that never ends keeps query waiting)')
  process.exit(1)
}, 120_000)
guard.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

function makeEchoTool(): never {
  return {
    name: 'EchoTool',
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => 'EchoTool',
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      return { data: `echo:${(input?.text as string) ?? ''}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

function makeBoomTool(): never {
  return {
    name: 'BoomTool',
    async description() {
      return 'rig tool that throws'
    },
    async prompt() {
      return 'rig tool that throws'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => 'BoomTool',
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      throw new Error(`rig exploded on ${(input?.text as string) ?? '?'}`)
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

function makeCtx(tools: unknown[]): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools,
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  return { ctx, abortController }
}

type CallRecord = { messages: unknown[] }
type Step = { kind: 'yield'; value: unknown }
const y = (value: unknown): Step => ({ kind: 'yield', value })

function makeModel(script: Step[][]): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s.value as never
  }
  return { calls, callModel }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

const textTurn = (text: string): unknown => {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return m
}
function toolTurn(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): unknown {
  const m = createAssistantMessage({
    content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) as never,
  })
  m.message.stop_reason = 'tool_use'
  return m
}
const partialThenFault = (partial: string): Step[] => [
  y(textTurn(partial)),
  y(
    createAssistantAPIErrorMessage({
      content: streamFaultAfterPartialText('OpenAI', 'http-500', 'fixture stream drop'),
    }),
  ),
]

async function run(
  script: Step[][],
  tools: unknown[] = [makeEchoTool()],
): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; terminal: Record<string, unknown> }> {
  const rig = makeCtx(tools)
  const { calls, callModel } = makeModel(script)
  const gen = turnDoor({
    messages: [createUserMessage({ content: 'flow: do the task' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, calls, terminal: r.value as Record<string, unknown> }
}

const userTexts = (msgs: unknown[]): string[] => {
  const out: string[] = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) {
      for (const b of c as AnyMsg[]) {
        if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text as string)
      }
    }
  }
  return out
}
const toolResults = (msgs: unknown[]): Array<{ id: string; isError: boolean; text: string }> => {
  const out: Array<{ id: string; isError: boolean; text: string }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as AnyMsg[]) {
      if (b?.type !== 'tool_result') continue
      const raw = (b as { content?: unknown }).content
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map(e => String((e as { text?: unknown }).text ?? '')).join('\n')
            : ''
      out.push({ id: String((b as { tool_use_id?: unknown }).tool_use_id ?? ''), isError: (b as { is_error?: boolean }).is_error === true, text })
    }
  }
  return out
}

section('S1 — the fault-recovery budget is per-episode: fault · tool round · fault BOTH recover')
{
  const r = await run([
    partialThenFault('first half of the answer'),
    [y(toolTurn([{ id: 'tu_mid', name: 'EchoTool', input: { text: 'progress' } }]))],
    partialThenFault('second stretch of work'),
    [y(textTurn('flow run finished'))],
  ])
  check(
    'four model calls — BOTH faults recovered (a completed tool round resets the episode)',
    r.calls.length === 4,
    `calls=${r.calls.length} (3 = the per-run budget died on the second fault: the incident) — ${loopHint}`,
  )
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — ' + loopHint)
  const nudges = (i: number): number =>
    userTexts(r.calls[i]?.messages ?? []).filter(t => t === STREAM_FAULT_RECOVERY_NUDGE).length
  check('the first recovery nudge rides call 2', nudges(1) === 1, String(nudges(1)) + ' — ' + loopHint)
  check('the second recovery nudge rides call 4', nudges(3) >= 1, String(nudges(3)) + ' — ' + loopHint)
  const lastCall = r.calls.at(-1)
  check(
    'the final call still carries the completed tool round (settled work survives recovery)',
    toolResults(lastCall?.messages ?? []).some(t => t.id === 'tu_mid' && t.text.includes('echo:progress')),
    loopHint,
  )
}

section('S2 — the anti-spiral bound holds: two CONSECUTIVE faults, the second surfaces')
{
  const r = await run([
    partialThenFault('partial one'),
    partialThenFault('partial two'),
    [y(textTurn('never reached'))],
  ])
  check('exactly two calls — the consecutive second fault surfaces terminally', r.calls.length === 2, String(r.calls.length) + ' calls — ' + loopHint)
  check('terminal completed (the error tail is the visible outcome)', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — ' + loopHint)
}

section('S3 — a FAILED tool round never ends the run: the error rides back as a tool_result')
{
  const r = await run(
    [
      [y(toolTurn([{ id: 'tu_boom', name: 'BoomTool', input: { text: 'alpha' } }]))],
      [y(textTurn('saw the failure, moving on'))],
    ],
    [makeEchoTool(), makeBoomTool()],
  )
  check('two calls — the failed round CONTINUES the run', r.calls.length === 2, String(r.calls.length) + ' calls — ' + loopHint)
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — ' + loopHint)
  const results = toolResults(r.calls[1]?.messages ?? [])
  const boom = results.find(t => t.id === 'tu_boom')
  check('the thrown error is DELIVERED as an is_error tool_result', boom !== undefined && boom.isError, JSON.stringify(results) + ' — ' + loopHint)
  check('the delivered error names the cause', boom?.text.includes('rig exploded on alpha') === true, (boom?.text ?? '') + ' — ' + loopHint)
}

section('S4 — a grouped round failing WHOLE settles every member and continues')
{
  const r = await run(
    [
      [
        y(
          toolTurn([
            { id: 'tu_g1', name: 'BoomTool', input: { text: 'g1' } },
            { id: 'tu_g2', name: 'BoomTool', input: { text: 'g2' } },
          ]),
        ),
      ],
      [y(textTurn('both failures visible'))],
    ],
    [makeEchoTool(), makeBoomTool()],
  )
  check('two calls — the grouped failure CONTINUES the run', r.calls.length === 2, String(r.calls.length) + ' calls — ' + loopHint)
  const results = toolResults(r.calls[1]?.messages ?? [])
  const g1 = results.find(t => t.id === 'tu_g1')
  const g2 = results.find(t => t.id === 'tu_g2')
  check('EVERY grouped member settles its own error result (no unit death)', g1 !== undefined && g2 !== undefined, JSON.stringify(results.map(t => t.id)) + ' — ' + loopHint)
  check('both results are error-marked and name their member', g1?.isError === true && g2?.isError === true && g1.text.includes('g1') && g2.text.includes('g2'), JSON.stringify(results) + ' — ' + loopHint)
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal) + ' — ' + loopHint)
}

section('S5 — an unmapped INCOMPLETE finish on the GPT lane settles visibly, never silently')
{
  const callModel = await import('../../src/models/roads/openai/openaiCallModel.ts')
  const source = (async function* () {
    yield { type: 'text-delta', text: 'partial work before the cut' }
    yield {
      type: 'finish',
      reason: 'other-incomplete',
      toolCalls: [],
      reasoningItems: [],
      orderedItems: [],
      finalText: 'partial work before the cut',
      refusalText: '',
      unknownItemTypes: [],
      incompleteDetail: 'fixture_reason_word',
    }
  })() as never
  const gen = callModel.streamOneOpenaiAttempt({
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
    contractDigest: 'prover-digest',
  })
  const texts: string[] = []
  let stopReason: unknown
  let r = await gen.next()
  while (!r.done) {
    const v = r.value as AnyMsg
    if (v.type === 'assistant') {
      const content = (v.message as { content?: Array<{ type?: string; text?: string }> }).content ?? []
      for (const b of content) if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    }
    if (v.type === 'stream_event') {
      const ev = (v as { event?: { type?: string; delta?: { stop_reason?: unknown } } }).event
      if (ev?.type === 'message_delta' && ev.delta?.stop_reason != null) stopReason = ev.delta.stop_reason
    }
    r = await gen.next()
  }
  check(
    'the incomplete end is VISIBLE: a note names the provider\'s own reason',
    texts.some(t => t.includes('INCOMPLETE') && t.includes('fixture_reason_word')),
    texts.join(' | ').slice(0, 200) + ' — ' + openaiStreamHint,
  )
  check('the partial content still settles', texts.some(t => t.includes('partial work before the cut')), openaiStreamHint)
  check('stop_reason stays end_turn (the note, not a fake error, carries the truth)', stopReason === 'end_turn', String(stopReason) + ' — ' + openaiStreamHint)
}

section('S6 — done-carried text paints and settles (never an empty turn)')
{
  const wire = await import('../../src/models/roads/openai/openaiWire.ts')
  const fold = new wire.ResponsesStreamFold()
  const events = [
    ...fold.fold({ type: 'response.created', response: { id: 'resp_dc' } }),
    ...fold.fold({
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done-carried body' }],
      },
    }),
    ...fold.fold({
      type: 'response.completed',
      response: { id: 'resp_dc', usage: { input_tokens: 3, output_tokens: 2 } },
    }),
  ]
  const textDeltas = events.filter(e => e.type === 'text-delta') as Array<{ text: string }>
  check('the un-deltaed text emits as a text-delta at the done event', textDeltas.map(d => d.text).join('') === 'done-carried body', JSON.stringify(textDeltas) + ' — ' + openaiStreamHint)
  const finish = events.find(e => e.type === 'finish') as { finalText?: string } | undefined
  check('the finish still settles the same text', finish?.finalText === 'done-carried body', String(finish?.finalText) + ' — ' + openaiStreamHint)

  const fold2 = new wire.ResponsesStreamFold()
  const events2 = [
    ...fold2.fold({ type: 'response.output_text.delta', delta: 'streamed ' }),
    ...fold2.fold({ type: 'response.output_text.delta', delta: 'whole' }),
    ...fold2.fold({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'streamed whole' }] },
    }),
    ...fold2.fold({ type: 'response.completed', response: { id: 'r2', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]
  const deltas2 = (events2.filter(e => e.type === 'text-delta') as Array<{ text: string }>).map(d => d.text).join('')
  check('fully-streamed text never re-paints at done (exactly once)', deltas2 === 'streamed whole', JSON.stringify(deltas2) + ' — ' + openaiStreamHint)

  const fold3 = new wire.ResponsesStreamFold()
  const events3 = [
    ...fold3.fold({ type: 'response.output_text.delta', delta: 'half ' }),
    ...fold3.fold({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'half and rest' }] },
    }),
  ]
  const deltas3 = (events3.filter(e => e.type === 'text-delta') as Array<{ text: string }>).map(d => d.text).join('')
  check('a partially-streamed item paints exactly its remainder', deltas3 === 'half and rest', JSON.stringify(deltas3) + ' — ' + openaiStreamHint)
}

section('S7 — the wire heal folds split turns: a grouped round is ONE turn, never a pairing violation')
{
  const pairing = await import('../../src/engine/messages/wirePairing.ts')
  const { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } = await import('../../src/engine/message-shapes/rejectionText.ts')
  const asst = (id: string, blocks: unknown[]): unknown => {
    const m = createAssistantMessage({ content: blocks as never })
    ;(m.message as { id: string }).id = id
    m.message.stop_reason = 'tool_use'
    return m
  }
  const userResult = (toolUseId: string, body: string): unknown =>
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }] as never,
    })
  const split = [
    createUserMessage({ content: 'read both docs' }),
    asst('openai_turn_1', [{ type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: '/a' } }]),
    asst('openai_turn_1', [{ type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: '/b' } }]),
    userResult('call_a', 'body of a'),
    userResult('call_b', 'body of b'),
  ]
  const healed = pairing.healWalkableForWire(split as never)
  const healedJson = JSON.stringify(healed)
  check('NO synthetic missing-result is injected for the split grouped round', !healedJson.includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER), healedJson.slice(0, 200) + ' — ' + healHint)
  check('BOTH real results survive the heal', healedJson.includes('body of a') && healedJson.includes('body of b'), healedJson.slice(0, 200) + ' — ' + healHint)
  const assistantRows = healed.filter(m => m.type === 'assistant')
  check('the grouped round folds to ONE assistant turn', assistantRows.length === 1, String(assistantRows.length) + ' assistant rows — ' + healHint)
  const uses = assistantRows.flatMap(m => (m.message.content as Array<{ type?: string; id?: string }>).filter(b => b.type === 'tool_use').map(b => b.id))
  check('the folded turn carries both tool_use blocks in order', uses.join(',') === 'call_a,call_b', uses.join(',') + ' — ' + healHint)
  const userRows = healed.filter(m => m.type === 'user' && JSON.stringify(m.message.content).includes('tool_result'))
  check('the results fold to ONE user row (the canonical round shape)', userRows.length === 1, String(userRows.length) + ' user rows — ' + healHint)

  const twoTurns = [
    createUserMessage({ content: 'seed' }),
    asst('openai_turn_1', [{ type: 'tool_use', id: 'c1', name: 'Read', input: {} }]),
    userResult('c1', 'r1'),
    asst('openai_turn_2', [{ type: 'tool_use', id: 'c2', name: 'Read', input: {} }]),
    userResult('c2', 'r2'),
  ]
  const healed2 = pairing.healWalkableForWire(twoTurns as never)
  check('distinct turns stay distinct (no cross-turn merge)', healed2.filter(m => m.type === 'assistant').length === 2, healHint)
  check('a text-bearing user row never merges into results', (() => {
    const mixed = [
      createUserMessage({ content: 'seed' }),
      asst('t3', [{ type: 'tool_use', id: 'c3', name: 'Read', input: {} }]),
      userResult('c3', 'r3'),
      createUserMessage({ content: 'a plain follow-up' }),
    ]
    const healedMixed = pairing.healWalkableForWire(mixed as never)
    return healedMixed.filter(m => m.type === 'user').length === 3
  })())
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
