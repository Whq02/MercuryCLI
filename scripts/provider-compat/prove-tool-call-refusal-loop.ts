#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-tool-call-refusal-loop.ts — the turn
//  machine's half of the transport-boundary gate: a refused tool call
//  reaches the MODEL, and the agent loop keeps running.
//
//  The gate (src/services/providers/toolCallGate.ts) never mints a tool_use
//  for a refused call, so there is no tool_result to carry the error back.
//  Without the band in run-core/turn-machine.ts the turn would simply END
//  with an adapter note the model never reads. This prover drives the REAL
//  query() loop (the deps seam — no network, the prove-runloop-contract
//  rig) with a scripted model whose settled messages carry refusal records
//  exactly as the adapters stamp them, and pins:
//
//    R1  refusal-only turn → ONE meta user correction (the typed text, the
//        tool name, the reason, the raw bytes) is injected and the model is
//        called again; a 'warning' notice makes the continuation visible;
//        the transition is `tool_call_refusal_recovery` attempt 1.
//    R2  the bound — four consecutive refusal-only turns make exactly
//        1 + 3 calls, then the run ends `completed` with the notes visible.
//    R3  mixed turn (one accepted call + one refusal) → the correction
//        rides the SAME user turn as the tool_result, AFTER it, and the
//        loop continues as an ordinary next_turn (no extra bound spent).
//    R4  the bound resets once a tool runs: refusal ×3 · tool round ·
//        refusal ×3 · text = 8 calls, every refusal answered.
//    R5  a turn with no refusals injects nothing (zero false corrections).
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-tool-call-refusal-loop.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refusal-loop-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'refusal-loop-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'refusal-loop-teams-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_MAX_OUTPUT_TOKENS',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const gate = await import('../../src/services/providers/toolCallGate.ts')
const { decideToolCallRefusalRecovery } = await import('../../src/run-core/turn-machine.ts')
type RefusedToolCall = import('../../src/types/message.ts').RefusedToolCall

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
  console.log('\nTIMEOUT — refusal loop prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

// ── rig (the runloop-contract shape) ────────────────────────────────────────
type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
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
      return { data: `echo:${(input?.text as string) ?? ''}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}

function makeCtx(tools: unknown[]): { ctx: Record<string, unknown>; abortController: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools,
      mainLoopModel: MODEL,
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

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

const refusal = (over: Partial<RefusedToolCall> = {}): RefusedToolCall => ({
  id: 'call_bad',
  name: 'Bash',
  argumentsRaw: '{"cmd":"ls"}',
  code: 'schema',
  reason: 'The Bash tool failed due to the following issue:\nThe required parameter `command` is missing',
  ...over,
})

/** The exact shape an adapter settles: a note text block carrying the
 *  refusal record, stop_reason end_turn. */
function refusedTurn(...refusals: RefusedToolCall[]): unknown {
  const m = createAssistantMessage({ content: gate.toolCallRefusalNote('fixture', refusals[0]!) })
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
  const rig = makeCtx([makeTool('EchoTool')])
  const { calls, callModel } = makeModel(script)
  const gen = query({
    messages: [createUserMessage({ content: 'please run it' })] as never,
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

const userTexts = (msgs: unknown[]): Array<{ text: string; meta: boolean }> => {
  const out: Array<{ text: string; meta: boolean }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    const meta = m.isMeta === true
    if (typeof c === 'string') out.push({ text: c, meta })
    else if (Array.isArray(c)) {
      for (const b of c as AnyMsg[]) {
        if (b?.type === 'text' && typeof b.text === 'string') out.push({ text: b.text, meta })
      }
    }
  }
  return out
}
const corrections = (msgs: unknown[]): string[] =>
  userTexts(msgs).filter(u => u.meta && gate.isToolCallRefusalCorrectionText(u.text)).map(u => u.text)
const systemNotices = (yields: AnyMsg[]): string[] =>
  yields
    .filter(m => m.type === 'system')
    .map(m => String((m as { content?: unknown }).content ?? (m as { text?: unknown }).text ?? ''))

// ── R1 ──────────────────────────────────────────────────────────────────────
section('R1 — a refusal-only turn injects the typed correction and calls the model again')
{
  const r = await run([[y(refusedTurn(refusal()))], [y(textTurn('fixed: Bash {"command":"ls"}'))]])
  check('two model calls (the correction continuation)', r.calls.length === 2, String(r.calls.length))
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const injected = corrections(r.calls[1]?.messages ?? [])
  check('the second call carries exactly ONE meta correction message', injected.length === 1, String(injected.length))
  const text = injected[0] ?? ''
  check('the correction names the tool, the reason, and the raw bytes', text.includes('malformed arguments for Bash') && text.includes('`command` is missing') && text.includes('{"cmd":"ls"}') && text.includes('call_bad'), text.slice(0, 300))
  check('the correction is the LAST message before the re-call (after the assistant note)', (() => {
    const msgs = r.calls[1]?.messages as AnyMsg[]
    const last = msgs.at(-1)
    return last?.type === 'user' && last.isMeta === true && corrections([last]).length === 1
  })())
  check("a 'warning' notice made the continuation visible", systemNotices(r.yields).some(t => t.includes('Tool call refused before execution') && t.includes('Bash')), systemNotices(r.yields).join(' | '))
  check('the first call carried no correction (the seed turn is clean)', corrections(r.calls[0]?.messages ?? []).length === 0)
}

// ── R2 ──────────────────────────────────────────────────────────────────────
section('R2 — the bound: four consecutive refusal-only turns make 1 + 3 calls, then the run ends')
{
  const r = await run([
    [y(refusedTurn(refusal({ id: 'c1' })))],
    [y(refusedTurn(refusal({ id: 'c2' })))],
    [y(refusedTurn(refusal({ id: 'c3' })))],
    [y(refusedTurn(refusal({ id: 'c4' })))],
    [y(textTurn('never reached'))],
  ])
  check('exactly four calls — three continuations, the fourth refusal surfaces', r.calls.length === 4, String(r.calls.length))
  check('terminal completed (the notes stay visible, no fifth billed call)', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('the three corrections each name their own call', ['c2', 'c3', 'c4'].every((_, i) => corrections(r.calls[i + 1]?.messages ?? []).some(t => t.includes(`c${i + 1}`))))
  const d1 = decideToolCallRefusalRecovery({ refusals: 1, recoveryCount: 0 })
  const d4 = decideToolCallRefusalRecovery({ refusals: 1, recoveryCount: 3 })
  const d0 = decideToolCallRefusalRecovery({ refusals: 0, recoveryCount: 0 })
  check('the pure decision: continue below the bound, surface at it, never on zero refusals', d1.kind === 'continue' && d1.attempt === 1 && d4.kind === 'surface' && d0.kind === 'surface')
}

// ── R3 ──────────────────────────────────────────────────────────────────────
section('R3 — a mixed turn answers the refusal in the SAME user turn as the tool_result, after it')
{
  const r = await run([
    [y(toolTurn('tu_ok', 'EchoTool', { text: 'x' })), y(refusedTurn(refusal({ id: 'call_mixed_bad' })))],
    [y(textTurn('done'))],
  ])
  check('two calls (an ordinary next_turn — no refusal bound spent)', r.calls.length === 2, String(r.calls.length))
  const msgs = (r.calls[1]?.messages ?? []) as AnyMsg[]
  const resultIdx = msgs.findIndex(m => m.type === 'user' && JSON.stringify((m.message as { content?: unknown }).content).includes('tu_ok'))
  const correctionIdx = msgs.findIndex(m => m.type === 'user' && corrections([m]).length === 1)
  check('the tool_result and the correction both ride the next call', resultIdx !== -1 && correctionIdx !== -1, `result=${resultIdx} correction=${correctionIdx}`)
  check('the correction follows the tool_result', correctionIdx > resultIdx, `result=${resultIdx} correction=${correctionIdx}`)
  check('the correction names the refused call', corrections(msgs)[0]?.includes('call_mixed_bad') === true)
  check('the tool actually ran (its result is the echo)', JSON.stringify(msgs[resultIdx]).includes('echo:x'))
}

// ── R4 ──────────────────────────────────────────────────────────────────────
section('R4 — the bound resets once a tool runs')
{
  const r = await run([
    [y(refusedTurn(refusal({ id: 'a1' })))],
    [y(refusedTurn(refusal({ id: 'a2' })))],
    [y(refusedTurn(refusal({ id: 'a3' })))],
    [y(toolTurn('tu_reset', 'EchoTool', { text: 'reset' }))],
    [y(refusedTurn(refusal({ id: 'b1' })))],
    [y(refusedTurn(refusal({ id: 'b2' })))],
    [y(refusedTurn(refusal({ id: 'b3' })))],
    [y(textTurn('finally'))],
  ])
  check('eight calls — three continuations, a tool round, three more continuations, the answer', r.calls.length === 8, String(r.calls.length))
  check('terminal completed', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  check('every refusal was answered by a correction in the following call', ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].every(id => r.calls.some(c => corrections(c.messages).some(t => t.includes(id)))))
}

// ── R5 ──────────────────────────────────────────────────────────────────────
section('R5 — a turn without refusals injects nothing')
{
  const r = await run([[y(toolTurn('tu_plain', 'EchoTool', { text: 'p' }))], [y(textTurn('ok'))]])
  check('no correction anywhere', r.calls.every(c => corrections(c.messages).length === 0))
  check('no refusal notice', !systemNotices(r.yields).some(t => t.includes('Tool call refused')))
  check('terminal completed', r.terminal.reason === 'completed')
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
