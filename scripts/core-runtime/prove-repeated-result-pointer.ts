#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(homeRoot, { recursive: true })
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(homeRoot, 'repeated-result-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'repeated-result-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { REPEATED_RESULT_MIN_CHARS, REPEATED_RESULT_TAG } = await import('../../src/constants/toolLimits.ts')
const { TOOL_RESULT_CLEARED_MESSAGE } = await import('../../src/utils/toolResultStorage.ts')

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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — repeated-result pointer prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

const LONG = Array.from({ length: 40 }, (_, i) => `src/lane/file-${i}.ts:${i + 1}:  const needle${i} = ${i} // the same line again and again`).join('\n')
check(`the fixture result is at least ${REPEATED_RESULT_MIN_CHARS} characters long`, LONG.length >= REPEATED_RESULT_MIN_CHARS, `${LONG.length}`)
const SHORT = 'src/a.ts:1: needle'

type ResultScript = (name: string, input: Record<string, unknown>, callIndex: number) => { text: string; error?: boolean }
let resultFor: ResultScript = () => ({ text: LONG })
let callIndex = 0

function makeTool(name: string, concurrent: boolean): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({}).catchall(z.unknown()),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => concurrent,
    isReadOnly: () => true,
    isMcp: false,
    maxResultSizeChars: 50_000,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: Record<string, unknown>) {
      const index = callIndex++
      const answer = resultFor(name, input, index)
      if (answer.error === true) throw new Error(answer.text)
      return { data: answer.text }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const TOOLS = [makeTool('Grep', true), makeTool('Bash', false), makeTool('Read', true)]

function makeCtx(): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: TOOLS,
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
  }
  return { ctx, abortController }
}

type CallRecord = { messages: unknown[] }
type Step = { name: string; input: Record<string, unknown> }
type Run = { calls: CallRecord[]; yields: AnyMsg[]; ids: string[]; terminal: Record<string, unknown> }

let idSeq = 0
function roundTurn(calls: Step[]): { turn: unknown[]; ids: string[] } {
  const ids = calls.map(() => `tu_${++idSeq}`)
  const turn = calls.map((call, i) => {
    const m = createAssistantMessage({ content: [{ type: 'tool_use', id: ids[i], name: call.name, input: call.input }] as never })
    m.message.id = `msg_round_${idSeq}`
    m.message.stop_reason = i === calls.length - 1 ? 'tool_use' : null
    return m
  })
  return { turn, ids }
}
function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

type Microcompact = (messages: unknown[]) => unknown[]
async function runScript(rounds: Step[][], results: ResultScript, prompt = 'please do the thing', microcompact: Microcompact = messages => messages): Promise<Run> {
  resultFor = results
  callIndex = 0
  const ids: string[] = []
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const round = rounds[idx]
    if (!round) {
      for (const m of textTurn('done')) yield m as never
      return
    }
    const { turn, ids: roundIds } = roundTurn(round)
    ids.push(...roundIds)
    for (const m of turn) yield m as never
  }
  const rig = makeCtx()
  const gen = query({
    messages: [createUserMessage({ content: prompt })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages: microcompact(messages) })) as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    },
  }) as AsyncGenerator<AnyMsg, Record<string, unknown>>
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value)
    r = await gen.next()
  }
  return { calls, yields, ids, terminal: r.value }
}

type ResultBlock = { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
function sentResult(run: Run, requestIndex: number, toolUseId: string): ResultBlock | undefined {
  for (const message of run.calls[requestIndex]?.messages ?? []) {
    const m = message as { type?: string; message?: { content?: unknown } }
    if (m.type !== 'user' || !Array.isArray(m.message?.content)) continue
    const block = (m.message.content as ResultBlock[]).find(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)
    if (block) return block
  }
  return undefined
}
function yieldedResult(run: Run, toolUseId: string): { block: ResultBlock | undefined; toolUseResult: unknown } {
  for (const m of run.yields) {
    if (m.type !== 'user') continue
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    const block = (content as ResultBlock[]).find(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)
    if (block) return { block, toolUseResult: (m as { toolUseResult?: unknown }).toolUseResult }
  }
  return { block: undefined, toolUseResult: undefined }
}
function requestText(run: Run, index: number): string {
  return JSON.stringify(run.calls[index]?.messages ?? [])
}
function pointerFile(text: string): string | null {
  const match = /kept at (\S+)\.$/.exec(text)
  return match ? match[1]! : null
}

const GREP = { pattern: 'needle', path: '/tmp/haystack' }
const grep: Step = { name: 'Grep', input: GREP }

section('A — the same Grep twice, one per round, byte-identical answers: the second result is a pointer to the first, the transcript keeps the real text')
{
  const run = await runScript([[grep], [grep]], () => ({ text: LONG }))
  const [first, second] = run.ids
  const firstSent = sentResult(run, 1, first!)
  const secondSent = sentResult(run, 2, second!)
  check('the turn completed with three model calls', run.terminal.reason === 'completed' && run.calls.length === 3, `${run.calls.length} ${JSON.stringify(run.terminal)}`)
  check('the first result reaches the model whole', firstSent?.content === LONG, String(firstSent?.content).slice(0, 120))
  const pointer = String(secondSent?.content ?? '')
  check(`the second result is the pointer (starts with "${REPEATED_RESULT_TAG}")`, pointer.startsWith(REPEATED_RESULT_TAG), pointer.slice(0, 200))
  check('the pointer names the earlier call by its id and the exact length', pointer.includes(`call ${first}`) && pointer.includes(`${LONG.length} characters`), pointer)
  check('the pointer names the tool and previews the arguments by address and shape, never value', pointer.includes('this Grep call') && pointer.includes('"path": "/tmp/haystack"') && pointer.includes('"pattern": <6 chars>') && !pointer.includes('needle"'), pointer)
  check('the pointer is short beside the text it replaces', pointer.length < LONG.length / 2, `${pointer.length} vs ${LONG.length}`)
  check('the pointer is not an error result', secondSent?.is_error !== true)
  const kept = pointerFile(pointer)
  check('the pointer names a file that holds the whole text', kept !== null && existsSync(kept) && readFileSync(kept, 'utf8') === LONG, `${kept}`)
  const yielded = yieldedResult(run, second!)
  check('the yielded transcript row keeps the real result as its toolUseResult (the screen renders the real text)', yielded.toolUseResult === LONG, String(yielded.toolUseResult).slice(0, 80))
  check('the first request still carried the whole first result in the second request too (nothing rewritten behind the model)', sentResult(run, 2, first!)?.content === LONG)
}

section('B — the same call whose answer changed between the rounds: both results reach the model whole')
{
  const run = await runScript([[grep], [grep]], (_n, _i, index) => ({ text: index === 0 ? LONG : LONG.replace('needle0', 'needle0 changed') }))
  const [first, second] = run.ids
  check('the first result is whole', sentResult(run, 1, first!)?.content === LONG)
  const secondText = String(sentResult(run, 2, second!)?.content)
  check('the second (different) result is whole, no pointer', secondText.includes('needle0 changed') && !secondText.startsWith(REPEATED_RESULT_TAG), secondText.slice(0, 120))
}

section('C — a short repeated result stays whole (the pointer is for results of at least the floor)')
{
  const run = await runScript([[grep], [grep]], () => ({ text: SHORT }))
  const [first, second] = run.ids
  check('both short results reach the model whole', sentResult(run, 1, first!)?.content === SHORT && sentResult(run, 2, second!)?.content === SHORT, String(sentResult(run, 2, second!)?.content))
}

section('D — different arguments with the same answer: no pointer (the pointer is for the same call)')
{
  const other: Step = { name: 'Grep', input: { pattern: 'needle', path: '/tmp/other' } }
  const run = await runScript([[grep], [other]], () => ({ text: LONG }))
  const [, second] = run.ids
  check('the second call, with other arguments, is answered whole', sentResult(run, 2, second!)?.content === LONG, String(sentResult(run, 2, second!)?.content).slice(0, 120))
}

section('E — two identical calls in ONE parallel round: the later of the two is the pointer to the earlier, both in the same request')
{
  const run = await runScript([[grep, grep]], () => ({ text: LONG }))
  const [a, b] = run.ids
  const aSent = sentResult(run, 1, a!)
  const bSent = sentResult(run, 1, b!)
  const texts = [String(aSent?.content), String(bSent?.content)]
  const whole = texts.filter(t => t === LONG).length
  const pointers = texts.filter(t => t.startsWith(REPEATED_RESULT_TAG))
  check('exactly one of the two is whole and the other is the pointer', whole === 1 && pointers.length === 1, texts.map(t => t.slice(0, 60)).join(' | '))
  const pointedAt = pointers[0]?.includes(`call ${a}`) ? a : pointers[0]?.includes(`call ${b}`) ? b : null
  check('the pointer names the call whose result went whole', pointedAt !== null && String(sentResult(run, 1, pointedAt)?.content) === LONG, pointers[0])
}

section('F — the earlier result is no longer whole in the model\'s view (pruned to the cleared placeholder): the repeat goes whole again and becomes the new reference')
{
  const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
  resultFor = () => ({ text: LONG })
  const rig = makeCtx()
  const prompt = createUserMessage({ content: 'a turn whose view is shaped by hand' })
  const parent = createAssistantMessage({ content: 'calling' })
  const one = async (id: string, view: unknown[]): Promise<string> => {
    const ctx = { ...rig.ctx, messages: view }
    let text = ''
    for await (const update of runToolUse({ type: 'tool_use', id, name: 'Grep', input: GREP } as never, parent as never, allowAll as never, ctx as never)) {
      const content = (update as { message?: { message?: { content?: unknown } } }).message?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as ResultBlock[]) if (block.type === 'tool_result' && block.tool_use_id === id) text = String(block.content)
    }
    return text
  }
  const callRow = (id: string) => createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Grep', input: GREP }] as never })
  const resultRow = (id: string, content: string) => createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content }] as never })
  const first = await one('tu_view_1', [prompt])
  check('the first call goes whole', first === LONG)
  const second = await one('tu_view_2', [prompt, callRow('tu_view_1'), resultRow('tu_view_1', TOOL_RESULT_CLEARED_MESSAGE)])
  check('the second call, its reference pruned from the view, is answered whole again', second === LONG, second.slice(0, 160))
  const third = await one('tu_view_3', [prompt, callRow('tu_view_1'), resultRow('tu_view_1', TOOL_RESULT_CLEARED_MESSAGE), callRow('tu_view_2'), resultRow('tu_view_2', LONG)])
  check('the third call points at the SECOND (the new reference), not the pruned first', third.startsWith(REPEATED_RESULT_TAG) && third.includes('call tu_view_2') && !third.includes('call tu_view_1'), third.slice(0, 200))
  const fourth = await one('tu_view_4', [prompt, callRow('tu_view_2'), resultRow('tu_view_2', LONG.slice(0, 1000))])
  check('a reference whose bytes moved in the view (a different content) is no reference: the call is answered whole', fourth === LONG, fourth.slice(0, 160))
}

section('G — a repeated error result stays loud: an error is never replaced by a pointer')
{
  const run = await runScript([[grep], [grep]], () => ({ text: LONG, error: true }))
  const [first, second] = run.ids
  const firstSent = sentResult(run, 1, first!)
  const secondSent = sentResult(run, 2, second!)
  check('both error results carry the error text whole', firstSent?.is_error === true && secondSent?.is_error === true && String(secondSent?.content).includes('needle39') && !String(secondSent?.content).startsWith(REPEATED_RESULT_TAG), String(secondSent?.content).slice(0, 120))
}

section('H — the loop guard\'s own cadence is unchanged: the third identical call still draws the "third identical tool call" reminder')
{
  const run = await runScript([[grep], [grep], [grep]], () => ({ text: LONG }))
  const [, second, third] = run.ids
  check('the second and third results are pointers', String(sentResult(run, 2, second!)?.content).startsWith(REPEATED_RESULT_TAG) && String(sentResult(run, 3, third!)?.content).startsWith(REPEATED_RESULT_TAG))
  check('the reminder rides in the request after the third call, as before', requestText(run, 3).includes('this is the third identical tool call') && !requestText(run, 2).includes('third identical tool call'), requestText(run, 3).slice(-400))
}

section('I — a new operator turn starts the ledger afresh: the same call in a new turn is answered whole')
{
  const run = await runScript([[grep]], () => ({ text: LONG }), 'a new ask from the operator')
  const [only] = run.ids
  check('the first call of the new turn goes whole', sentResult(run, 1, only!)?.content === LONG, String(sentResult(run, 1, only!)?.content).slice(0, 120))
}

section('J — a tool that is not concurrency-safe takes the same law: two identical Bash calls, the second is the pointer')
{
  const bash: Step = { name: 'Bash', input: { command: 'ls -la /tmp/haystack' } }
  const run = await runScript([[bash], [bash]], () => ({ text: LONG }))
  const [first, second] = run.ids
  const text = String(sentResult(run, 2, second!)?.content)
  check('the second Bash result is the pointer to the first', text.startsWith(REPEATED_RESULT_TAG) && text.includes(`call ${first}`) && text.includes('this Bash call'), text.slice(0, 200))
}

section('refusals — the three stub readers (compact, microcompact, queryHelpers) and the 128-entry ledger cap')
{
  const { restorePreservedReads } = await import('../../src/services/compact/compact.ts')
  const { projectTimeBasedMicrocompact } = await import('../../src/services/compact/microCompact.ts')
  const { isClearedOrDigested } = await import('../../src/services/compact/microCompactDigest.ts')
  const { extractReadFilesFromMessages } = await import('../../src/utils/queryHelpers.ts')
  const { repeatedResultPointer } = await import('../../src/services/tools/loopGuard.ts')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
  const pointerText = `${REPEATED_RESULT_TAG} this Read call ({"file_path":"/work/a.ts"}) returned exactly the same ${LONG.length} characters as call tu_r1 earlier in this turn, so the text is not repeated here. Reread that result — it is unchanged.`
  const readUse = (id: string, file_path: string) => createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path } }] as never })
  const readRes = (tool_use_id: string, content: string, timestamp = '2026-10-17T12:00:00.000Z') => ({ ...(createUserMessage({ content: [{ type: 'tool_result', tool_use_id, content }] as never }) as Record<string, unknown>), timestamp })
  const cache = extractReadFilesFromMessages([readUse('tu_r1', '/work/a.ts'), readRes('tu_r1', '1\tconst real = 1'), readUse('tu_r2', '/work/a.ts'), readRes('tu_r2', pointerText, '2026-10-17T12:01:00.000Z')] as never, '/work')
  check('queryHelpers: a pointer result on resume never overwrites the real read in the file-state cache', cache.get('/work/a.ts')?.content === 'const real = 1', JSON.stringify(cache.get('/work/a.ts')))
  const foldCache = createFileStateCacheWithSizeLimit(10)
  const restored = restorePreservedReads({ readFileState: foldCache } as never, [['/work/a.ts', { content: 'const real = 1', timestamp: 100, offset: 0, limit: undefined }]], [readUse('tu_r2', '/work/a.ts'), readRes('tu_r2', pointerText)] as never)
  check('compact: a Read answered only by a pointer in the preserved tail is treated as a stub so re-attachment re-injects the file', restored.length === 0 && foldCache.get('/work/a.ts') === undefined, JSON.stringify(restored))
  const big = 'the complete original result remains available in the model view\n'.repeat(800)
  const mcHistory: unknown[] = [createUserMessage({ content: 'keep' }), readUse('tu_mc_1', '/work/a.ts'), readRes('tu_mc_1', big), readUse('tu_mc_2', '/work/a.ts'), readRes('tu_mc_2', pointerText)]
  for (let i = 0; i < 6; i++) {
    mcHistory.push(readUse(`tu_mc_tail_${i}`, `/work/other-${i}.ts`), readRes(`tu_mc_tail_${i}`, big))
  }
  const pruned = projectTimeBasedMicrocompact(mcHistory as never, 'sdk', { pressure: true, supersededOnly: true })
  const firstAfterPrune = pruned?.messages.flatMap(m => (m.type === 'user' && Array.isArray(m.message.content) ? m.message.content : [])).find((b: { type?: string; tool_use_id?: string }) => b.type === 'tool_result' && b.tool_use_id === 'tu_mc_1') as { content?: unknown } | undefined
  check('microCompact: a pointer never supersedes the earlier whole Read, so the reference is not pruned out from under the pointer', pruned === null || !isClearedOrDigested(firstAfterPrune?.content as never), String(firstAfterPrune?.content).slice(0, 120))
  const boundary = createUserMessage({ content: 'cap probe turn' })
  const view: unknown[] = [boundary]
  for (let i = 0; i < 130; i++) {
    const id = `tu_cap_${i}`
    const arg = { pattern: `needle_${i}`, path: '/tmp/haystack' }
    const block = { type: 'tool_result' as const, tool_use_id: id, content: `${LONG}\n// ${i}` }
    const ans = await repeatedResultPointer(processMainOwner(), { toolName: 'Grep', toolUseID: id, roundID: `r_${i}`, arguments: arg, result: block, messages: view })
    if (i === 0) check('ledger cap: entry 0 starts whole', ans === null)
    view.push(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Grep', input: arg }] as never }), createUserMessage({ content: [block] as never }))
  }
  const evicted = await repeatedResultPointer(processMainOwner(), { toolName: 'Grep', toolUseID: 'tu_cap_0_again', roundID: 'r_after', arguments: { pattern: 'needle_0', path: '/tmp/haystack' }, result: { type: 'tool_result', tool_use_id: 'tu_cap_0_again', content: `${LONG}\n// 0` }, messages: view })
  const retained = await repeatedResultPointer(processMainOwner(), { toolName: 'Grep', toolUseID: 'tu_cap_129_again', roundID: 'r_after', arguments: { pattern: 'needle_129', path: '/tmp/haystack' }, result: { type: 'tool_result', tool_use_id: 'tu_cap_129_again', content: `${LONG}\n// 129` }, messages: view })
  check('ledger cap: the 128-entry FIFO evicts entry 0 (answered whole again) while keeping entry 129 (answered with a pointer)', evicted === null && retained !== null && retained.startsWith(REPEATED_RESULT_TAG), `evicted=${String(evicted)} retained=${String(retained).slice(0, 80)}`)
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`REPEATED-RESULT-POINTER: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`REPEATED-RESULT-POINTER: all ${checks} checks passed`)
process.exit(0)
