#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
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
  console.log('\nTIMEOUT — the newest-message-first prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-newest-first-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'fold-newest-first-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'

const { startOverflowFixture } = await import('./overflowFixture.ts')
type Captured = import('./overflowFixture.ts').Captured
type Turn = import('./overflowFixture.ts').Turn
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

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
const prompts = await import('../../src/services/compact/prompt.ts') as Record<string, unknown>
const FLOOR = (prompts.NEWEST_MESSAGE_HAS_THE_FLOOR as string | undefined) ?? "The operator's newest message follows below"
const RESUME_WORDS = 'Carry the last task on as if the break never happened.'

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'
function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
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

const FIRST = 'FIRST-MESSAGE: my name for this session is Corvid Lantern and the code word is MARIGOLD-PANGOLIN-9.'
const QUESTION = 'What was my first message in this session? Quote it word for word.'
const BIG_ASK_HEAD = 'BIG-ASK: read this pasted log and tell me what failed'
function seed(rounds: number, replyChars: number): unknown[] {
  const out: unknown[] = [createUserMessage({ content: FIRST })]
  for (let i = 0; i < rounds; i++) {
    out.push(createUserMessage({ content: `ask ${i}: summarise notes file ${i}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000000${String(10 + i)}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: `reply ${i}: ${`notes ${i} say the station keeps its checks green\n`.repeat(Math.ceil(replyChars / 50))}` }], stop_reason: 'end_turn', stop_sequence: null },
    })
  }
  return out
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: Captured[] }
async function drive(messages: unknown[]): Promise<Drive> {
  const before = fixture.captured.length
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: messages as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never,
      toolUseContext: makeCtx() as never,
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

const rowsOf = (body: Record<string, unknown>): Array<{ role?: string; content?: unknown }> => (body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? []
const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : ''
const userTexts = (body: Record<string, unknown>): string[] => rowsOf(body).filter(r => r.role === 'user').map(r => textOf(r.content))
const textBlocksOf = (content: unknown): string[] => typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text ?? '') : []
const isSummariser = (body: Record<string, unknown>): boolean => (userTexts(body).at(-1) ?? '').includes('Produce the summary now.')
const textOfYield = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  return textOf(c) || (typeof msg.content === 'string' ? msg.content : '')
}

section('N1 a fresh operator message on a history over the threshold: the fold carries it around, the post-fold request ends on it, and the summary message gives it the floor')
{
  fixture.script((request: Captured): Turn => {
    if (isSummariser(request.body)) return { text: '<summary>\n1. Operator Intent: summarise the notes files; an opening message gave a name and a code word (not repeated here).\n2. Technical Ground: the notes.\n3. Files and Code Touched: none.\n4. Errors and Corrections: none.\n5. Problems Worked: none.\n6. Operator Messages: the opening message; eight asks.\n7. Open Work: none.\n8. Where Work Stands: the eighth notes file was summarised.\n9. Next Move (optional): summarise the next notes file.\n10. Agents in flight: none.\n</summary>' }
    const last = userTexts(request.body).at(-1) ?? ''
    if (last.trim().endsWith(QUESTION)) return { text: 'Your first message was quoted from the record.' }
    return { text: 'resumed the notes task instead', usage: { input: 600, output: 10 } }
  })
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '40000'
  const r = await drive([...seed(8, 12_000), createUserMessage({ content: QUESTION })])
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  check('the run completed', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
  const summariser = r.wire.find(w => isSummariser(w.body))
  const post = r.wire.filter(w => !isSummariser(w.body)).at(-1)
  check('exactly one summariser call, then one post-fold call', r.wire.filter(w => isSummariser(w.body)).length === 1 && r.wire.length === 2, `${r.wire.length} requests`)
  check('the summariser never saw the newest message: it is carried, not folded (red on the base: it rode inside the fold)', summariser !== undefined && !JSON.stringify(summariser.body).includes(QUESTION), summariser === undefined ? 'no summariser call' : 'the question was in the summariser request')
  const postTexts = post !== undefined ? userTexts(post.body) : []
  const lastBlocks = post !== undefined ? textBlocksOf(rowsOf(post.body).filter(r => r.role === 'user').at(-1)?.content) : []
  check('the post-fold request ENDS on the operator\'s newest message, verbatim: the last text block of the last user message, after the summary and the preserved rounds', (lastBlocks.at(-1) ?? '').trim() === QUESTION && postTexts.findIndex(t => t.includes('The context window turned over')) < postTexts.length - 1, JSON.stringify(lastBlocks.map(t => t.slice(0, 60))))
  const summaryRow = postTexts.find(t => t.includes('The context window turned over')) ?? ''
  check('the summary message says the newest message has the floor: answer it first, the task in flight only afterwards (red on the base: "carry the last task on as if the break never happened")', summaryRow.includes(FLOOR) && !summaryRow.includes(RESUME_WORDS), summaryRow.slice(-400))
  check('the opening message rides whole in the post-fold request (the operator block)', postTexts.some(t => t.includes(FIRST)))
  check('the reply answered the question, not the task', textOfYield(r.yields.filter(y => y.type === 'assistant').at(-1)) === 'Your first message was quoted from the record.', textOfYield(r.yields.filter(y => y.type === 'assistant').at(-1)))
  const boundary = r.yields.find(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary') as { compactMetadata?: { preTokens?: number; postTokens?: number } } | undefined
  check('one boundary, with its own before and after figures', boundary !== undefined && typeof boundary.compactMetadata?.preTokens === 'number' && typeof boundary.compactMetadata?.postTokens === 'number' && boundary.compactMetadata.postTokens < boundary.compactMetadata.preTokens, JSON.stringify(boundary?.compactMetadata))
}

section('N3 the decision counts the whole view: a history under the threshold plus a just-sent message that crosses the blocking limit folds at the head and answers')
{
  fixture.script((request: Captured): Turn => {
    if (isSummariser(request.body)) return { text: '<summary>\n1. Operator Intent: summarise the notes.\n2. Technical Ground: notes.\n3. Files and Code Touched: none.\n4. Errors and Corrections: none.\n5. Problems Worked: none.\n6. Operator Messages: asks.\n7. Open Work: the rest.\n8. Where Work Stands: midway.\n9. Next Move (optional): go on.\n10. Agents in flight: none.\n</summary>' }
    const last = userTexts(request.body).at(-1) ?? ''
    if (last.includes(BIG_ASK_HEAD)) return { text: 'the big ask was answered after the fold' }
    return { text: 'resumed', usage: { input: 600, output: 10 } }
  })
  const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
  const history = seed(8, 24_000)
  const bigAsk = createUserMessage({ content: `${BIG_ASK_HEAD}\n${'a pasted log line that must ride whole\n'.repeat(2_400)}` })
  const historyTokens = tokenCountWithEstimation(history as never, MODEL)
  const wholeTokens = tokenCountWithEstimation([...history, bigAsk] as never, MODEL)
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(Math.floor((historyTokens + 20_000 + wholeTokens) / 2))
  const r = await drive([...history, bigAsk])
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  const summaries = r.wire.filter(w => isSummariser(w.body))
  check('the history alone sits under the threshold and the whole view over the blocking limit (the rig)', historyTokens + 20_000 < wholeTokens, `history=${historyTokens} whole=${wholeTokens}`)
  check('the fold ran at the head and the turn answered (red before the fix: no fold tried, "the fold did not bring the conversation under the window", no model call)', r.threw === undefined && r.terminal.reason === 'completed' && summaries.length === 1 && textOfYield(r.yields.filter(y => y.type === 'assistant').at(-1)) === 'the big ask was answered after the fold', `terminal=${JSON.stringify(r.terminal)} summaries=${summaries.length} errors=${JSON.stringify(r.yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOfYield)).slice(0, 300)}`)
  const post = r.wire.filter(w => !isSummariser(w.body)).at(-1)
  const lastBlocks = post !== undefined ? textBlocksOf(rowsOf(post.body).filter(r => r.role === 'user').at(-1)?.content) : []
  check('the big ask rides whole and last in the post-fold request, outside the summariser\'s request', (lastBlocks.at(-1) ?? '').startsWith(BIG_ASK_HEAD) && summaries[0] !== undefined && !JSON.stringify(summaries[0].body).includes(BIG_ASK_HEAD), JSON.stringify(lastBlocks.map(t => t.slice(0, 40))))
}

section('N4 a lone message with no history behind it: nothing is folded (no summariser call), and over the window the refusal names the message itself')
{
  fixture.script((request: Captured): Turn => {
    if (isSummariser(request.body)) return { text: 'a summary that must never be asked for' }
    return { text: 'the lone message was answered directly', usage: { input: 600, output: 10 } }
  })
  const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
  const lone = createUserMessage({ content: `${BIG_ASK_HEAD}\n${'a pasted log line that must ride whole\n'.repeat(2_400)}` })
  const loneTokens = tokenCountWithEstimation([lone] as never, MODEL)
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(loneTokens + 10_000)
  const fits = await drive([lone])
  check('over the threshold but under the window: no summariser call, the message answered as sent', fits.threw === undefined && fits.terminal.reason === 'completed' && fits.wire.length === 1 && !isSummariser(fits.wire[0]!.body) && textOfYield(fits.yields.filter(y => y.type === 'assistant').at(-1)) === 'the lone message was answered directly', `terminal=${JSON.stringify(fits.terminal)} wire=${fits.wire.length}`)
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = String(loneTokens - 2_000)
  const over = await drive([lone])
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  const refusals = over.yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOfYield)
  check('over the window: no summariser call, the refusal says this message alone is larger than the window', over.wire.length === 0 && over.terminal.reason === 'blocking_limit' && refusals.some(t => t.includes('this message alone is larger than the window')), `wire=${over.wire.length} terminal=${JSON.stringify(over.terminal)} ${JSON.stringify(refusals).slice(0, 300)}`)
}

section('N2 a fold with no fresh operator message (the view ends in the model\'s own reply) keeps the resume words')
{
  fixture.script((request: Captured): Turn => {
    if (isSummariser(request.body)) return { text: '<summary>\n1. Operator Intent: summarise the notes.\n2. Technical Ground: notes.\n3. Files and Code Touched: none.\n4. Errors and Corrections: none.\n5. Problems Worked: none.\n6. Operator Messages: asks.\n7. Open Work: the rest.\n8. Where Work Stands: midway.\n9. Next Move (optional): go on.\n10. Agents in flight: none.\n</summary>' }
    return { text: 'carried on', usage: { input: 600, output: 10 } }
  })
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '40000'
  const history = seed(8, 12_000)
  const r = await drive([...history, createUserMessage({ content: 'go on with the notes' }), { ...(history[2] as AnyMsg), uuid: '00000000-0000-4000-a000-00000000ff01', message: { ...((history[2] as AnyMsg).message as Record<string, unknown>), id: 'msg_tail' } }])
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  const post = r.wire.filter(w => !isSummariser(w.body)).at(-1)
  const summaryRow = post !== undefined ? userTexts(post.body).find(t => t.includes('The context window turned over')) ?? '' : ''
  check('the fold happened and the summary message carries the resume words, not the floor words', r.wire.some(w => isSummariser(w.body)) && summaryRow.includes(RESUME_WORDS) && !summaryRow.includes(FLOOR), summaryRow.slice(-300))
}

await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-newest-message-first — ${failures === 0 ? `all ${checks} checks pass` : `${failures} of ${checks} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
