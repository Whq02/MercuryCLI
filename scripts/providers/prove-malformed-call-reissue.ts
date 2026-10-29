#!/usr/bin/env bun
// gate-watch: src/services/providers/toolCallGate.ts src/run-core/turn-machine.ts src/tools/MemoryTools/MemoryTools.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'malformed-reissue-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'malformed-reissue-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV']) delete process.env[k]

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const gate = await import('../../src/services/providers/toolCallGate.ts')
type GateExtras = { refusedFactTexts?: (refusal: RefusedToolCall) => string[]; executedCallAnswersRefusal?: (refusal: RefusedToolCall, call: { name: string; input: unknown }) => boolean }
const extras = gate as unknown as GateExtras
const factTexts = (refusal: RefusedToolCall): string[] => (typeof extras.refusedFactTexts === 'function' ? extras.refusedFactTexts(refusal) : [])
const answers = (refusal: RefusedToolCall, call: { name: string; input: unknown }): boolean => (typeof extras.executedCallAnswersRefusal === 'function' ? extras.executedCallAnswersRefusal(refusal, call) : false)
const { RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
type RefusedToolCall = import('../../src/types/message.ts').RefusedToolCall

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — malformed-call re-issue prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'
const FACT_BELL = 'Gus rings the lighthouse bell at dawn'
const FACT_TEA = 'The tea is brewed at 80 degrees, never boiling'
const bell = (tag: string): string => `${FACT_BELL} (${tag})`
const tea = (tag: string): string => `${FACT_TEA} (${tag})`
const glmBad = (fact: string): string => `{"items":[{"content":"${fact}","tags":["bell","gus"]}]}`
const glmCut = (fact: string): string => `{"items":[{"content":"${fact}","context":"the user said remember`
const GLM_BAD_BELL = glmBad(FACT_BELL)
const GLM_CUT_BELL = glmCut(FACT_BELL)
const LOST_LINE = 'the remember did not happen — say it again'

function makeEcho(name: string): never {
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
    async call(input: Record<string, unknown>) { return { data: `echo:${(input?.text as string) ?? ''}` } },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}

function makeCtx(tools: unknown[]): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
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
    setAppState: (f: (prev: never) => never): void => { appState = f(appState as never) as unknown as Record<string, unknown> },
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

const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

const tools = [RetainTool, makeEcho('EchoTool')]

function gatedRefusal(id: string, argumentsRaw: string, malformed = false): RefusedToolCall {
  const verdict = gate.gateToolCall(tools as never, { id, name: 'Retain', argumentsRaw, malformed })
  if (verdict.ok) throw new Error(`the gate admitted what the box's provider sent: ${argumentsRaw}`)
  return verdict.refusal
}

function refusedTurn(...refusals: RefusedToolCall[]): unknown {
  const m = createAssistantMessage({ content: gate.toolCallRefusalNote('zai', refusals[0]!) })
  m.message.stop_reason = 'end_turn'
  m.refusedToolCalls = refusals
  return m
}
const textTurn = (text: string): unknown => {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return m
}
function toolTurn(id: string, name: string, input: Record<string, unknown>): unknown {
  const m = createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] as never })
  m.message.stop_reason = 'tool_use'
  return m
}

async function run(script: Step[][]): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; terminal: Record<string, unknown> }> {
  const rig = makeCtx(tools)
  const { calls, callModel } = makeModel(script)
  const gen = query({
    messages: [createUserMessage({ content: `remember: ${FACT_BELL}` })] as never,
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
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })(),
    },
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  return { yields, calls, terminal: r.value as Record<string, unknown> }
}

const userTexts = (msgs: unknown[]): Array<{ text: string; meta: boolean }> => {
  const out: Array<{ text: string; meta: boolean }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    const meta = m.isMeta === true
    if (typeof c === 'string') out.push({ text: c, meta })
    else if (Array.isArray(c)) for (const b of c as AnyMsg[]) if (b?.type === 'text' && typeof b.text === 'string') out.push({ text: b.text, meta })
  }
  return out
}
const corrections = (msgs: unknown[]): string[] => userTexts(msgs).filter(u => u.meta && gate.isToolCallRefusalCorrectionText(u.text)).map(u => u.text)
const systemNotices = (yields: AnyMsg[]): string[] => yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? (m as { text?: unknown }).text ?? ''))
const malformedNotes = (yields: AnyMsg[]): number => yields.filter(m => m.type === 'assistant' && Array.isArray((m as { refusedToolCalls?: unknown }).refusedToolCalls)).length

function libraryText(): string {
  const base = process.env.MERCURY_CONFIG_DIR!
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1)
        else if (entry.endsWith('.jsonl') && full.includes('memory')) out.push(readFileSync(full, 'utf8'))
      } catch {
        return
      }
    }
  }
  walk(base, 0)
  return out.join('\n')
}
const stored = (fact: string): boolean => libraryText().includes(fact)

section('§0 the gate refuses what the box\'s GLM road sent, and the schema-aware strip is not the cause')
{
  const strict = gate.gateToolCall(tools as never, { id: 'c0', name: 'Retain', argumentsRaw: GLM_BAD_BELL, malformed: false })
  check('an extra key on a Retain item is a schema refusal naming the key (the box\'s "The parameter … was not expected")', !strict.ok && strict.refusal.code === 'schema' && strict.refusal.reason.includes('`tags` was not expected'), JSON.stringify(strict))
  const nulled = gate.gateToolCall(tools as never, { id: 'c0n', name: 'Retain', argumentsRaw: `{"items":[{"content":"${FACT_BELL}","context":null,"pin":null}]}`, malformed: false })
  check('null in optional slots is stripped by the schema-aware strip and the call is admitted (the strip removes, never adds)', nulled.ok && JSON.stringify(nulled.input) === JSON.stringify({ items: [{ content: FACT_BELL }] }), JSON.stringify(nulled))
  const cut = gate.gateToolCall(tools as never, { id: 'c0c', name: 'Retain', argumentsRaw: GLM_CUT_BELL, malformed: true })
  check('a cut argument stream is an invalid-json refusal that still carries the fact\'s words', !cut.ok && cut.refusal.code === 'invalid-json' && factTexts(cut.refusal).some(t => t.includes('lighthouse bell')), JSON.stringify(cut))
  const correction = gate.toolCallRefusalCorrection([gatedRefusal('c0', GLM_BAD_BELL)])
  check('the correction handed to the model says the user asked for the facts to be kept and asks for the Retain re-issue first', correction.includes('re-issue that Retain call now') && correction.includes('the user will not type them again') && correction.includes(FACT_BELL), correction)
  check('the refusal and the executed call pair by the fact\'s words, not by the tool\'s name alone', answers(gatedRefusal('c0', GLM_BAD_BELL), { name: 'Retain', input: { items: [{ content: FACT_BELL }] } }) && !answers(gatedRefusal('c0', GLM_BAD_BELL), { name: 'Retain', input: { items: [{ content: FACT_TEA }] } }))
}

section('§1 a malformed Retain, then a good one on the correction: the fact is stored in the same turn and one note paints')
{
  const r = await run([
    [y(refusedTurn(gatedRefusal('c1', glmBad(bell('s1')))))],
    [y(toolTurn('tu_retain', 'Retain', { items: [{ content: bell('s1'), context: 'the user asked to remember it' }] }))],
    [y(textTurn('Remembered.'))],
  ])
  check('three model calls: the refusal, the corrected re-issue, the answer', r.calls.length === 3, String(r.calls.length))
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the correction rode the same turn, right after the refused step', corrections(r.calls[1]?.messages ?? []).length === 1 && corrections(r.calls[0]?.messages ?? []).length === 0)
  check('the fact is stored (the memory library carries the bell)', stored(bell('s1')), libraryText().slice(0, 400))
  check('exactly one malformed-call note painted', malformedNotes(r.yields) === 1, String(malformedNotes(r.yields)))
  check(`no "${LOST_LINE}" line — the re-issue landed`, !systemNotices(r.yields).some(t => t.includes(LOST_LINE)), systemNotices(r.yields).join(' | '))
}

section('§2 the box\'s shape (F39W-14A-01): the correction is handed back, the model stores a DIFFERENT fact and answers — the chat says the remember did not happen')
{
  const r = await run([
    [y(refusedTurn(gatedRefusal('c2', glmBad(bell('s2')))))],
    [y(toolTurn('tu_tea', 'Retain', { items: [{ content: tea('s2') }] }))],
    [y(textTurn('All three answered from memory.'))],
  ])
  check('terminal completed (the model answered)', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the other fact was stored, the asked-for one was not', stored(tea('s2')) && !stored(bell('s2')), JSON.stringify({ tea: stored(tea('s2')), bell: stored(bell('s2')) }))
  check(`the chat says plainly "${LOST_LINE}" at the end of the turn (an error-level notice)`, r.yields.some(m => m.type === 'system' && String((m as { content?: unknown }).content ?? '').includes(LOST_LINE) && (m as { level?: unknown }).level === 'error'), systemNotices(r.yields).join(' | '))
  const order = r.yields.map(m => (m.type === 'system' && String((m as { content?: unknown }).content ?? '').includes(LOST_LINE) ? 'lost' : m.type === 'assistant' ? 'assistant' : '')).filter(Boolean)
  check('the line comes after the model\'s own answer, as the turn\'s last word', order.lastIndexOf('lost') > order.lastIndexOf('assistant'), order.join(','))
}

section('§3 the model never re-issues at all and just answers — the line paints; §4 a fixture that stays malformed — the plain sentence paints and no fact is claimed')
{
  const r3 = await run([[y(refusedTurn(gatedRefusal('c3', glmBad(bell('s3')))))], [y(textTurn('I have no record of that.'))]])
  check('§3: the chat says the remember did not happen', systemNotices(r3.yields).some(t => t.includes(LOST_LINE)), systemNotices(r3.yields).join(' | '))
  check('§3: the fact was not stored', !stored(bell('s3')))
  const r4 = await run([
    [y(refusedTurn(gatedRefusal('c4a', glmBad(bell('s4')))))],
    [y(refusedTurn(gatedRefusal('c4b', glmCut(bell('s4')), true)))],
    [y(refusedTurn(gatedRefusal('c4c', glmBad(bell('s4')))))],
    [y(refusedTurn(gatedRefusal('c4d', glmBad(bell('s4')))))],
    [y(textTurn('never reached'))],
  ])
  check('§4: four calls, then the bounded recovery surfaces (tool_calls_refused)', r4.calls.length === 4 && r4.terminal.reason === 'tool_calls_refused', `${r4.calls.length} · ${JSON.stringify(r4.terminal)}`)
  check(`§4: the chat says plainly "${LOST_LINE}"`, systemNotices(r4.yields).some(t => t.includes(LOST_LINE)), systemNotices(r4.yields).join(' | '))
  check('§4: no fact is claimed — the library has no bell', !stored(bell('s4')))
  check('§4: the sentence is the user\'s, not the provider\'s (no [zai] in it)', systemNotices(r4.yields).filter(t => t.includes(LOST_LINE)).every(t => !t.includes('[zai]') && !t.includes('schema')))
}

section('§5 a refused Retain beside an executed call (the mixed step): held through the turn; a later matching Retain settles it, an answer without one says so')
{
  const r5a = await run([
    [y(toolTurn('tu_echo', 'EchoTool', { text: 'x' })), y(refusedTurn(gatedRefusal('c5a', glmBad(bell('s5a')))))],
    [y(toolTurn('tu_retain5', 'Retain', { items: [{ content: bell('s5a') }] }))],
    [y(textTurn('done'))],
  ])
  check('§5a: the re-issue beside the correction stores the fact and no lost line paints', stored(bell('s5a')) && !systemNotices(r5a.yields).some(t => t.includes(LOST_LINE)), systemNotices(r5a.yields).join(' | '))
  const r5b = await run([
    [y(toolTurn('tu_echo2', 'EchoTool', { text: 'x' })), y(refusedTurn(gatedRefusal('c5b', `{"items":[{"content":"${tea('s5b')}","importance":"high"}]}`)))],
    [y(textTurn('done without it'))],
  ])
  check('§5b: an answer with the refused Retain never re-issued says the remember did not happen', systemNotices(r5b.yields).some(t => t.includes(LOST_LINE)), systemNotices(r5b.yields).join(' | '))
  check('§5b: the correction rode the same user turn as the tool result', corrections(r5b.calls[1]?.messages ?? []).length === 1)
}

section('§6 a turn without a refused memory write says nothing')
{
  const r = await run([[y(toolTurn('tu_plain', 'EchoTool', { text: 'p' }))], [y(textTurn('ok'))]])
  check('no lost line, no refusal notice', !systemNotices(r.yields).some(t => t.includes('did not happen') || t.includes('Tool call refused')), systemNotices(r.yields).join(' | '))
}

console.log(`\n${failures === 0 ? `MALFORMED CALL RE-ISSUE GREEN (${checks} checks)` : `MALFORMED CALL RE-ISSUE RED — ${failures} failure(s) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
