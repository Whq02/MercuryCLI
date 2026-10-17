#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'result-room-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'result-room-daemon-'))
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_TIME_BASED_MC', 'NODE_ENV', 'MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_CTX_COMPACTION', 'MERCURY_COMPACT_KEEP_TAIL']) delete process.env[k]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { getBlockingLimit, getAutoCompactThreshold, resolveAutoCompactWindow } = await import('../../src/services/compact/autoCompact.ts')
const roomModule = await import('../../src/services/run/resultRoom.ts').catch(() => null)
const RESULT_ROOM_WORDS: string = roomModule?.RESULT_ROOM_WORDS ?? 'the context is near its fold'
const RESULT_ROOM_TURN_CEILING_TOKENS: number = roomModule?.RESULT_ROOM_TURN_CEILING_TOKENS ?? 60_000
const absent = { awake: false as const, line: -1, gauge: -1 }
const resultRoomBudget: NonNullable<typeof roomModule>['resultRoomBudget'] = roomModule?.resultRoomBudget ?? (() => absent)
const createResultRoom: NonNullable<typeof roomModule>['createResultRoom'] = roomModule?.createResultRoom ?? (budget => ({ budget, remaining: () => -1, reserve: () => -1, allowance: () => -1, settle: () => {}, takes: () => [] }))
if (roomModule === null) console.log('  [record] the result-room module is absent on this tree: every limiter check below reads red by construction')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
type AnyMsg = Record<string, unknown> & { type?: string }
type AnyEvent = Record<string, unknown> & { kind: string }
const MODEL = 'claude-fable-5-1'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the result-room limiter prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()
const fmt = (n: number): string => n.toLocaleString('en-US')

const WINDOW = resolveAutoCompactWindow(MODEL).window
const BLOCKING = getBlockingLimit(MODEL)
const THRESHOLD = getAutoCompactThreshold(MODEL)

section('L1 the arithmetic: the line is the fold threshold or 80% of the window, whichever is lower; under it the limiter is inert; past it a round shares a ceiling that shrinks with the room')
{
  const argon = { window: 1_048_576, blockingLimit: 1_025_576, foldLine: 1_005_576 }
  const under = resultRoomBudget({ ...argon, gauge: 629_145 })
  check('a 1,048,576 window: 60% used is under the line (838,860) — inert', under.awake === false && under.line === 838_860, JSON.stringify(under))
  check('…and so is 838,859', resultRoomBudget({ ...argon, gauge: 838_859 }).awake === false)
  const atLine = resultRoomBudget({ ...argon, gauge: 838_860 })
  check('at the line the round\'s ceiling is the 60,000-token turn ceiling (the room is wider)', atLine.awake === true && atLine.ceiling === RESULT_ROOM_TURN_CEILING_TOKENS && atLine.room === 186_716 && atLine.floor === 4_000, JSON.stringify(atLine))
  const near = resultRoomBudget({ ...argon, gauge: 1_000_000 })
  check('at 1,000,000 the ceiling is the room to the blocking limit (25,576)', near.awake === true && near.ceiling === 25_576, JSON.stringify(near))
  const past = resultRoomBudget({ ...argon, gauge: 1_030_000 })
  check('past the blocking limit the ceiling is the floor (4,000): a result is never cut to nothing', past.awake === true && past.room === 0 && past.ceiling === 4_000, JSON.stringify(past))
  const small = { window: 32_768, blockingLimit: 21_576, foldLine: 5_394 }
  const smallUnder = resultRoomBudget({ ...small, gauge: 5_000 })
  check('a 32,768 window: the fold line (5,394) is lower than 80% (26,214) — the line is the fold line, inert under it', smallUnder.awake === false && smallUnder.line === 5_394, JSON.stringify(smallUnder))
  const smallOn = resultRoomBudget({ ...small, gauge: 9_000 })
  check('…past it the ceiling is the room (12,576) and the floor a window-scaled 2,697', smallOn.awake === true && smallOn.ceiling === 12_576 && smallOn.floor === 2_697, JSON.stringify(smallOn))
  const two = { window: 200_000, blockingLimit: 177_000, foldLine: 157_000 }
  check('a 200,000 window: the fold line (157,000) sits under 80% (160,000) — the limiter wakes with the fold line itself', resultRoomBudget({ ...two, gauge: 156_999 }).awake === false && resultRoomBudget({ ...two, gauge: 157_000 }).awake === true && resultRoomBudget({ ...two, gauge: 157_000 }).line === 157_000)
  const room = createResultRoom({ awake: true, line: 0, gauge: 0, room: 30_000, ceiling: 30_000, floor: 4_000 })
  const a = room.reserve('a', 25_000)
  const b = room.reserve('b', 25_000)
  const c = room.reserve('c', 25_000)
  check('parallel reserves share one ceiling: 25,000 then the 5,000 left, then the floor', a === 25_000 && b === 5_000 && c === 4_000, `${a} ${b} ${c}`)
  room.settle('a', 10_000)
  check('a result that landed smaller than its grant gives the difference back', room.remaining() === 15_000, String(room.remaining()))
  check('an unreserved call is offered what is left, never under the floor', room.allowance('d') === 15_000 && createResultRoom({ awake: true, line: 0, gauge: 0, room: 0, ceiling: 4_000, floor: 4_000 }).allowance('x') === 4_000)
}

const files = mkdtempSync(join(tmpdir(), 'result-room-files-'))
function sourceFile(name: string, lines: number): string {
  const path = join(files, name)
  const body = Array.from({ length: lines }, (_, i) => `export const row${i} = compute(${i}, 'the ${name} module keeps a line of ordinary source text here')`).join('\n') + '\n'
  writeFileSync(path, body)
  return path
}
const big = [0, 1, 2, 3, 4].map(i => sourceFile(`module-${i}.ts`, 900))
const haystack = sourceFile('haystack.ts', 900)

const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  return ''
}
let seq = 0
function asstTools(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>, inputTokens: number): unknown {
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`,
    timestamp: new Date().toISOString(),
    requestId: `req_${seq}`,
    message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: MODEL, content: calls.map(call => ({ type: 'tool_use', ...call })), stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }
}
function asstText(text: string, inputTokens: number): unknown {
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`,
    timestamp: new Date().toISOString(),
    requestId: `req_${seq}`,
    message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }
}
const ping = (): unknown => ({ type: 'stream_event', event: { type: 'ping' } })
type CallRecord = { messages: unknown[] }
function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: (req: never) => AsyncGenerator<never, void> } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel: callModel as never }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [FileReadTool, BashTool, GrepTool],
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
    contentReplacementState: createContentReplacementState(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}
type Run = { events: AnyEvent[]; yields: AnyMsg[]; terminal: Record<string, unknown>; calls: CallRecord[]; ctx: Record<string, unknown> }
async function run(script: unknown[][]): Promise<Run> {
  const ctx = makeCtx()
  const { calls, callModel } = makeModel(script)
  const gen = queryEvents({
    messages: [createUserMessage({ content: 'read the modules and report' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    } as never,
  })
  const events: AnyEvent[] = []
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    const ev = r.value as unknown as AnyEvent
    events.push(ev)
    for (const y of legacyYieldsOf(ev as never)) yields.push(y as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { events, yields, terminal: r.value as Record<string, unknown>, calls, ctx }
}
const resultsOf = (yields: AnyMsg[]): Array<{ id: string; text: string }> => {
  const out: Array<{ id: string; text: string }> = []
  for (const m of yields) {
    if (m.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as AnyMsg[]) if (b.type === 'tool_result') out.push({ id: String(b.tool_use_id), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') })
  }
  return out
}
const reads = big.map((path, i) => ({ id: `toolu_read_${i}`, name: 'Read', input: { file_path: path } }))

section(`L2 past the line (the context at ${fmt(900_000)} of ${fmt(WINDOW)}; fold line ${fmt(THRESHOLD)}, blocking limit ${fmt(BLOCKING)}): five parallel reads of 20k-token files come back as first chunks with the paging note, sharing one ceiling`)
{
  const r = await run([[ping(), asstTools(reads, 900_000)], [ping(), asstText('the report', 960_000)]])
  const results = resultsOf(r.yields)
  const total = results.reduce((sum, result) => sum + Math.ceil(result.text.length / 4), 0)
  record(`${results.length} results landed ${fmt(total)} tokens in all (unclamped they would land ${fmt(big.length * Math.ceil(Buffer.byteLength(require('node:fs').readFileSync(big[0]!, 'utf8')) / 4))}); terminal ${JSON.stringify(r.terminal)}`)
  check('the run completed with the five results and the report', r.terminal.reason === 'completed' && results.length === 5 && textOf(r.yields.filter(y => y.type === 'assistant').at(-1)) === 'the report', JSON.stringify(r.terminal))
  check(`the round added no more than the turn ceiling plus the floors (${fmt(RESULT_ROOM_TURN_CEILING_TOKENS)} + 3 × 4,000): red on the base, where five reads land 5 × 20k`, total <= RESULT_ROOM_TURN_CEILING_TOKENS + 3 * 4_000 && total < 100_000, fmt(total))
  const clamped = results.filter(result => result.text.includes(`${RESULT_ROOM_WORDS}; read in pieces`))
  check('the reads that did not fit their share came back as the file\'s first chunk with the paging note naming the fold and the next Read(offset, limit)', clamped.length >= 3 && clamped.every(result => /exceeds the room left in the context \(\d+ tokens — the context is near its fold; read in pieces\): lines 1-\d+ of 900 are below and count as read; Read\(offset: \d+, limit: \d+\) continues from there/.test(result.text) && result.text.includes('export const row0 =')), `${clamped.length} clamped · ${results[4]?.text.slice(0, 300)}`)
  const whole = results.filter(result => !result.text.includes(RESULT_ROOM_WORDS) && result.text.includes('row899'))
  check('two reads got their whole 25,000-token cap (the 60,000 ceiling had room for two), the third the 10,000 left, the last two the 4,000 floor', whole.length === 2 && clamped.length === 3 && clamped.filter(result => result.text.includes('(10000 tokens')).length === 1 && clamped.filter(result => result.text.includes('(4000 tokens')).length === 2, `${whole.length} whole · ${clamped.map(result => /\((\d+) tokens/.exec(result.text)?.[1]).join(',')}`)
  check('the next request carried the clamped results, not the whole files', r.calls.length === 2 && JSON.stringify(r.calls[1]!.messages).includes(RESULT_ROOM_WORDS), String(r.calls.length))
}

section(`L3 at the floor (the context at ${fmt(974_000)}, 3,000 under the blocking limit): a shell output and a search under their own caps are persisted with the cut named; the floor keeps a head and a tail`)
{
  const grepRowChars = `${haystack}:450:export const row449 = compute(449, 'the haystack.ts module keeps a line of ordinary source text here')\n`.length
  const grepRows = Math.round(18_000 / grepRowChars)
  const r = await run([
    [ping(), asstTools([{ id: 'toolu_bash_0', name: 'Bash', input: { command: `cat "${haystack}" | head -c 24000`, description: 'print a slice of the haystack' } }, { id: 'toolu_grep_0', name: 'Grep', input: { pattern: 'export const row', path: haystack, output_mode: 'content', head_limit: grepRows } }], 974_000)],
    [ping(), asstText('the report', 979_000)],
  ])
  const results = resultsOf(r.yields)
  const bash = results.find(result => result.id === 'toolu_bash_0')
  const grep = results.find(result => result.id === 'toolu_grep_0')
  record(`bash result ${fmt(bash?.text.length ?? 0)} chars; grep result ${fmt(grep?.text.length ?? 0)} chars from ${grepRows} rows of ≈${grepRowChars} chars (${JSON.stringify(grep?.text.slice(0, 160))}); terminal ${JSON.stringify(r.terminal)}`)
  check('the run completed', r.terminal.reason === 'completed' && bash !== undefined && grep !== undefined, JSON.stringify(r.terminal))
  check('the shell output (24,000 chars, under Bash\'s own 30,000-char cap) was persisted to disk with the cut named: a head, a tail, the path and the fold\'s words', bash !== undefined && bash.text.startsWith('<persisted-output>') && bash.text.includes(`(${RESULT_ROOM_WORDS})`) && bash.text.includes('Full output saved to:') && bash.text.includes('row0 =') && bash.text.includes('skipped — full output persisted'), bash?.text.slice(0, 400))
  check('the search (under Grep\'s own 20,000-char cap) was capped the same way, its rows persisted', grep !== undefined && grep.text.startsWith('<persisted-output>') && grep.text.includes(`(${RESULT_ROOM_WORDS})`), grep?.text.slice(0, 400))
  const total = results.reduce((sum, result) => sum + Math.ceil(result.text.length / 4), 0)
  check('the round landed within the floors (two results, each a few thousand tokens at most)', total <= 2 * 4_000, fmt(total))
}

section(`L4 under the line (the context at ${fmt(600_000)}): nothing is touched — every read lands whole, no note, no paging, the same bytes as a read at 10%`)
{
  const quiet = await run([[ping(), asstTools(reads, 600_000)], [ping(), asstText('the report', 700_000)]])
  const low = await run([[ping(), asstTools(reads, 100_000)], [ping(), asstText('the report', 200_000)]])
  const quietResults = resultsOf(quiet.yields)
  const lowResults = resultsOf(low.yields)
  check('both runs completed with five results', quiet.terminal.reason === 'completed' && low.terminal.reason === 'completed' && quietResults.length === 5 && lowResults.length === 5)
  const byId = (results: Array<{ id: string; text: string }>): Map<string, string> => new Map(results.map(result => [result.id, result.text]))
  const lowById = byId(lowResults)
  const withoutReminder = (text: string): string => text.replace(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>\n?/, '')
  const differing = quietResults.filter(result => withoutReminder(result.text) !== withoutReminder(lowById.get(result.id) ?? ''))
  check('at 60% every result is byte-identical to the 10% run (matched by call id; the one standing cyber-risk reminder rides whichever parallel read lands first, in both runs)', differing.length === 0, differing.map(result => result.id).join(','))
  check('no result carries the fold\'s words, a paging note or a persisted-output tag', quietResults.every(result => !result.text.includes(RESULT_ROOM_WORDS) && !result.text.includes('continues from there') && !result.text.startsWith('<persisted-output>')), quietResults.map(result => result.text.slice(0, 80)).join(' | '))
  check('every read carries the whole file (row 0 to row 899)', quietResults.every(result => result.text.includes('row0 =') && result.text.includes('row899 =')))
  const gauge = tokenCountWithEstimation([createUserMessage({ content: 'x' }), asstTools(reads, 600_000)] as never, MODEL)
  check(`the gauge the limiter read was ${fmt(gauge)} — the calibrated figure, under the line at ${fmt(resultRoomBudget({ window: WINDOW, blockingLimit: BLOCKING, foldLine: THRESHOLD, gauge }).line)}`, resultRoomBudget({ window: WINDOW, blockingLimit: BLOCKING, foldLine: THRESHOLD, gauge }).awake === false)
}

section(`L5 one clamp per result (the context at ${fmt(900_000)}): a room-paged read arrives whole — consecutive numbered lines, nothing cut from the middle — and the lines recorded as read are the lines the model got`)
{
  const r = await run([[ping(), asstTools(reads, 900_000)], [ping(), asstText('the report', 960_000)]])
  const results = resultsOf(r.yields)
  const clamped = results.filter(result => result.text.includes(`${RESULT_ROOM_WORDS}; read in pieces`))
  const state = r.ctx.readFileState as { get(path: string): { content: string; offset?: number; limit?: number } | undefined }
  const faults: string[] = []
  const shares: Array<{ id: string; tokens: number; granted: number }> = []
  for (const result of clamped) {
    const numbered = result.text.split('\n').map(line => /^(\d+)\t(.*)$/.exec(line)).filter((m): m is RegExpExecArray => m !== null)
    const numbers = numbered.map(m => Number(m[1]))
    const consecutive = numbers.length > 0 && numbers.every((n, i) => i === 0 || n === (numbers[i - 1] ?? 0) + 1)
    const cut = result.text.includes('characters cut')
    const path = String(reads.find(read => read.id === result.id)?.input.file_path)
    const entry = state.get(path)
    const recorded = entry === undefined ? [] : entry.content.replace(/\n$/, '').split('\n')
    const modelLines = numbered.map(m => m[2] ?? '')
    const same = entry !== undefined && entry.offset === numbers[0] && entry.limit === numbers.length && recorded.length === modelLines.length && recorded.every((line, i) => line === modelLines[i])
    const span = /lines 1-(\d+) of 900 are below/.exec(result.text)
    const noteMatches = span !== null && Number(span[1]) === numbers.length
    const granted = Number(/in the context \((\d+) tokens/.exec(result.text)?.[1])
    shares.push({ id: result.id, tokens: Math.ceil(result.text.length / 4), granted })
    if (!consecutive || cut || !same || !noteMatches) faults.push(`${result.id}: consecutive ${consecutive}, cut ${cut}, recorded-equals-shown ${same} (recorded ${entry?.offset}+${entry?.limit} vs shown ${numbers[0]}..${numbers.at(-1)}), note ${noteMatches}`)
  }
  record(`${clamped.length} room-paged reads; shares ${shares.map(share => `${share.id} ${fmt(share.tokens)} of ${fmt(share.granted)}`).join(' · ')}`)
  check('every room-paged read carries consecutive numbered lines with nothing cut from the middle (red on 41304f7c53: a second clamp at emission cut hundreds of characters out of the middle of the paged window)', clamped.length >= 3 && faults.every(fault => !/consecutive false|cut true/.test(fault)), faults.join(' | '))
  check('the lines recorded as read, and the paging note\'s span, are exactly the lines the model got', faults.length === 0, faults.join(' | '))
  check('each paged result lands within its granted share, its wrapper included', shares.every(share => share.tokens <= share.granted), JSON.stringify(shares))
}

section(`L6 a read that fails takes no share (the context at ${fmt(900_000)}): five parallel reads, one of a file that does not exist — the four that land share the whole ceiling`)
{
  const missing = join(files, 'no-such-module.ts')
  const calls = [{ id: 'toolu_missing', name: 'Read', input: { file_path: missing } }, ...reads.slice(0, 4)]
  const r = await run([[ping(), asstTools(calls, 900_000)], [ping(), asstText('the report', 960_000)]])
  const results = resultsOf(r.yields)
  const failed = results.find(result => result.id === 'toolu_missing')
  const grants = results.filter(result => result.id !== 'toolu_missing').map(result => (result.text.includes(RESULT_ROOM_WORDS) ? Number(/in the context \((\d+) tokens/.exec(result.text)?.[1]) : 25_000)).sort((a, b) => b - a)
  record(`the missing file: ${JSON.stringify(failed?.text.slice(0, 120))}; the four reads were granted ${grants.map(fmt).join(', ')}; terminal ${JSON.stringify(r.terminal)}`)
  check('the missing file came back as its own error result and the run completed with the four others', r.terminal.reason === 'completed' && failed !== undefined && !failed.text.includes('row0 =') && results.length === 5, JSON.stringify(r.terminal))
  check('the four reads that landed shared the whole ceiling — 25,000, 25,000, 10,000, 4,000 (red on 41304f7c53: 25,000, 10,000, 4,000, 4,000 — the failed read held a 25,000 share it never used)', JSON.stringify(grants) === JSON.stringify([25_000, 25_000, 10_000, 4_000]), grants.join(','))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-result-room-limiter — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
