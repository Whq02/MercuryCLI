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
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { MC_DIGEST_PREFIX, MC_CLEARED_PLACEHOLDER } = await import('../../src/services/compact/microCompactDigest.ts')

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

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [FileReadTool],
      mainLoopModel: MODEL,
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
  const persistedTurnId = 'openai_persisted_before_the_law'
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

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
