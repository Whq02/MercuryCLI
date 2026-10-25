#!/usr/bin/env bun
// gate-watch: src/run-core/turn-machine.ts src/services/providers/anthropic/streamCore.ts src/services/api/outputFit.ts src/query/transitions.ts scripts/compact/overflowFixture.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cut-tool-call-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'cut-tool-call-daemon-'))
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
  console.log('\nTIMEOUT — cut tool call prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('============================================================')
console.log(' a reply cut at the output limit inside a tool call: the call never runs, the request is re-asked with a raised cap, bounded')
console.log(' P1 the decision: the cap doubles from what was sent or where the cut fell, never above the model\'s stated output limit or the window\'s room, twice at most; the Responses road and a cap already at the ceiling surface at once')
console.log(' P2 the Anthropic seam over the loopback: a tool_use whose input ended before its JSON closed settles as a refusal note (never a call with empty input); the chat seam\'s gate already refuses it')
console.log(' P3 the turn machine over a scripted model: two re-asks at 2× and 4×, the request bytes identical but for the cap, nothing executed, then the correction road')
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
const { createAssistantMessage, createUserMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const gate = await import('../../src/services/providers/toolCallGate.ts')
const turnMachine = await import('../../src/run-core/turn-machine.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
type RefusedToolCall = import('../../src/types/message.ts').RefusedToolCall
type AnyMsg = Record<string, unknown> & { type?: string }

section('P1 the decision')
{
  const decide = (turnMachine as { decideCutToolCallRecovery?: (input: Record<string, unknown>) => { kind: string; attempt?: number; outputTokens?: number } }).decideCutToolCallRecovery
  check('the decision exists on the turn machine', typeof decide === 'function')
  if (decide) {
    const first = decide({ recoveryCount: 0, sentCap: undefined, cutAt: 4_096, upperLimit: 64_000, room: 500_000, routeTakesCap: true })
    check('no cap sent: the first re-ask doubles where the cut fell (4,096 → 8,192)', first.kind === 'retry' && first.attempt === 1 && first.outputTokens === 8_192, JSON.stringify(first))
    const second = decide({ recoveryCount: 1, sentCap: 8_192, cutAt: 8_192, upperLimit: 64_000, room: 500_000, routeTakesCap: true })
    check('the second re-ask doubles the cap that was sent (8,192 → 16,384)', second.kind === 'retry' && second.attempt === 2 && second.outputTokens === 16_384, JSON.stringify(second))
    const third = decide({ recoveryCount: 2, sentCap: 16_384, cutAt: 16_384, upperLimit: 64_000, room: 500_000, routeTakesCap: true })
    check('a third cut surfaces (twice at most)', third.kind === 'surface', JSON.stringify(third))
    const bounded = decide({ recoveryCount: 0, sentCap: 40_000, cutAt: 40_000, upperLimit: 64_000, room: 500_000, routeTakesCap: true })
    check('the raise is bounded by the model\'s stated output limit (40,000 → 64,000, not 80,000)', bounded.kind === 'retry' && bounded.outputTokens === 64_000, JSON.stringify(bounded))
    const atMax = decide({ recoveryCount: 0, sentCap: 128_000, cutAt: 128_000, upperLimit: 128_000, room: 500_000, routeTakesCap: true })
    check('a cap already at the model\'s limit cannot be raised: surface (max stays max, never a double bill)', atMax.kind === 'surface', JSON.stringify(atMax))
    const roomBound = decide({ recoveryCount: 0, sentCap: undefined, cutAt: 4_096, upperLimit: 64_000, room: 6_000, routeTakesCap: true })
    check('the raise is bounded by the room the window leaves (4,096 → 6,000)', roomBound.kind === 'retry' && roomBound.outputTokens === 6_000, JSON.stringify(roomBound))
    const noRoom = decide({ recoveryCount: 0, sentCap: undefined, cutAt: 4_096, upperLimit: 64_000, room: 4_000, routeTakesCap: true })
    check('no room above the cut: surface', noRoom.kind === 'surface', JSON.stringify(noRoom))
    const neverBelow = decide({ recoveryCount: 0, sentCap: 20_000, cutAt: 3_000, upperLimit: 64_000, room: 500_000, routeTakesCap: true })
    check('the base is what was sent when the cut fell short of it: 20,000 → 40,000, never below the ask', neverBelow.kind === 'retry' && neverBelow.outputTokens === 40_000, JSON.stringify(neverBelow))
    const responses = decide({ recoveryCount: 0, sentCap: undefined, cutAt: 4_096, upperLimit: 128_000, room: 500_000, routeTakesCap: false })
    check('a road that takes no cap surfaces at once', responses.kind === 'surface', JSON.stringify(responses))
  }
}

section('P2 the provider seams over the loopback')
async function callLane(model: string): Promise<AnyMsg[]> {
  const assistants: AnyMsg[] = []
  const stream = routedCallModel({
    messages: [createUserMessage({ content: 'list the folder' })] as never,
    systemPrompt: asSystemPrompt(['fixture system prompt']),
    thinkingConfig: { type: 'disabled' },
    tools: [makeTool('Bash')] as never,
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
    if (m.type === 'assistant') assistants.push(m)
  }
  return assistants
}
const blocksOf = (rows: AnyMsg[]): Array<Record<string, unknown>> =>
  rows.filter(m => m.isApiErrorMessage !== true).flatMap(m => ((m.message as { content?: unknown }).content as Array<Record<string, unknown>>) ?? [])
const refusedOf = (rows: AnyMsg[]): RefusedToolCall[] => rows.flatMap(m => ((m as { refusedToolCalls?: RefusedToolCall[] }).refusedToolCalls ?? []))
{
  const cutArgs = '{"command": "ls -la /tmp/some/folder/with/a/long/path/that/never/clo'
  fixture.script([{ calls: [{ id: 'toolu_cut', name: 'Bash', args: cutArgs }], usage: { input: 12, output: 4_096 }, finishReason: 'length' }])
  const rows = await callLane('claude-opus-4-8')
  const blocks = blocksOf(rows)
  check('anthropic: no tool_use block settles for the cut call', !blocks.some(b => b.type === 'tool_use'), JSON.stringify(blocks).slice(0, 300))
  const refused = refusedOf(rows)
  check('anthropic: the cut call settles as a refusal note with the invalid-json code and its raw bytes', refused.length === 1 && refused[0]!.code === 'invalid-json' && refused[0]!.id === 'toolu_cut' && refused[0]!.name === 'Bash' && refused[0]!.argumentsRaw === cutArgs, JSON.stringify(refused))
  check('anthropic: the note reads as the gate\'s own sentence', blocks.some(b => b.type === 'text' && String(b.text).includes('malformed tool call (Bash)') && String(b.text).includes('not executed')), JSON.stringify(blocks).slice(0, 300))
  check('anthropic: the reply records the output-limit stop and where it fell', rows.some(m => (m.message as { stop_reason?: string }).stop_reason === 'max_tokens' && (m.message as { usage?: { output_tokens?: number } }).usage?.output_tokens === 4_096), JSON.stringify(rows.map(m => (m.message as { stop_reason?: string; usage?: unknown }).stop_reason)))
  check('anthropic: the withheld output-limit error follows', rows.some(m => (m as { apiError?: string }).apiError === 'max_output_tokens'))
  fixture.script([{ calls: [{ id: 'toolu_ok', name: 'Bash', args: '{"command": "ls"}' }], usage: { input: 12, output: 20 } }])
  const whole = await callLane('claude-opus-4-8')
  const wholeBlocks = blocksOf(whole)
  check('anthropic: a whole call still settles as a tool_use with its input', wholeBlocks.some(b => b.type === 'tool_use' && JSON.stringify(b.input) === '{"command":"ls"}') && refusedOf(whole).length === 0, JSON.stringify(wholeBlocks).slice(0, 200))
  fixture.script([{ calls: [{ id: 'call_cut', name: 'Bash', args: cutArgs }], usage: { input: 12, output: 4_096 }, finishReason: 'length' }])
  const chat = await callLane('deepseek-v4-pro')
  const chatRefused = refusedOf(chat)
  check('chat lane: the gate refuses the cut call with the invalid-json code (as it did), the reply stopped at the output limit', chatRefused.length === 1 && chatRefused[0]!.code === 'invalid-json' && chat.some(m => (m.message as { stop_reason?: string }).stop_reason === 'max_tokens') && !blocksOf(chat).some(b => b.type === 'tool_use'), JSON.stringify(chatRefused))
}

section('P3 the turn machine over a scripted model')
function makeTool(name: string, onCall?: () => void): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ command: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      onCall?.()
      return { data: `ran:${(input?.command as string) ?? ''}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}
function makeCtx(model: string, tools: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
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
type CallRecord = { messages: unknown[]; cap: number | undefined }
function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[]; options: { maxOutputTokensOverride?: number } }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages], cap: req.options.maxOutputTokensOverride })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
const cutArgs = '{"command": "ls -la /tmp/some/folder/that/never/clo'
function cutTurn(model: string, outputTokens: number): unknown[] {
  const refusal: RefusedToolCall = { id: 'call_cut', name: 'Bash', argumentsRaw: cutArgs, argumentsLength: cutArgs.length, code: 'invalid-json', reason: 'the arguments were not valid JSON' }
  const note = createAssistantMessage({ content: gate.toolCallRefusalNote('fixture', refusal) })
  note.message.stop_reason = 'max_tokens'
  note.message.model = model
  note.message.usage = { ...note.message.usage, input_tokens: 40, output_tokens: outputTokens }
  note.refusedToolCalls = [refusal]
  const withheld = createAssistantAPIErrorMessage({ content: 'API Error: the reply exceeded the output limit', apiError: 'max_output_tokens', error: 'max_output_tokens' })
  return [note, withheld]
}
function toolTurn(model: string): unknown[] {
  const m = createAssistantMessage({ content: [{ type: 'tool_use', id: 'call_ok', name: 'Bash', input: { command: 'ls' } }] as never })
  m.message.stop_reason = 'tool_use'
  m.message.model = model
  return [m]
}
function textTurn(model: string, text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  m.message.model = model
  return [m]
}
async function run(model: string, script: unknown[][]): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; terminal: Record<string, unknown>; ran: number }> {
  let ran = 0
  const ctx = makeCtx(model, [makeTool('Bash', () => { ran++ })])
  const { calls, callModel } = makeModel(script)
  const gen = query({
    messages: [createUserMessage({ content: 'please list the folder' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
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
  return { yields, calls, terminal: r.value as Record<string, unknown>, ran }
}
const notices = (yields: AnyMsg[]): string[] => yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? (m as { text?: unknown }).text ?? ''))
const userRows = (msgs: unknown[]): unknown[] => (msgs as AnyMsg[]).filter(m => m?.type === 'user')
{
  const model = 'deepseek-v4-pro'
  const limits = getModelMaxOutputTokens(model)
  check(`the lane's stated output limit stands above the cut (${limits.upperLimit})`, limits.upperLimit === 393_216)
  const r = await run(model, [cutTurn(model, 4_096), cutTurn(model, 8_192), cutTurn(model, 16_384), toolTurn(model), textTurn(model, 'listed')])
  check('five model calls: the cut, two re-asks, the correction road, the answer', r.calls.length === 5, String(r.calls.length))
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the first request carried no cap', r.calls[0]?.cap === undefined, String(r.calls[0]?.cap))
  check('the first re-ask carries room for 8,192 output tokens (2× where the cut fell)', r.calls[1]?.cap === 8_192, String(r.calls[1]?.cap))
  check('the second re-ask carries 16,384 (2× the cap that was sent)', r.calls[2]?.cap === 16_384, String(r.calls[2]?.cap))
  check('each re-ask sends the SAME request rows as the first (no note, no nudge, no partial replayed)', JSON.stringify(r.calls[1]?.messages) === JSON.stringify(r.calls[0]?.messages) && JSON.stringify(r.calls[2]?.messages) === JSON.stringify(r.calls[0]?.messages), `${r.calls[0]?.messages.length}/${r.calls[1]?.messages.length}/${r.calls[2]?.messages.length}`)
  const correction = userRows(r.calls[3]?.messages ?? []).map(m => {
    const content = ((m as AnyMsg).message as { content?: unknown }).content
    return typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => String((b as { text?: unknown }).text ?? '')).join('') : ''
  }).filter(text => gate.isToolCallRefusalCorrectionText(text))
  check('after the second re-ask is cut too, the correction road asks the model to re-emit (one correction row)', correction.length === 1 && (r.calls[3]?.messages.length ?? 0) > (r.calls[0]?.messages.length ?? 0), `${correction.length} rows · ${r.calls[3]?.messages.length} messages`)
  check('the tool ran exactly once — on the whole call, never on a cut one', r.ran === 1, String(r.ran))
  const lines = notices(r.yields)
  check('the operator reads each re-ask with the cut point and the new room', lines.filter(l => l.includes('cut at 4,096 output tokens inside a tool call (Bash)') && l.includes('room for 8,192') && l.includes('1 of 2')).length === 1 && lines.some(l => l.includes('cut at 8,192') && l.includes('room for 16,384') && l.includes('2 of 2')), JSON.stringify(lines))
}
{
  const model = 'claude-opus-4-8'
  const limits = getModelMaxOutputTokens(model)
  const r = await run(model, [cutTurn(model, limits.default), toolTurn(model), textTurn(model, 'listed')])
  check(`a cap already at the model's limit (${limits.default} of ${limits.upperLimit}): no re-ask, straight to the correction road`, r.calls.length === 3 && r.calls[1]?.cap === undefined && r.ran === 1 && !notices(r.yields).some(l => l.includes('re-asking with room')), `${r.calls.length} calls · cap ${r.calls[1]?.cap} · ran ${r.ran}`)
}
{
  const model = 'gpt-5.6-sol'
  const r = await run(model, [cutTurn(model, 4_096), toolTurn(model), textTurn(model, 'listed')])
  check('the Responses road takes no cap: no re-ask, the correction road', r.calls.length === 3 && r.calls[1]?.cap === undefined && !notices(r.yields).some(l => l.includes('re-asking with room')), `${r.calls.length} calls · cap ${r.calls[1]?.cap}`)
}

section('refusals — bad numbers, a nameless cut, huge bytes, the model-facing words, the control')
{
  const decide = (turnMachine as { decideCutToolCallRecovery?: (input: Record<string, unknown>) => { kind: string } }).decideCutToolCallRecovery
  if (decide) {
    for (const bad of [
      { sentCap: Number.NaN, cutAt: 4_096, upperLimit: 64_000, room: 500_000 },
      { sentCap: undefined, cutAt: Number.NaN, upperLimit: 64_000, room: 500_000 },
      { sentCap: undefined, cutAt: 4_096, upperLimit: Number.POSITIVE_INFINITY, room: 500_000 },
      { sentCap: undefined, cutAt: 4_096, upperLimit: 64_000, room: Number.NaN },
      { sentCap: undefined, cutAt: 0, upperLimit: 0, room: 0 },
    ]) {
      const verdict = decide({ recoveryCount: 0, routeTakesCap: true, ...bad })
      check(`a number that is not finite, or no limit at all, surfaces instead of a re-ask (${JSON.stringify(bad)})`, verdict.kind === 'surface', JSON.stringify(verdict))
    }
  }
  const { cutToolCallOf } = await import('../../src/services/providers/anthropic/streamCore.ts')
  const nameless = cutToolCallOf({ type: 'tool_use', input: '{"command": "ls' })
  check('a cut call with no id and no name still refuses (empty id and name, the gate\'s own missing-id words follow)', nameless?.code === 'invalid-json' && nameless.id === '' && nameless.name === '', JSON.stringify(nameless))
  const huge = cutToolCallOf({ type: 'tool_use', id: 'toolu_big', name: 'Write', input: `{"content": "${'x'.repeat(5_000_000)}` })
  check('a 5 MB cut input is refused whole and its length recorded', huge?.code === 'invalid-json' && huge.argumentsLength === 5_000_013, String(huge?.argumentsLength))
  check('the correction the model reads bounds the raw bytes it quotes', huge !== null && gate.toolCallRefusalCorrection([huge]).length < 5_000, String(huge === null ? 0 : gate.toolCallRefusalCorrection([huge]).length))
  check('a whole call, an empty input, a text block and a server tool are never read as cut', cutToolCallOf({ type: 'tool_use', id: 'a', name: 'Bash', input: '{"command":"ls"}' }) === null && cutToolCallOf({ type: 'tool_use', id: 'a', name: 'Bash', input: '' }) === null && cutToolCallOf({ type: 'text', text: '{"command": "ls' }) === null && cutToolCallOf({ type: 'server_tool_use', id: 's', name: 'web_search', input: '{"query": "x' }) === null)
  const note = gate.toolCallRefusalNote('anthropic', { id: 'toolu_cut', name: 'Bash', argumentsRaw: '{"command": "ls', code: 'invalid-json', reason: 'r' })
  check('the model-facing note is the gate\'s own sentence, the one the chat lanes already send (lane word aside)', note === '[anthropic] the provider emitted a malformed tool call (Bash): its arguments were not valid JSON, so it was not executed.', note)
  const model = 'deepseek-v4-pro'
  const r = await run(model, [toolTurn(model), textTurn(model, 'listed')])
  check('the control: a whole tool call runs once with no re-ask and no notice', r.calls.length === 2 && r.ran === 1 && r.calls[1]?.cap === undefined && !notices(r.yields).some(l => l.includes('re-asking')), `${r.calls.length} calls · ran ${r.ran}`)
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
