#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'malformed-tool-result-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
for (const name of ['GOOGLE_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV']) delete process.env[name]
const key = 'AIzaFixtureMalformedCall00000000000000'
process.env.GEMINI_API_KEY = key
writeFileSync(join(proofHome, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key' }))

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { streamGeminiContent, geminiMalformedCallName, GEMINI_MALFORMED_FUNCTION_CALL } = await import('../../src/services/providers/gemini/geminiClient.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const gate = await import('../../src/services/providers/toolCallGate.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { childRowsOf } = await import('../../src/rows/child.ts')
import type { AssistantMessage, Message, RefusedToolCall } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let passes = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — malformed-call tool-result prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const model = 'gemini-4-argon'
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/
const jevEval = {
  name: 'JevEval',
  prompt: async () => 'Judge rows.',
  inputSchema: z.object({ evidence: z.array(z.object({ id: z.string().regex(ROW_ID, 'is not letters, digits, _ and - of at most 64 characters'), text: z.string() })) }).strict(),
  inputJSONSchema: { type: 'object', properties: { evidence: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } } }, required: ['evidence'] },
}
const grep = {
  name: 'Grep',
  prompt: async () => 'Search.',
  inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), '-i': z.boolean().optional() }).strict(),
  inputJSONSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, '-i': { type: 'boolean' } }, required: ['pattern'] },
}
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(messages: Message[]): CompatCallModelParams {
  return {
    messages, systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [jevEval, grep] as never, signal: new AbortController().signal,
    options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
  }
}
async function drain(input: CompatCallModelParams): Promise<AssistantMessage[]> {
  const out: AssistantMessage[] = []
  for await (const item of geminiCallModel(input)) if (item.type === 'assistant') out.push(item)
  return out
}
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const usage = { promptTokenCount: 200, candidatesTokenCount: 40, thoughtsTokenCount: 12 }
let wire: unknown[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (!url.startsWith('https://gemini.fixture.invalid/')) throw new Error('unpinned Gemini request')
  if (!url.endsWith(`/models/${model}:streamGenerateContent?alt=sse`)) return Response.json({ error: { message: 'wrong native URL' } }, { status: 404 })
  return sse(wire)
}) as typeof fetch
const shapeOf = (rows: AssistantMessage[]) => rows.map(row => [row.message.content.map(block => block.type).join('+'), row.message.stop_reason ?? null, (row.refusedToolCalls ?? []).map(r => r.code).join('+')])
const textOf = (rows: AssistantMessage[]) => rows.flatMap(row => row.message.content).filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')

type AnyMsg = Record<string, unknown> & { type?: string }
function makeTool(name: string, calls: string[]): never {
  return {
    name,
    async description() { return 'rig tool' },
    async prompt() { return 'rig tool' },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() { return { result: true } },
    async call(input: Record<string, unknown>) { calls.push(name); return { data: `echo:${(input?.text as string) ?? ''}` } },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
function makeCtx(tools: unknown[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools, engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
const refusal = (over: Partial<RefusedToolCall> = {}): RefusedToolCall => ({ id: 'call_bad', name: 'EchoTool', argumentsRaw: '{"text":4}', code: 'schema', reason: 'EchoTool failed (issue):\nParameter `text` expects type string, got number', ...over })
function answeredTurn(r: RefusedToolCall): AssistantMessage {
  const m = createAssistantMessage({ content: [{ type: 'tool_use', id: r.id, name: r.name, input: gate.refusedCallInput(r) }] as never })
  m.message.stop_reason = 'tool_use'
  m.refusedToolCalls = [r]
  return m
}
function noteTurn(r: RefusedToolCall): AssistantMessage {
  const m = createAssistantMessage({ content: gate.toolCallRefusalNote('fixture', r) })
  m.message.stop_reason = 'end_turn'
  m.refusedToolCalls = [r]
  return m
}
const textTurn = (text: string): AssistantMessage => {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return m
}
async function run(script: unknown[][], tools: unknown[]): Promise<{ yields: AnyMsg[]; calls: Array<{ messages: unknown[] }>; terminal: Record<string, unknown> }> {
  const calls: Array<{ messages: unknown[] }> = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  const gen = query({
    messages: [createUserMessage({ content: 'judge the rows' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: makeCtx(tools) as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })(),
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
const toolResultsOf = (msgs: unknown[]): Array<{ id: string; isError: boolean; text: string }> => {
  const out: Array<{ id: string; isError: boolean; text: string }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as AnyMsg[]) {
      if (b?.type !== 'tool_result') continue
      const content = b.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as AnyMsg[]).map(x => String(x.text ?? '')).join('') : ''
      out.push({ id: String(b.tool_use_id), isError: b.is_error === true, text })
    }
  }
  return out
}
const userTexts = (msgs: unknown[]): string[] => {
  const out: string[] = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) for (const b of c as AnyMsg[]) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}
const notices = (yields: AnyMsg[]): string[] => yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? ''))

try {
  console.log("── (a) the recorded JevEval shape on the Gemini road: a row id with a colon is a schema miss ──")
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'JevEval', args: { evidence: [{ id: 'hero:0', text: 'seed=152000 pass' }] } }, thoughtSignature: 'sig-jev' }] }, finishReason: 'STOP' }], usageMetadata: usage },
  ]
  const jev = await drain(params([user('Judge the candidates.')]))
  check('the call mints its tool_use carrying the schema refusal, with the fact ahead and tool_use as the stop reason; no text block stands in for it', j(shapeOf(jev)) === j([['thinking', null, ''], ['tool_use', 'tool_use', 'schema']]), j(shapeOf(jev)))
  check('no assistant text says what the provider did', textOf(jev) === '', textOf(jev))
  const jevBlock = jev.at(-1)!.message.content[0] as { type: string; id: string; name: string; input: unknown }
  const jevRefusal = jev.at(-1)!.refusedToolCalls![0]!
  check("the block holds the model's own arguments and the refusal names the id rule", jevBlock.name === 'JevEval' && j(jevBlock.input) === j({ evidence: [{ id: 'hero:0', text: 'seed=152000 pass' }] }) && jevRefusal.id === jevBlock.id && jevRefusal.reason.includes('evidence[0].id') && jevRefusal.reason.includes('is not letters, digits, _ and -'), jevRefusal.reason)
  check('the replay record names the call and lists nothing left unanswered', (jev.at(-1) as unknown as { geminiProviderTurn?: { calls: unknown[]; refused?: unknown } }).geminiProviderTurn?.calls.length === 1 && (jev.at(-1) as unknown as { geminiProviderTurn?: { refused?: unknown } }).geminiProviderTurn?.refused === undefined)

  console.log('── (b) the recorded Grep shape: the model wrote `i` for `-i` ──')
  wire = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Grep', args: { pattern: 'todo', path: '/proj/docs/18.md', i: true } } }] }, finishReason: 'STOP' }], usageMetadata: usage },
  ]
  const grepTurn = await drain(params([user('Search.')]))
  check('the Grep call mints its block carrying the schema refusal and the reason names the stray field', j(shapeOf(grepTurn)) === j([['tool_use', 'tool_use', 'schema']]) && (grepTurn[0]!.refusedToolCalls![0]!.reason.includes('`i`')), j(shapeOf(grepTurn)) + ' ' + (grepTurn[0]?.refusedToolCalls?.[0]?.reason ?? ''))

  console.log('── (c) through the real loop: the executor answers the refused call with an error result and the model recovers in the same loop ──')
  const spy: string[] = []
  const tools = [makeTool('EchoTool', spy)]
  const loop = await run([[answeredTurn(refusal())], [textTurn('fixed it')]], tools)
  check('two model calls, completed', loop.calls.length === 2 && loop.terminal.reason === 'completed', `${loop.calls.length} ${j(loop.terminal)}`)
  const results = toolResultsOf(loop.calls[1]?.messages ?? [])
  check('the second call carries ONE tool_result for the refused call, flagged is_error, with the schema reason and the next step', results.length === 1 && results[0]!.id === 'call_bad' && results[0]!.isError && results[0]!.text.includes('Parameter `text` expects type string, got number') && results[0]!.text.includes('The call did not run'), j(results))
  check('no correction text rides the request and no notice says the call was refused', !userTexts(loop.calls[1]?.messages ?? []).some(t => gate.isToolCallRefusalCorrectionText(t)) && !notices(loop.yields).some(t => t.includes('Tool call refused before execution')), notices(loop.yields).join(' | '))
  check('the tool itself never ran', spy.length === 0, j(spy))
  check('the error result reached the transcript as a user row with is_error', loop.yields.some(m => toolResultsOf([m]).some(t => t.id === 'call_bad' && t.isError)))

  console.log('── (d) an unpairable refusal keeps the note and the correction road ──')
  const nameless = await run([[noteTurn(refusal({ id: 'missing-call-id-0', name: '', code: 'missing-id', reason: 'the provider delivered the call without a call id, so its result could not be paired' }))], [textTurn('re-issued')]], tools)
  check('two calls, the correction injected as the next user turn', nameless.calls.length === 2 && userTexts(nameless.calls[1]?.messages ?? []).some(t => gate.isToolCallRefusalCorrectionText(t)) && notices(nameless.yields).some(t => t.includes('Tool call refused before execution')), notices(nameless.yields).join(' | '))

  console.log("── (e) Google's own MALFORMED_FUNCTION_CALL ──")
  const events: Array<Record<string, unknown>> = []
  for await (const event of streamGeminiContent({ apiKey: key, url: `https://gemini.fixture.invalid/v1beta/models/${model}:streamGenerateContent?alt=sse`, request: { model, messages: [{ role: 'user', content: 'go' }] }, messages: [], fetchImpl: (async () => sse([{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call: print(default_api.Read(file_path="/proj/app.py"))' }], usageMetadata: usage }])) as typeof fetch, idleTimeoutMs: 40, onTurn: () => {} })) events.push(event as Record<string, unknown>)
  const finish = events.find(event => event.type === 'finish') as { reason: string; toolCalls: Array<{ name: string; providerRefusal?: string; argumentsRaw: string }> } | undefined
  check('the client settles a finish of tool_calls carrying ONE provider-refused call named from the message, never a provider-termination fault', finish?.reason === 'tool_calls' && finish.toolCalls.length === 1 && finish.toolCalls[0]!.name === 'Read' && finish.toolCalls[0]!.providerRefusal?.includes(GEMINI_MALFORMED_FUNCTION_CALL) === true && finish.toolCalls[0]!.argumentsRaw.includes('default_api.Read') && !events.some(event => event.type === 'stream-fault'), j(events.map(event => event.type)))
  check('the name reader covers the shapes Google writes', geminiMalformedCallName('Malformed function call: print(default_api.Read(file_path="x"))') === 'Read' && geminiMalformedCallName('Malformed function call: Bash({command: "ls"})') === 'Bash' && geminiMalformedCallName('Malformed function call: call:Grep{pattern: x}') === 'Grep' && geminiMalformedCallName(undefined) === '')
  wire = [{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Malformed function call: print(default_api.Grep(pattern="todo"))' }], usageMetadata: usage }]
  const malformed = await drain(params([user('Search.')]))
  check('on the road it settles as the note carrying a provider-malformed refusal, end_turn, no api-error row, and the run stays alive', j(shapeOf(malformed)) === j([['text', 'end_turn', 'provider-malformed']]) && !malformed.some(m => m.isApiErrorMessage) && textOf(malformed).includes('could not parse the function call the model wrote') && textOf(malformed).includes('Grep'), j(shapeOf(malformed)) + ' ' + textOf(malformed))
  check('the record carries no function response for a call Google never emitted', (malformed.at(-1) as unknown as { geminiProviderTurn?: { calls: unknown[]; refused?: unknown[] } }).geminiProviderTurn?.calls.length === 0 && (malformed.at(-1) as unknown as { geminiProviderTurn?: { refused?: unknown[] } }).geminiProviderTurn?.refused?.length === 1)
  const providerRefusal = malformed[0]!.refusedToolCalls![0]!
  const corrected = await run([[noteTurn(providerRefusal)], [textTurn('re-issued as a proper call')]], tools)
  check('the turn machine hands the model the correction naming what the provider could not parse, and the model is called again', corrected.calls.length === 2 && userTexts(corrected.calls[1]?.messages ?? []).some(t => gate.isToolCallRefusalCorrectionText(t) && t.includes('the provider could not parse the function call you wrote for Grep')), userTexts(corrected.calls[1]?.messages ?? []).join(' | ').slice(0, 400))

  console.log('── (f) the executor intercept and the rows ──')
  const spy2: string[] = []
  const echo = makeTool('EchoTool', spy2)
  const carrying = answeredTurn(refusal())
  const ctx = makeCtx([echo])
  const updates: unknown[] = []
  for await (const update of runToolUse(carrying.message.content[0] as never, carrying, allowAll as never, ctx as never)) updates.push(update)
  const answered = toolResultsOf(updates.map(u => (u as { message: unknown }).message))
  check('runToolUse answers a refused call with the error result and never calls the tool', answered.length === 1 && answered[0]!.isError && answered[0]!.text.includes('expects type string') && spy2.length === 0, j(answered))
  const rows = childRowsOf({ session_id: 's', parent_call_id: 'p' }, carrying)
  const kinds = rows.map(row => row.type)
  check('the rows project one tool_call for the block and no refused row beside it', kinds.filter(k => k === 'tool_call').length === 1 && !rows.some(row => (row as { status?: string }).status === 'refused'), j(kinds))
  const noteRows = childRowsOf({ session_id: 's', parent_call_id: 'p2' }, noteTurn(refusal({ id: '', code: 'missing-id' })))
  check('a note-shaped refusal still projects its refused call and result rows', noteRows.some(row => (row as { status?: string }).status === 'refused'), j(noteRows.map(row => row.type)))
  check('the gate says which refusals a result answers', gate.refusalAnswersAsToolResult(refusal()) && gate.refusalAnswersAsToolResult(refusal({ code: 'unknown-tool' })) && gate.refusalAnswersAsToolResult(refusal({ code: 'invalid-json', argumentsRaw: '{"text": ' })) && !gate.refusalAnswersAsToolResult(refusal({ code: 'missing-id', id: 'missing-call-id-0' })) && !gate.refusalAnswersAsToolResult(refusal({ code: 'duplicate-id' })) && !gate.refusalAnswersAsToolResult(refusal({ code: 'provider-malformed' })) && !gate.refusalAnswersAsToolResult(refusal({ name: '' })))
  check('the input a refused block holds is the parsed object, or an empty object for bytes that never parsed', j(gate.refusedCallInput(refusal())) === j({ text: 4 }) && j(gate.refusedCallInput(refusal({ argumentsRaw: '[1,2]' }))) === j({}) && j(gate.refusedCallInput(refusal({ argumentsRaw: '{"text": ' }))) === j({}))
  check('the result text for bytes that never parsed quotes them and says what to send', gate.toolCallRefusalResultText(refusal({ code: 'invalid-json', argumentsRaw: '{"text": ', reason: 'the arguments were not valid JSON' })).includes('Arguments received: {"text":') && gate.toolCallRefusalResultText(refusal({ code: 'invalid-json', argumentsRaw: '{"text": ', reason: 'the arguments were not valid JSON' })).includes('one JSON object'))
} finally {
  globalThis.fetch = realFetch
}
console.log(`${passes + failures} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
