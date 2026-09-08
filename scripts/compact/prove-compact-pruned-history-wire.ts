#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the pruned-history wire proof exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_TIME_BASED_MC', 'MERCURY_MC_DIGEST', 'MERCURY_GPT_PRUNE_PRIOR_REASONING', 'MERCURY_STREAM_IDLE_TIMEOUT_MS',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pruned-history-wire-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'pruned-history-wire-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'pruned-history-wire-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' the compaction over a long tool history — the OpenAI Responses wire')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { MC_DIGEST_PREFIX, MC_CLEARED_PLACEHOLDER } = await import('../../src/services/compact/microCompactDigest.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')
const { autoCompactIfNeeded } = await import('../../src/services/compact/autoCompact.ts')
const { call: compactCommand } = await import('../../src/commands/compact/compact.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
const textOf = (m: unknown): string => {
  if (m === undefined || m === null || typeof m !== 'object') return ''
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}
const isPlaceholder = (content: unknown): boolean =>
  typeof content === 'string' && (content === MC_CLEARED_PLACEHOLDER || content.startsWith(MC_DIGEST_PREFIX))

const MODEL = 'gpt-5.6-sol'
const ROUNDS = 9
const SCRATCH = mkdtempSync(join(tmpdir(), 'pruned-history-files-'))
const files: string[] = []
for (let i = 0; i <= ROUNDS + 1; i++) {
  const path = join(SCRATCH, `notes-${i}.txt`)
  const lines: string[] = []
  for (let line = 0; line < 40; line++) lines.push(`file ${i} line ${line}: the station keeps its notes tidy and its checks green`)
  writeFileSync(path, lines.join('\n') + '\n')
  files.push(path)
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function makeCtx(model: string = MODEL): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [FileReadTool],
      mainLoopModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
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
    contentReplacementState: createContentReplacementState(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: ReturnType<typeof fixture.captured.slice> }
async function drive(ctx: Record<string, unknown>, messages: unknown[]): Promise<Drive> {
  const before = fixture.captured.length
  ctx.abortController = new AbortController()
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: messages as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: allowAll as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: productionDeps(),
    })
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, terminal, threw, wire: fixture.captured.slice(before) }
}

const cacheSafeFor = (ctx: Record<string, unknown>, messages: unknown[]) =>
  ({ systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: messages }) as never
async function compactOnce(ctx: Record<string, unknown>, messages: unknown[]): Promise<{ result: Record<string, unknown>; wire: ReturnType<typeof fixture.captured.slice>; threw: string | undefined }> {
  const before = fixture.captured.length
  ctx.abortController = new AbortController()
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '1'
  let result: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    result = (await autoCompactIfNeeded(messages as never, ctx as never, cacheSafeFor(ctx, messages), 'sdk', undefined, 0, undefined)) as unknown as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  } finally {
    delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  }
  return { result, wire: fixture.captured.slice(before), threw }
}

function textHistory(rounds: number, model: string): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < rounds; i++) {
    out.push(createUserMessage({ content: `ask ${i}: adjust module ${i} ${'and keep the notes tidy '.repeat(12)}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000000${String(10 + i)}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: `reply ${i}: module ${i} adjusted ${'and its checks pass '.repeat(12)}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900 + i, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }
  out.push(createUserMessage({ content: SECOND_ASK }))
  return out
}

const transcriptAfter = (seed: unknown[], run: Drive): unknown[] => [
  ...seed,
  ...run.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'attachment' || y.type === 'system'),
]

const readCall = (i: number, id: string) => ({ id, name: FileReadTool.name, args: JSON.stringify({ file_path: files[i] }) })
const reasoning = (i: number) => ({ summary: `reading notes ${i}`, encrypted: `encrypted-reasoning-${i}` })

type Row = AnyMsg & { message?: { id?: string; content?: unknown }; apexProviderTurn?: { items?: Array<{ type?: string; call_id?: string }> } }
const assistantRows = (rows: unknown[]): Row[] => (rows as Row[]).filter(r => r.type === 'assistant')
const toolUseIdsOfTurn = (rows: unknown[], messageId: string | undefined): Set<string> => {
  const ids = new Set<string>()
  for (const row of assistantRows(rows)) {
    if (row.message?.id !== messageId) continue
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as AnyMsg[]) if (block.type === 'tool_use') ids.add(String(block.id))
  }
  return ids
}
const unmintedRecordCalls = (rows: unknown[]): string[] => {
  const out: string[] = []
  for (const row of assistantRows(rows)) {
    const items = row.apexProviderTurn?.items ?? []
    const minted = toolUseIdsOfTurn(rows, row.message?.id)
    for (const item of items) {
      if (item.type === 'function_call' && !minted.has(String(item.call_id))) out.push(String(item.call_id))
    }
  }
  return out
}
const toolResultIds = (rows: unknown[]): string[] => {
  const out: string[] = []
  for (const row of rows as Row[]) {
    if (row.type !== 'user' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message!.content as AnyMsg[]) if (block.type === 'tool_result') out.push(String(block.tool_use_id))
  }
  return out
}

type Item = { type?: string; call_id?: string; role?: string; output?: unknown; encrypted_content?: string; content?: Array<{ text?: string }> }
const inputOf = (body: Record<string, unknown>): Item[] => ((body.input as Item[] | undefined) ?? [])
const callIds = (items: Item[]): string[] => items.filter(i => i.type === 'function_call').map(i => String(i.call_id))
const outputIds = (items: Item[]): string[] => items.filter(i => i.type === 'function_call_output').map(i => String(i.call_id))
const unansweredCalls = (items: Item[]): string[] => {
  const outputs = new Set(outputIds(items))
  return callIds(items).filter(id => !outputs.has(id))
}
const duplicateCalls = (items: Item[]): string[] => {
  const seen = new Set<string>()
  const dup: string[] = []
  for (const id of callIds(items)) {
    if (seen.has(id)) dup.push(id)
    seen.add(id)
  }
  return dup
}
const isSummariserRequest = (body: Record<string, unknown>): boolean => {
  const last = inputOf(body).at(-1)
  const text = Array.isArray(last?.content) ? last!.content.map(p => String(p.text ?? '')).join('') : ''
  return /summar/i.test(text)
}
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)
const freshErrorTexts = (yields: AnyMsg[], seed: unknown[]): string[] => {
  const seeded = new Set((seed as AnyMsg[]).map(m => String(m.uuid)))
  return errorTexts(yields.filter(y => !seeded.has(String(y.uuid))))
}
const noticeTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system').map(y => String(y.content ?? ''))
const boundaryOf = (yields: AnyMsg[]): AnyMsg | undefined => yields.find(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary')
const lastAssistantText = (yields: AnyMsg[]): string => textOf(yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage !== true).at(-1))

const OVERFLOW_SMALL_GAP = {
  error: {
    message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 129000 tokens. Please reduce the length of the messages.",
    type: 'invalid_request_error',
    param: 'input',
    code: 'context_length_exceeded',
  },
}
const MALFORMED_HISTORY_REFUSAL = {
  error: {
    message: 'No tool output found for function call call_tlxFSxc72b7dbbq5yBsOGC7a.',
    type: 'invalid_request_error',
    param: 'input',
    code: null,
  },
}
const FIRST_ASK = 'read every notes file and tell me what the station keeps'
const SECOND_ASK = 'now read the last notes file too and tell me what to keep'
const CUT_TEXT = 'Let me read the last notes file before I answer.'

const historyScript = (prefix: string) => [
  ...Array.from({ length: ROUNDS }, (_, i) => ({ calls: [readCall(i, `${prefix}_read_${i}`)], reasoning: reasoning(i) })),
]

section('R0 a stream cut after a text and a settled call — the reply does not stand; no record carries a call the turn did not mint')
const ctxA = makeCtx()
let historyA: unknown[]
{
  fixture.script([
    ...historyScript('a'),
    { cut: { reasoning: reasoning(ROUNDS), text: CUT_TEXT, calls: [readCall(ROUNDS, 'a_read_cut')] } },
    { calls: [readCall(ROUNDS, 'a_read_again')], reasoning: reasoning(ROUNDS + 1) },
    { text: 'all ten notes files are read: the station keeps its notes tidy and its checks green.', reasoning: reasoning(ROUNDS + 2) },
  ])
  const seed = [createUserMessage({ content: FIRST_ASK })]
  const r = await drive(ctxA, seed)
  historyA = transcriptAfter(seed, r)
  check('the run completed without throwing', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('THE RECORD RULE: no turn record carries a function_call the turn did not mint as a tool_use', unmintedRecordCalls(historyA).length === 0, `unminted=${JSON.stringify(unmintedRecordCalls(historyA))}`)
  check('the cut turn did not stand as the reply: the turn machine asked the model to continue (the notice speaks)', noticeTexts(r.yields).some(t => /ended the stream after partial content/.test(t) && /asked the model to continue/.test(t)), JSON.stringify(noticeTexts(r.yields)))
  check('the re-issued call ran: its result rides the history', toolResultIds(historyA).includes('a_read_again'), JSON.stringify(toolResultIds(historyA)))
  check('the closing answer settled last', lastAssistantText(r.yields).startsWith('all ten notes files are read'), lastAssistantText(r.yields))
  check('twelve Responses requests: nine rounds, the cut, the continuation with its round, the answer', r.wire.length === ROUNDS + 3, String(r.wire.length))
}

section('R1 a history persisted with such a record heals on read — the wire replays no call the content does not carry')
{
  const ctxR = makeCtx()
  const persistedTurnId = 'openai_persisted_unminted_call'
  const persisted: unknown[] = [
    createUserMessage({ content: 'earlier ask: read the notes' }),
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-a000-00000000ee01',
      timestamp: new Date().toISOString(),
      requestId: undefined,
      message: {
        id: persistedTurnId,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: CUT_TEXT, citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      apexProviderTurn: {
        provider: 'openai',
        items: [
          { type: 'reasoning', id: 'rs_persisted', summary: [{ type: 'summary_text', text: 'reading notes' }], encrypted_content: 'encrypted-persisted' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: CUT_TEXT }] },
          { type: 'function_call', call_id: 'call_persisted_unminted', name: FileReadTool.name, arguments: JSON.stringify({ file_path: files[0] }) },
        ],
      },
    },
    createUserMessage({ content: 'go on' }),
  ]
  fixture.script([{ text: 'going on.' }])
  const r = await drive(ctxR, persisted)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields))}`)
  const items = r.wire[0] !== undefined ? inputOf(r.wire[0].body) : []
  check('the request carries no function_call for the call the content does not hold', !callIds(items).includes('call_persisted_unminted'), JSON.stringify(callIds(items)))
  check('every function_call the request carries is answered', unansweredCalls(items).length === 0, JSON.stringify(unansweredCalls(items)))
  check('the turn replays from its content: its text rides as an assistant message item', items.some(i => i.type === 'message' && i.role === 'assistant' && Array.isArray(i.content) && i.content.some(p => String(p.text ?? '') === CUT_TEXT)), JSON.stringify(items.filter(i => i.type === 'message')))
}

section('P1 the prune rung, then the automatic compaction — the summariser\'s request answers every function call')
{
  fixture.script([
    { error: { status: 400, body: OVERFLOW_SMALL_GAP } },
    { calls: [readCall(ROUNDS + 1, 'a_read_late')], reasoning: reasoning(ROUNDS + 3), usage: { input: 300_000, output: 30 } },
    { text: 'SUMMARY: the notes files were read; the station keeps its notes tidy and its checks green; the operator asks what to keep.' },
    { text: 'the recovered answer', usage: { input: 700, output: 12 } },
  ])
  const seed = [...historyA, createUserMessage({ content: SECOND_ASK })]
  const r = await drive(ctxA, seed)
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields))}`)
  check('the notice names the prune rung with the provider\'s numbers', noticeTexts(r.yields).some(t => /^context overflowed \(OpenAI: 129,000 tokens > 128,000\) — pruned \d+ superseded tool results \(~[\d,]+ tokens\) and retrying$/.test(t)), JSON.stringify(noticeTexts(r.yields)))
  check('four Responses requests: the overflow, the pruned retry, the summariser, the post-compaction reply', r.wire.length === 4 && r.wire.every(w => w.dialect === 'responses'), `${r.wire.length} ${JSON.stringify(r.wire.map(w => w.dialect))}`)
  const retry = r.wire[1]
  const summariser = r.wire[2]
  const retryItems = retry !== undefined ? inputOf(retry.body) : []
  check('the pruned retry answers every function_call it replays', retry !== undefined && unansweredCalls(retryItems).length === 0, `unanswered=${JSON.stringify(unansweredCalls(retryItems))}`)
  check('the pruned retry carries placeholders for the results outside the keep-recent window', retryItems.filter(i => i.type === 'function_call_output' && isPlaceholder(i.output)).length >= ROUNDS - 5, JSON.stringify(retryItems.filter(i => i.type === 'function_call_output').map(i => String(i.output).slice(0, 40))))
  check('the third request is the summariser\'s (the compaction prompt rides last)', summariser !== undefined && isSummariserRequest(summariser.body))
  const items = summariser !== undefined ? inputOf(summariser.body) : []
  check('THE RULE: every function_call the summariser\'s request replays is answered by a function_call_output', summariser !== undefined && unansweredCalls(items).length === 0, `unanswered=${JSON.stringify(unansweredCalls(items))} calls=${JSON.stringify(callIds(items))} outputs=${JSON.stringify(outputIds(items))}`)
  check('no call id is sent twice', duplicateCalls(items).length === 0, JSON.stringify(duplicateCalls(items)))
  check('the pruned results ride the summariser\'s request as their placeholders (the summariser sees the pruned history)', items.filter(i => i.type === 'function_call_output' && isPlaceholder(i.output)).length >= ROUNDS - 5, JSON.stringify(items.filter(i => i.type === 'function_call_output').map(i => String(i.output).slice(0, 40))))
  check('the late round\'s result rides whole (inside the keep-recent window)', items.some(i => i.type === 'function_call_output' && i.call_id === 'a_read_late' && !isPlaceholder(i.output)))
  check('the turn records replay: reasoning items with their encrypted content ride the summariser\'s request', items.filter(i => i.type === 'reasoning' && typeof i.encrypted_content === 'string').length >= ROUNDS, String(items.filter(i => i.type === 'reasoning').length))
  check("the boundary yields, typed 'auto'", (boundaryOf(r.yields) as { compactMetadata?: { trigger?: string } } | undefined)?.compactMetadata?.trigger === 'auto', JSON.stringify((boundaryOf(r.yields) as { compactMetadata?: unknown } | undefined)?.compactMetadata))
  check('the reply settled last; the run minted no error row', lastAssistantText(r.yields) === 'the recovered answer' && freshErrorTexts(r.yields, seed).length === 0, JSON.stringify(freshErrorTexts(r.yields, seed)))
}

section('P2 the summariser itself overflows — the truncated retry answers every function call')
{
  const ctxB = makeCtx()
  fixture.script([
    ...historyScript('b'),
    { cut: { reasoning: reasoning(ROUNDS), text: CUT_TEXT, calls: [readCall(ROUNDS, 'b_read_cut')] } },
    { calls: [readCall(ROUNDS, 'b_read_again')], reasoning: reasoning(ROUNDS + 1) },
    { text: 'all ten notes files are read.', reasoning: reasoning(ROUNDS + 2) },
  ])
  const seedB = [createUserMessage({ content: FIRST_ASK })]
  const a = await drive(ctxB, seedB)
  const historyB = transcriptAfter(seedB, a)
  fixture.script([
    { error: { status: 400, body: OVERFLOW_SMALL_GAP } },
    { calls: [readCall(ROUNDS + 1, 'b_read_late')], reasoning: reasoning(ROUNDS + 3), usage: { input: 300_000, output: 30 } },
    { error: { status: 400, body: OVERFLOW_SMALL_GAP } },
    { text: 'SUMMARY after truncation: the later notes files were read.' },
    { text: 'the recovered answer after a truncated compaction', usage: { input: 700, output: 12 } },
  ])
  const r = await drive(ctxB, [...historyB, createUserMessage({ content: SECOND_ASK })])
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields))}`)
  check('five Responses requests: overflow · pruned retry · summariser (refused) · summariser (truncated) · reply', r.wire.length === 5, `${r.wire.length}`)
  const first = r.wire[2]
  const second = r.wire[3]
  check('both summariser requests carry the compaction prompt', first !== undefined && second !== undefined && isSummariserRequest(first.body) && isSummariserRequest(second.body))
  const firstItems = first !== undefined ? inputOf(first.body) : []
  const secondItems = second !== undefined ? inputOf(second.body) : []
  check('the truncated retry is smaller than the first summariser request', secondItems.length < firstItems.length, `${secondItems.length} vs ${firstItems.length}`)
  check('THE RULE on the first summariser request: every function_call is answered', unansweredCalls(firstItems).length === 0, `unanswered=${JSON.stringify(unansweredCalls(firstItems))}`)
  check('THE RULE on the truncated retry: every function_call is answered', unansweredCalls(secondItems).length === 0, `unanswered=${JSON.stringify(unansweredCalls(secondItems))} calls=${JSON.stringify(callIds(secondItems))} outputs=${JSON.stringify(outputIds(secondItems))}`)
  check('no call id is sent twice on the truncated retry', duplicateCalls(secondItems).length === 0, JSON.stringify(duplicateCalls(secondItems)))
  check('the reply settled last; the run minted no error row', lastAssistantText(r.yields) === 'the recovered answer after a truncated compaction' && freshErrorTexts(r.yields, historyB).length === 0, JSON.stringify(freshErrorTexts(r.yields, historyB)))
}

section('P3 with the provider\'s own input rule armed, the whole run goes through with zero refusals')
{
  const ctxC = makeCtx()
  fixture.inputRule = true
  fixture.script([
    ...historyScript('c'),
    { cut: { reasoning: reasoning(ROUNDS), text: CUT_TEXT, calls: [readCall(ROUNDS, 'c_read_cut')] } },
    { calls: [readCall(ROUNDS, 'c_read_again')], reasoning: reasoning(ROUNDS + 1) },
    { text: 'all ten notes files are read.', reasoning: reasoning(ROUNDS + 2) },
  ])
  const seedC = [createUserMessage({ content: FIRST_ASK })]
  const a = await drive(ctxC, seedC)
  const historyC = transcriptAfter(seedC, a)
  fixture.script([
    { error: { status: 400, body: OVERFLOW_SMALL_GAP } },
    { calls: [readCall(ROUNDS + 1, 'c_read_late')], reasoning: reasoning(ROUNDS + 3), usage: { input: 300_000, output: 30 } },
    { text: 'SUMMARY under the rule: the notes files were read.' },
    { text: 'the recovered answer under the rule', usage: { input: 700, output: 12 } },
  ])
  const r = await drive(ctxC, [...historyC, createUserMessage({ content: SECOND_ASK })])
  fixture.inputRule = false
  check('the history run and the compaction run both completed', a.threw === undefined && a.terminal.reason === 'completed' && r.threw === undefined && r.terminal.reason === 'completed', `history=${JSON.stringify(a.terminal)} compaction=${JSON.stringify(r.terminal)} errors=${JSON.stringify([...errorTexts(a.yields), ...errorTexts(r.yields)])}`)
  check('the provider\'s input rule refused nothing on the whole run', fixture.refusals.length === 0, JSON.stringify(fixture.refusals))
  check('the compaction landed and the reply settled last', boundaryOf(r.yields) !== undefined && lastAssistantText(r.yields) === 'the recovered answer under the rule', lastAssistantText(r.yields))
}

section('C1 a summariser refused for a malformed history — one attempt, a typed line, automatic compaction paused at once')
{
  const ctxD = makeCtx()
  fixture.script([
    ...historyScript('d'),
    { text: 'all nine notes files are read.', reasoning: reasoning(ROUNDS), usage: { input: 200_000, output: 20 } },
  ])
  const seedD = [createUserMessage({ content: FIRST_ASK })]
  const a = await drive(ctxD, seedD)
  const historyD = transcriptAfter(seedD, a)
  const seed = [...historyD, createUserMessage({ content: SECOND_ASK })]
  const count = tokenCountWithEstimation(seed as never, MODEL)
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(count - 800)
  fixture.script([
    { error: { status: 400, body: MALFORMED_HISTORY_REFUSAL } },
    { error: { status: 400, body: MALFORMED_HISTORY_REFUSAL } },
    { text: 'never reached' },
  ])
  const r = await drive(ctxD, seed)
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  const summariserRequests = r.wire.filter(w => isSummariserRequest(w.body))
  check('the run never threw', r.threw === undefined, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  check('exactly ONE summary request reached the wire — the refusal is not retried as a size problem', summariserRequests.length === 1, `${summariserRequests.length} of ${r.wire.length} requests were summary requests`)
  check('no other request reached the wire (the model is never called on a request known not to fit)', r.wire.length === 1, String(r.wire.length))
  const notices = noticeTexts(r.yields)
  const line = notices.find(t => /malformed history/i.test(t))
  check('a typed line names the class', line !== undefined, JSON.stringify(notices))
  check("…the provider's own reason", line !== undefined && line.includes('No tool output found for function call call_tlxFSxc72b7dbbq5yBsOGC7a'), line ?? '')
  check('…and the remedies: /compact after the heal, /clear, a larger-window model', line !== undefined && line.includes('/compact') && line.includes('/clear') && line.includes('/model'), line ?? '')
  check('…and the pause it applies is the run\'s, never the session\'s (the failure count starts fresh at every query entry)', line !== undefined && line.includes('paused for the rest of this run') && !/for this session/.test(line), line ?? '')
  const errs = errorTexts(r.yields)
  check('the turn ends on one typed refusal that names the breaker', errs.length === 1 && errs[0]!.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE) && /compaction has failed repeatedly/.test(errs[0]!), JSON.stringify(errs))
  check('the prune rung still answered the estimate (the notice speaks)', notices.some(t => t.startsWith('context overflowed (estimated ') && /pruned \d+ superseded tool results/.test(t)), JSON.stringify(notices))
  check("terminal blocking_limit", r.terminal.reason === 'blocking_limit', JSON.stringify(r.terminal))

  section('C2 a manual /compact after that pause still makes its request, and reports the reason and the remedies without claiming a pause')
  {
    fixture.script([{ error: { status: 400, body: MALFORMED_HISTORY_REFUSAL } }, { text: 'never reached' }])
    const before = fixture.captured.length
    ctxD.abortController = new AbortController()
    ctxD.messages = seed
    let threw: string | undefined
    try {
      await compactCommand('summarize these notes', { ...ctxD, setMessages: () => {}, onChangeAPIKey: () => {} } as never)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    const wire = fixture.captured.slice(before)
    check('the manual compaction made exactly one summary request', wire.length === 1 && isSummariserRequest(wire[0]!.body), `${wire.length} requests`)
    check('it failed with the class, the provider\'s call id and the remedies', threw !== undefined && /malformed history/i.test(threw) && threw.includes('call_tlxFSxc72b7dbbq5yBsOGC7a') && threw.includes('/compact') && threw.includes('/clear') && threw.includes('/model'), threw ?? 'no error')
    check('…and claims no pause: a manual retry stays available', threw !== undefined && !/paused/i.test(threw), threw ?? 'no error')
  }

  section('C3 a subsequent query on the same history makes one fresh attempt — the pause was the run\'s — and says so in the run\'s own scope')
  {
    process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(count - 800)
    fixture.script([
      { error: { status: 400, body: MALFORMED_HISTORY_REFUSAL } },
      { error: { status: 400, body: MALFORMED_HISTORY_REFUSAL } },
      { text: 'never reached' },
    ])
    const again = await drive(ctxD, seed)
    delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
    const summaries = again.wire.filter(w => isSummariserRequest(w.body))
    check('the subsequent query made exactly one summary request (one attempt per run, never a loop within it)', again.threw === undefined && summaries.length === 1 && again.wire.length === 1, `threw=${again.threw ?? 'no'} requests=${again.wire.length}`)
    const lineAgain = noticeTexts(again.yields).find(t => /malformed history/i.test(t))
    check('its line names the run, not the session', lineAgain !== undefined && lineAgain.includes('paused for the rest of this run') && !/for this session/.test(lineAgain), lineAgain ?? JSON.stringify(noticeTexts(again.yields)))
  }
}

section('N1 only a pairing complaint is the malformed-history class — a parameter, schema or capability refusal counts one failure and pauses nothing')
{
  const ctxN = makeCtx()
  fixture.script([
    ...historyScript('n'),
    { text: 'all nine notes files are read.', reasoning: reasoning(ROUNDS) },
  ])
  const seedN = [createUserMessage({ content: FIRST_ASK })]
  const a = await drive(ctxN, seedN)
  const historyN = [...transcriptAfter(seedN, a), createUserMessage({ content: SECOND_ASK })]
  const refusal = (message: string, extra: Record<string, unknown> = {}) => ({ error: { status: 400, body: { error: { message, type: 'invalid_request_error', param: 'input', code: null, ...extra } } } })
  const negatives: Array<{ name: string; body: ReturnType<typeof refusal> }> = [
    { name: "an unknown parameter that merely names tool_calls (Unknown parameter: 'parallel_tool_calls')", body: refusal("Unknown parameter: 'parallel_tool_calls'.", { param: 'parallel_tool_calls', code: 'unknown_parameter' }) },
    { name: "an unsupported parameter (Unsupported parameter: 'parallel_tool_calls')", body: refusal("Unsupported parameter: 'parallel_tool_calls'.", { param: 'parallel_tool_calls', code: 'unsupported_parameter' }) },
    { name: 'a schema error that names a property called tool_result', body: refusal("Invalid schema for function 'Read': In context=('properties', 'tool_result'), schema must have a 'type' key.", { param: 'tools[0].parameters', code: 'invalid_function_parameters' }) },
    { name: 'a capability refusal (This model does not support function calls)', body: refusal('This model does not support function calls.', { param: 'tools' }) },
  ]
  for (const negative of negatives) {
    fixture.script([negative.body, { text: 'never reached' }])
    const r = await compactOnce(ctxN, historyN)
    check(`${negative.name}: one summary request, one failure counted, no pause`, r.threw === undefined && r.wire.length === 1 && r.result.wasCompacted === false && r.result.consecutiveFailures === 1 && r.result.paused === undefined, `threw=${r.threw ?? 'no'} requests=${r.wire.length} result=${JSON.stringify({ consecutiveFailures: r.result.consecutiveFailures, paused: r.result.paused, refusal: String(r.result.refusal ?? '').slice(0, 120) })}`)
    check(`${negative.name}: the reason still rides the refusal, unclassified`, typeof r.result.refusal === 'string' && (r.result.refusal as string).includes(negative.body.error.body.error.message) && !/malformed history/i.test(r.result.refusal as string), String(r.result.refusal ?? ''))
  }
  fixture.script([refusal('No tool output found for function call call_tlxFSxc72b7dbbq5yBsOGC7a.'), { text: 'never reached' }])
  const positive = await compactOnce(ctxN, historyN)
  check('the pairing complaint itself: one summary request, the breaker at once, the pause', positive.threw === undefined && positive.wire.length === 1 && positive.result.consecutiveFailures === 3 && positive.result.paused === true, `threw=${positive.threw ?? 'no'} requests=${positive.wire.length} result=${JSON.stringify({ consecutiveFailures: positive.result.consecutiveFailures, paused: positive.result.paused })}`)
  check("…its line names the class and the provider's call id", typeof positive.result.refusal === 'string' && /malformed history/i.test(positive.result.refusal as string) && (positive.result.refusal as string).includes('call_tlxFSxc72b7dbbq5yBsOGC7a'), String(positive.result.refusal ?? ''))
}

section('C4 the cache-sharing path (the Anthropic wire): a pairing refusal is classified before any hand-over — one summary request, the breaker at once, the call id carried out')
{
  const ANTHROPIC_MODEL = 'claude-opus-4-8'
  const ANTHROPIC_PAIRING_REFUSAL = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: call_bad. Each `tool_use` block must have a corresponding `tool_result` block in the next message.',
    },
  }
  const ctxF = makeCtx(ANTHROPIC_MODEL)
  const historyF = textHistory(5, ANTHROPIC_MODEL)
  fixture.script([{ error: { status: 400, body: ANTHROPIC_PAIRING_REFUSAL } }, { error: { status: 400, body: ANTHROPIC_PAIRING_REFUSAL } }, { text: 'never reached' }])
  const r = await compactOnce(ctxF, historyF)
  check('exactly one summary request reached the Anthropic wire (no hand-over to the direct call)', r.threw === undefined && r.wire.length === 1 && r.wire[0]!.dialect === 'anthropic', `threw=${r.threw ?? 'no'} requests=${JSON.stringify(r.wire.map(w => w.dialect))}`)
  check('the breaker applied at once and the pause is the run\'s', r.result.consecutiveFailures === 3 && r.result.paused === true && typeof r.result.refusal === 'string' && (r.result.refusal as string).includes('paused for the rest of this run'), JSON.stringify({ consecutiveFailures: r.result.consecutiveFailures, paused: r.result.paused }))
  check("the line names the class and carries the provider's own words, the call id included", typeof r.result.refusal === 'string' && /malformed history/i.test(r.result.refusal as string) && (r.result.refusal as string).includes('call_bad') && (r.result.refusal as string).includes('without `tool_result` blocks'), String(r.result.refusal ?? ''))

  section('C5 the cache-sharing path keeps its hand-over for every other refusal: a parameter refusal goes to the direct call, counts one failure, pauses nothing')
  const ANTHROPIC_PARAMETER_REFUSAL = { type: 'error', error: { type: 'invalid_request_error', message: "Unknown parameter: 'parallel_tool_calls'." } }
  fixture.script([{ error: { status: 400, body: ANTHROPIC_PARAMETER_REFUSAL } }, { error: { status: 400, body: ANTHROPIC_PARAMETER_REFUSAL } }, { text: 'never reached' }])
  const h = await compactOnce(ctxF, historyF)
  check('two requests: the cache-sharing call, then the direct call it handed over to', h.threw === undefined && h.wire.length === 2 && h.wire.every(w => w.dialect === 'anthropic'), `threw=${h.threw ?? 'no'} requests=${JSON.stringify(h.wire.map(w => w.dialect))}`)
  check('one failure counted, no pause, the reason carried', h.result.consecutiveFailures === 1 && h.result.paused === undefined && typeof h.result.refusal === 'string' && (h.result.refusal as string).includes("Unknown parameter: 'parallel_tool_calls'") && !/malformed history/i.test(h.result.refusal as string), JSON.stringify({ consecutiveFailures: h.result.consecutiveFailures, paused: h.result.paused, refusal: String(h.result.refusal ?? '').slice(0, 120) }))
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
