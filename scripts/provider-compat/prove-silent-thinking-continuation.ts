#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'silent-thinking-continuation-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'silent-thinking-continuation-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'silent-thinking-continuation-crews-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_TIME_BASED_MC', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_THINKING_BINDING', 'MERCURY_PREFIX_INDUCE_EDIT', 'NODE_ENV', 'ANTHROPIC_BASE_URL']) {
  delete process.env[k]
}

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v) ?? 'undefined'
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the silent thinking continuation prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MODEL = 'claude-opus-5-5'
const EFFORT = 'max'
const ASK = 'can you do a quick demo of the game rq? like simlpe, in html'
const MENU = '<!doctype html><title>menu</title><main>play · settings · quit</main>'
const REPLY = 'A quick demo: one HTML file with a canvas and a loop.'
const TOOL = 'ReadMenu'
const TOOL_ID = 'toolu_menu_read'
const NUDGE_WORDS = 'your last turn carried thinking only — say your reply, or call the tool you meant'

const turnMachine = (await import('../../src/run-core/turn-machine.ts')) as Record<string, unknown>
const runEventCore = turnMachine.runEventCore as (params: unknown, consumed: string[]) => AsyncGenerator<Record<string, unknown>, Record<string, unknown>>
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const errors = (await import('../../src/services/api/errors.ts')) as Record<string, unknown>
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const MARKER = typeof errors.REASONING_CUT_MARKER === 'string' ? (errors.REASONING_CUT_MARKER as string) : null
const CEILING = getModelMaxOutputTokens(MODEL)
const CEILING_WORDS = CEILING.upperLimit % 1000 === 0 ? `${CEILING.upperLimit / 1000}k` : String(CEILING.upperLimit)

type AnyMsg = Record<string, unknown> & { type?: string; isApiErrorMessage?: boolean; isMeta?: boolean; message?: { role?: string; content?: unknown; stop_reason?: string } }
type Run = {
  calls: Array<{ messages: AnyMsg[] }>
  notices: Array<{ text: string; level: string }>
  transitions: Array<{ reason: string; attempt?: number }>
  efforts: unknown[]
  answers: string[]
  settled: AnyMsg[]
  withheldSurfaced: number
  terminal: Record<string, unknown>
}

function menuTool(): never {
  return {
    name: TOOL,
    async description() {
      return 'reads the menu file'
    },
    async prompt() {
      return 'reads the menu file'
    },
    inputSchema: z.object({ path: z.string() }),
    userFacingName: () => TOOL,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call() {
      return { data: MENU }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: EFFORT }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [menuTool()],
      mainLoopModel: MODEL,
      thinkingConfig: { type: 'adaptive' },
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

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

async function run(): Promise<Run> {
  const calls: Array<{ messages: AnyMsg[] }> = []
  async function* callModel(params: { messages: AnyMsg[] }): AsyncGenerator<unknown, void> {
    calls.push({ messages: [...params.messages] })
    yield* queryModelWithStreaming(params as never) as never
  }
  const gen = runEventCore(
    {
      messages: [createUserMessage({ content: ASK })],
      systemPrompt: ['rig system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: allowAll,
      toolUseContext: makeCtx(),
      querySource: 'sdk',
      deps: {
        callModel,
        autocompact: async () => ({ wasCompacted: false }),
        microcompact: async (messages: unknown[]) => ({ messages }),
        uuid: (() => {
          let n = 0
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        })(),
      },
    },
    [],
  )
  const out: Run = { calls, notices: [], transitions: [], efforts: [], answers: [], settled: [], withheldSurfaced: 0, terminal: {} }
  let r = await gen.next()
  while (!r.done) {
    const e = r.value
    if (e.kind === 'notice') {
      const m = e.message as { content?: unknown; level?: unknown }
      out.notices.push({ text: String(m.content ?? ''), level: String(m.level ?? '') })
    }
    if (e.kind === 'turn_settled') out.transitions.push(e.transition as { reason: string; attempt?: number })
    if (e.kind === 'model_call_started') out.efforts.push(e.effort)
    if (e.kind === 'withheld_surfaced') out.withheldSurfaced++
    if (e.kind === 'assistant_settled') {
      const m = e.message as AnyMsg
      out.settled.push(m)
      const content = m.message?.content
      if (e.withheld !== true && Array.isArray(content)) {
        for (const b of content as AnyMsg[]) if (b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim() !== '') out.answers.push(b.text as string)
      }
    }
    r = await gen.next()
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  out.terminal = r.value
  return out
}

type Block = { type?: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; tool_use_id?: string }
type Body = { model?: string; max_tokens?: number; output_config?: { effort?: unknown }; thinking?: Record<string, unknown>; messages?: Array<{ role: string; content: unknown }> }
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}
const blocksOf = (m: { content: unknown } | undefined): Block[] => (Array.isArray(m?.content) ? (m!.content as Block[]) : [])
const shape = (body: Body | undefined): string[] =>
  (body?.messages ?? []).map(m => `${m.role}:${typeof m.content === 'string' ? 'text' : blocksOf(m).map(b => String(b.type)).join('+')}`)

const menuRead: ScriptedTurn = { kind: 'tool_use', name: TOOL, input: { path: 'csgo-menu.html' }, id: TOOL_ID, thinking: '', model: MODEL }
const thinkingToTheWall: ScriptedTurn = { kind: 'stream', blocks: [{ type: 'thinking', deltas: [] }], gapMs: 1, stopReason: 'max_tokens', usage: { output_tokens: CEILING.upperLimit }, model: MODEL }
const answer: ScriptedTurn = { kind: 'text', text: REPLY, thinking: '', model: MODEL }

section(`0 · the ceiling the catalogue states for ${MODEL} is the ceiling every request carries (${CEILING_WORDS}), not a smaller default`)
{
  check(`getModelMaxOutputTokens(${j(MODEL)}).default equals its upperLimit (${CEILING.upperLimit})`, CEILING.default === CEILING.upperLimit, j(CEILING))
  check('the cut marker text block is owned by services/api/errors.ts', typeof MARKER === 'string' && MARKER.length > 0, j(MARKER))
}

section('A · the real shape: a tool round, then thinking to max_tokens with an EMPTY thinking field and a signature (the omitted display), then the continuation')
{
  const fixture = await startFixtureApi([menuRead, thinkingToTheWall, answer], { apiChecks: true })
  process.env.ANTHROPIC_BASE_URL = fixture.url
  let r: Run
  let bodies: Body[]
  let refusals: string[]
  try {
    r = await run()
    bodies = fixture.messageRequests().map(q => q.body as Body)
    refusals = fixture.refusals.map(f => f.message)
  } finally {
    delete process.env.ANTHROPIC_BASE_URL
    await fixture.close()
  }
  check('three requests: the tool round, the cut turn, the continuation', bodies.length === 3, `${bodies.length} request(s): ${j(bodies.map(shape))}; terminal ${j(r.terminal)}; notices ${j(r.notices)}; calls ${r.calls.length}`)
  check('the fixture refused nothing (every request is legal under the documented rules)', refusals.length === 0, j(refusals))
  check(`every request carries max_tokens ${CEILING.upperLimit} — the stated maximum, the cut turn and the continuation alike`, bodies.length === 3 && bodies.every(b => b.max_tokens === CEILING.upperLimit), j(bodies.map(b => b.max_tokens)))
  check('every request rides at the session effort, max, with adaptive thinking and no budget', bodies.length === 3 && bodies.every(b => b.output_config?.effort === EFFORT && b.thinking?.type === 'adaptive' && b.thinking?.budget_tokens === undefined), `${j(bodies.map(b => b.output_config))} ${j(bodies.map(b => b.thinking))}`)
  const cut = r.settled.find(m => m.message?.stop_reason === 'max_tokens')
  const cutBlocks = blocksOf(cut?.message as { content: unknown } | undefined)
  check('the cut turn settled as one thinking block with an empty thinking field and a signature, no text, no tool call', cutBlocks.length === 1 && cutBlocks[0]?.type === 'thinking' && cutBlocks[0].thinking === '' && typeof cutBlocks[0].signature === 'string' && cutBlocks[0].signature.length > 0, j(cutBlocks).slice(0, 300))
  const continuation = bodies[2]
  const rows = continuation?.messages ?? []
  check('the continuation body keeps the tool round: the assistant tool_use row and its tool_result row precede the cut row', rows.some(m => m.role === 'assistant' && blocksOf(m).some(b => b.type === 'tool_use' && b.id === TOOL_ID)) && rows.some(m => m.role === 'user' && blocksOf(m).some(b => b.type === 'tool_result' && b.tool_use_id === TOOL_ID)), j(shape(continuation)))
  const lastAssistant = [...rows].reverse().find(m => m.role === 'assistant')
  const carried = blocksOf(lastAssistant)
  check('the last assistant row of the continuation is the cut turn: its signed thinking block (thinking "", the signature verbatim) followed only by the cut marker text', carried.length === 2 && carried[0]?.type === 'thinking' && carried[0].thinking === '' && carried[0].signature === cutBlocks[0]?.signature && carried[1]?.type === 'text' && carried[1].text === MARKER, j(carried).slice(0, 300))
  check('the cut row stands directly before the user nudge (the prefix the model resumes from), never dropped as an orphan', rows.at(-2)?.role === 'assistant' && rows.at(-2) === lastAssistant && rows.at(-1)?.role === 'user', j(shape(continuation)))
  const nudge = rows.at(-1)
  check('the nudge carries the words: ' + j(NUDGE_WORDS), nudge?.role === 'user' && textOf(nudge.content).includes(NUDGE_WORDS), j(textOf(nudge?.content)).slice(0, 240))
  check('the nudge rides as an isMeta user message on the machine side', (() => {
    const last = [...(r.calls[2]?.messages ?? [])].reverse().find(m => m.type === 'user')
    return last?.isMeta === true && textOf(last.message?.content).includes(NUDGE_WORDS)
  })(), j(r.calls[2]?.messages.at(-1)?.message?.content).slice(0, 200))
  check('one reasoning_only_recovery transition (attempt 1) and NO max_output_tokens_recovery — the silent from-scratch resume never fires', j(r.transitions.filter(t => t.reason === 'reasoning_only_recovery').map(t => t.attempt)) === j([1]) && !r.transitions.some(t => t.reason === 'max_output_tokens_recovery'), j(r.transitions))
  check(`one visible warning row: "thinking ran to the output limit (${CEILING_WORDS}) — continuing"`, r.notices.filter(n => n.level === 'warning' && n.text.includes(`thinking ran to the output limit (${CEILING_WORDS}) — continuing`)).length === 1, j(r.notices))
  check('the reply landed as text and the run completed', r.terminal.reason === 'completed' && r.answers.at(-1) === REPLY, `${j(r.terminal)} ${j(r.answers)}`)
  check('the withheld max-tokens error never surfaced', r.withheldSurfaced === 0, String(r.withheldSurfaced))
  check('the effort word rode every model call (max, max, max)', j(r.efforts) === j([EFFORT, EFFORT, EFFORT]), j(r.efforts))
}

clearTimeout(guard)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-silent-thinking-continuation: ALL GREEN' : `prove-silent-thinking-continuation: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
