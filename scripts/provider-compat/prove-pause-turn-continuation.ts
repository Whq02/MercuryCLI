#!/usr/bin/env bun
// gate-watch: src/run-core/turn-machine.ts src/query/transitions.ts src/services/providers/anthropic/streamCore.ts scripts/compact/overflowFixture.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pause-turn-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'pause-turn-daemon-'))
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'ANTHROPIC_API_KEY', 'MERCURY_MODEL']) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — pause turn prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('============================================================')
console.log(' a turn the provider paused mid-work (stop_reason pause_turn) is sent back to continue, the assistant turn replayed as it stands, eight times at most, each counting as a turn')
console.log(' P1 the decision: eight continuations, then the reply stands')
console.log(' P2 the Anthropic seam over the loopback: pause_turn settles as a stop, never a refusal or an error; the replayed turn rides the next request as its last message, byte for byte')
console.log(' P3 the turn machine over a scripted model: the pause continues with no nudge and no user row; the ninth pause ends the turn with the reply standing; a continuation counts toward --max-turns')
console.log('============================================================')

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const turnMachine = await import('../../src/run-core/turn-machine.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
type AnyMsg = Record<string, unknown> & { type?: string }

section('P1 the decision')
{
  const decide = (turnMachine as { decidePauseTurnContinuation?: (input: { continuations: number }) => { kind: string; attempt?: number } }).decidePauseTurnContinuation
  const limit = (turnMachine as { PAUSE_TURN_CONTINUATION_LIMIT?: number }).PAUSE_TURN_CONTINUATION_LIMIT
  check('the decision exists on the turn machine and the cap is eight', typeof decide === 'function' && limit === 8, String(limit))
  if (decide) {
    const first = decide({ continuations: 0 })
    check('the first pause continues (attempt 1)', first.kind === 'continue' && first.attempt === 1, JSON.stringify(first))
    const eighth = decide({ continuations: 7 })
    check('the eighth pause still continues (attempt 8)', eighth.kind === 'continue' && eighth.attempt === 8, JSON.stringify(eighth))
    const ninth = decide({ continuations: 8 })
    check('the ninth pause surfaces', ninth.kind === 'surface', JSON.stringify(ninth))
  }
}

section('P2 the Anthropic seam over the loopback')
async function callLane(model: string, messages: unknown[]): Promise<{ rows: AnyMsg[]; body: Record<string, unknown> | null }> {
  const before = fixture.captured.length
  const rows: AnyMsg[] = []
  const stream = routedCallModel({
    messages: messages as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [] as never,
    signal: AbortSignal.timeout(30_000),
    options: {
      model,
      querySource: 'sdk',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      enablePromptCaching: false,
      async getToolPermissionContext() {
        return getEmptyToolPermissionContext()
      },
    } as never,
  })
  for await (const ev of stream) {
    const m = ev as AnyMsg
    if (m.type === 'assistant') rows.push(m)
  }
  return { rows, body: (fixture.captured.slice(before).at(-1)?.body as Record<string, unknown> | undefined) ?? null }
}
{
  const model = 'claude-opus-4-8'
  fixture.script([{ text: 'Searching the web for the figure…', finishReason: 'pause_turn' }])
  const paused = await callLane(model, [createUserMessage({ content: 'what is the figure?' })])
  const reply = paused.rows.find(m => m.isApiErrorMessage !== true)
  check('the paused reply settles with stop_reason pause_turn and its text', reply !== undefined && (reply.message as { stop_reason?: string }).stop_reason === 'pause_turn' && JSON.stringify(reply.message).includes('Searching the web'), JSON.stringify(paused.rows.map(m => (m.message as { stop_reason?: string }).stop_reason)))
  check('no refusal and no API error is minted for a pause', paused.rows.every(m => m.isApiErrorMessage !== true), JSON.stringify(paused.rows.filter(m => m.isApiErrorMessage === true).map(m => JSON.stringify(m.message).slice(0, 120))))
  fixture.script([{ text: 'The figure is 42.' }])
  const continued = await callLane(model, [createUserMessage({ content: 'what is the figure?' }), reply as never])
  const sent = (continued.body?.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  const last = sent.at(-1)
  check('the continuation request ends on the replayed assistant turn (no user row appended)', last?.role === 'assistant' && sent.length === 2, JSON.stringify(sent.map(m => m.role)))
  check('…with the paused turn\'s content as it stands', JSON.stringify(last?.content).includes('Searching the web for the figure…'), JSON.stringify(last?.content).slice(0, 200))
  check('…and the provider\'s answer continues the turn', continued.rows.some(m => JSON.stringify(m.message).includes('The figure is 42.')))
}

section('P3 the turn machine over a scripted model')
function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      engineModel: model,
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
}
type CallRecord = { messages: unknown[] }
function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
function pausedTurn(model: string, text: string): unknown[] {
  const m = createAssistantMessage({ content: [{ type: 'text', text, citations: null }, { type: 'server_tool_use', id: `srvtoolu_${text.length}`, name: 'web_search', input: { query: 'the figure' } }] as never })
  m.message.stop_reason = 'pause_turn'
  m.message.model = model
  return [m]
}
function textTurn(model: string, text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  m.message.model = model
  return [m]
}
async function run(model: string, script: unknown[][], maxTurns?: number): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; terminal: Record<string, unknown> }> {
  const { calls, callModel } = makeModel(script)
  const gen = query({
    messages: [createUserMessage({ content: 'what is the figure?' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: makeCtx(model) as never,
    querySource: 'sdk' as never,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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
const notices = (yields: AnyMsg[]): string[] => yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? (m as { text?: unknown }).text ?? ''))
const roles = (msgs: unknown[]): string[] => (msgs as AnyMsg[]).map(m => String(m.type))
{
  const model = 'claude-opus-4-8'
  const r = await run(model, [pausedTurn(model, 'Searching…'), textTurn(model, 'The figure is 42.')])
  check('two model calls: the pause, the continuation', r.calls.length === 2, String(r.calls.length))
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the continuation request is the first request plus the paused assistant turn, nothing else (no nudge, no user row)', JSON.stringify(roles(r.calls[1]?.messages ?? [])) === JSON.stringify(['user', 'assistant']), JSON.stringify(roles(r.calls[1]?.messages ?? [])))
  const replayed = (r.calls[1]?.messages as AnyMsg[] | undefined)?.[1]
  const replayedText = JSON.stringify(replayed?.message ?? null)
  check('…the paused turn replayed as it stands (text and the server tool block)', replayedText.includes('Searching…') && replayedText.includes('server_tool_use') && (replayed?.message as { stop_reason?: string } | undefined)?.stop_reason === 'pause_turn', replayedText.slice(0, 200))
  const lines = notices(r.yields)
  check('the operator reads one quiet line for the continuation', lines.filter(l => l.includes('paused the turn mid-work') && l.includes('1 of 8')).length === 1, JSON.stringify(lines))
}
{
  const model = 'claude-opus-4-8'
  const pauses = Array.from({ length: 9 }, (_, i) => pausedTurn(model, `pause ${i + 1}`))
  const r = await run(model, [...pauses, textTurn(model, 'never asked')])
  check('nine pauses in a row: eight continuations, then the turn ends with the reply standing (nine calls, not ten)', r.calls.length === 9 && r.terminal.reason === 'completed', `${r.calls.length} calls · ${JSON.stringify(r.terminal)}`)
  const lines = notices(r.yields)
  check('the eighth continuation is named (8 of 8) and the ninth pause ends the turn', lines.some(l => l.includes('8 of 8')) && lines.some(l => l.includes('paused the turn 8 times in a row')), JSON.stringify(lines.slice(-2)))
  check('every continuation replayed the whole chain of paused turns in order', roles(r.calls[8]?.messages ?? []).join(',') === ['user', ...Array(8).fill('assistant')].join(','), JSON.stringify(roles(r.calls[8]?.messages ?? [])))
}
{
  const model = 'claude-opus-4-8'
  const r = await run(model, [pausedTurn(model, 'Searching…'), textTurn(model, 'The figure is 42.')], 1)
  check('a continuation counts toward --max-turns: with max-turns 1 the pause ends the run on the budget', r.terminal.reason === 'max_turns' && r.calls.length === 1, `${JSON.stringify(r.terminal)} · ${r.calls.length} calls`)
  const r2 = await run(model, [pausedTurn(model, 'Searching…'), textTurn(model, 'The figure is 42.')], 2)
  check('with max-turns 2 the continuation goes out and the run completes', r2.terminal.reason === 'completed' && r2.calls.length === 2, `${JSON.stringify(r2.terminal)} · ${r2.calls.length} calls`)
}

section('refusals — an empty paused reply, a paused error row, the replay bytes, the control')
{
  const model = 'claude-opus-4-8'
  const empty = createAssistantMessage({ content: [] as never })
  empty.message.stop_reason = 'pause_turn'
  empty.message.model = model
  const r = await run(model, [[empty], textTurn(model, 'never asked')])
  check('a paused reply with no content is not sent back (nothing to continue): the turn ends', r.calls.length === 1 && r.terminal.reason === 'completed', `${r.calls.length} calls`)
  const errorRow = createAssistantMessage({ content: 'API Error: something' })
  errorRow.message.stop_reason = 'pause_turn'
  errorRow.isApiErrorMessage = true
  const r2 = await run(model, [[errorRow], textTurn(model, 'never asked')])
  check('an API-error row carrying the pause word is never replayed', r2.calls.length === 1, `${r2.calls.length} calls`)
  const r3 = await run(model, [pausedTurn(model, 'Searching…'), textTurn(model, 'done')])
  const sentBack = (r3.calls[1]?.messages as AnyMsg[] | undefined)?.[1]
  const yielded = r3.yields.find(m => m.type === 'assistant' && (m.message as { stop_reason?: string }).stop_reason === 'pause_turn')
  check('the replayed turn is the very reply that was yielded, byte for byte (no edit, no marker, no nudge)', sentBack !== undefined && yielded !== undefined && JSON.stringify(sentBack.message) === JSON.stringify(yielded.message), JSON.stringify(sentBack?.message).slice(0, 160))
  const r4 = await run(model, [textTurn(model, 'a plain answer')])
  check('the control: a plain end_turn reply is one call, no continuation line', r4.calls.length === 1 && !notices(r4.yields).some(l => l.includes('paused the turn')), `${r4.calls.length} calls`)
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
