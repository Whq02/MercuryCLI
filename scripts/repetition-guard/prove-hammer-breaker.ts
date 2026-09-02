#!/usr/bin/env bun
// ============================================================================
//  scripts/repetition-guard/prove-hammer-breaker.ts — a model that hammers
//  ONE tool call is bounded by the loop, told why, and the operator sees it.
//
//  The class the operator meets "quite a bit": a model that keeps issuing
//  the same call with the same input. The breaker
//  (src/services/tools/identicalFailureGuard.ts) refuses the call once with
//  a typed nudge, and when the model runs past the nudge the turn machine
//  (src/run-core/turn-machine.ts) ends the run typed. This prover drives the
//  REAL query() loop (the deps seam — no network, the prove-runloop-contract
//  rig) with scripted models and pins:
//
//    H1  identical FAILING call forever → exactly IDENTICAL_FAILURES_TO_STOP
//        + 1 model calls (the refused round bills one call, runs no tool),
//        the run ends `repetition_breaker`, ONE nudge tool_result (is_error)
//        reached the model, and a 'warning' notice names the tool + streak.
//    H2  identical SUCCEEDING call with the identical result forever → the
//        same law on the success bounds; the nudge is the same-result text.
//    H3  the poll shape (A · B · A · B …) and a moving result never trip
//        the guard — the run ends `completed` when the script says so.
//    H4  a parallel round of two identical calls counts both settlements.
//    H5  every tool_use of the stopped round is paired (no dangling id), and
//        the SDK/headless projection carries the typed attachment.
//    H6  the wait primitive (Sleep) hammered with identical results never
//        stops the turn.
//
//  Run: ~/.bun/bin/bun run scripts/repetition-guard/prove-hammer-breaker.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

// ── hermetic env (BEFORE any src import) ────────────────────────────────────
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hammer-breaker-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'hammer-breaker-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'hammer-breaker-teams-'))
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
const guard = await import('../../src/services/tools/identicalFailureGuard.ts')

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
  console.log('\nTIMEOUT — hammer breaker prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

// ── rig (the runloop-contract shape) ────────────────────────────────────────
type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'

/** A rig tool: `fail:` inputs throw (an error tool_result), `tick:` inputs
 *  answer with a moving counter, anything else echoes (a fixed result). */
let tick = 0
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
      const text = (input?.text as string) ?? ''
      if (text.startsWith('fail:')) throw new Error(`rig failure: ${text}`)
      if (text.startsWith('tick:')) return { data: `tick ${++tick}` }
      return { data: `echo:${text}` }
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

/** A scripted model: `turnFor(callIndex)` yields the settled assistant
 *  message(s) for that call; undefined ends the script (an error). */
function makeModel(turnFor: (index: number) => unknown[] | undefined): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    const turn = turnFor(idx)
    if (!turn) throw new Error(`model script exhausted at call ${idx}`)
    for (const m of turn) yield m as never
  }
  return { calls, callModel }
}

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

let idSeq = 0
function toolTurn(name: string, input: Record<string, unknown>, count = 1): unknown[] {
  const m = createAssistantMessage({
    content: Array.from({ length: count }, () => ({ type: 'tool_use', id: `tu_${++idSeq}`, name, input })) as never,
  })
  m.message.stop_reason = 'tool_use'
  return [m]
}
function textTurn(text: string): unknown[] {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return [m]
}

async function run(turnFor: (index: number) => unknown[] | undefined, toolNames = ['EchoTool']): Promise<{
  yields: AnyMsg[]
  calls: CallRecord[]
  terminal: Record<string, unknown>
}> {
  const rig = makeCtx(toolNames.map(makeTool))
  const { calls, callModel } = makeModel(turnFor)
  const gen = query({
    messages: [createUserMessage({ content: 'please do the thing' })] as never,
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

/** Every tool_result block across the yielded user messages. */
function toolResults(yields: AnyMsg[]): Array<{ id: string; text: string; isError: boolean }> {
  const out: Array<{ id: string; text: string; isError: boolean }> = []
  for (const m of yields) {
    if (m.type !== 'user') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) {
      if (b?.type !== 'tool_result') continue
      const raw = b.content
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : ''
      out.push({ id: String(b.tool_use_id), text, isError: b.is_error === true })
    }
  }
  return out
}
function toolUses(yields: AnyMsg[]): string[] {
  const ids: string[] = []
  for (const m of yields) {
    if (m.type !== 'assistant') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) if (b?.type === 'tool_use') ids.push(String(b.id))
  }
  return ids
}
const systemNotices = (yields: AnyMsg[]): string[] =>
  yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? ''))
const attachments = (yields: AnyMsg[]): AnyMsg[] =>
  yields.filter(m => m.type === 'attachment').map(m => (m as { attachment?: AnyMsg }).attachment ?? {})

// ── H1 ──────────────────────────────────────────────────────────────────────
section('H1 — an identical FAILING call forever ends the run in bounded rounds, told why')
{
  const r = await run(() => toolTurn('EchoTool', { text: 'fail:always' }))
  const expectedCalls = guard.IDENTICAL_FAILURES_TO_STOP + 1
  check(`exactly ${expectedCalls} model calls (${guard.IDENTICAL_FAILURES_TO_STOP} identical failures + the refused round), never a further one`, r.calls.length === expectedCalls, String(r.calls.length))
  check("terminal reason is 'repetition_breaker' with a cause", r.terminal.reason === 'repetition_breaker' && typeof r.terminal.cause === 'string', JSON.stringify(r.terminal))
  const results = toolResults(r.yields)
  const nudges = results.filter(t => t.text.includes(guard.IDENTICAL_RETRY_NUDGE))
  check('exactly ONE nudge tool_result reached the model, flagged is_error', nudges.length === 1 && nudges[0]!.isError, String(nudges.length))
  check('the nudge rode in the round right after the arming streak', (() => {
    const idx = results.findIndex(t => t.text.includes(guard.IDENTICAL_RETRY_NUDGE))
    return idx === guard.IDENTICAL_FAILURES_TO_ARM
  })(), results.map(t => t.text.slice(0, 20)).join(' | '))
  check('every tool_use of the run is paired exactly once', (() => {
    const uses = toolUses(r.yields)
    const ids = results.map(t => t.id)
    return uses.length === ids.length && uses.every(id => ids.filter(x => x === id).length === 1)
  })())
  const notice = systemNotices(r.yields).find(t => t.includes('Stopped this turn'))
  check("a 'warning' notice names the tool, the streak and the next move", notice !== undefined && notice.includes('EchoTool') && notice.includes(`${guard.IDENTICAL_FAILURES_TO_STOP} times`) && notice.includes('new prompt'), notice)
  const att = attachments(r.yields).find(a => a.type === 'repetition_breaker')
  check('the typed attachment carries tool · outcome · streak · cause', att !== undefined && att.toolName === 'EchoTool' && att.outcome === 'failure' && att.streak === guard.IDENTICAL_FAILURES_TO_STOP && typeof att.cause === 'string', JSON.stringify(att))
}

// ── H2 ──────────────────────────────────────────────────────────────────────
section('H2 — an identical SUCCEEDING call with the identical result forever is bounded the same way')
{
  const r = await run(() => toolTurn('EchoTool', { text: 'same' }))
  const expectedCalls = guard.IDENTICAL_RESULTS_TO_STOP + 1
  check(`exactly ${expectedCalls} model calls`, r.calls.length === expectedCalls, String(r.calls.length))
  check("terminal reason is 'repetition_breaker'", r.terminal.reason === 'repetition_breaker', JSON.stringify(r.terminal))
  const results = toolResults(r.yields)
  const nudges = results.filter(t => t.text.includes(guard.IDENTICAL_RESULT_NUDGE))
  check('exactly ONE same-result nudge reached the model, flagged is_error', nudges.length === 1 && nudges[0]!.isError, String(nudges.length))
  check('the nudge rode right after the arming streak', results.findIndex(t => t.text.includes(guard.IDENTICAL_RESULT_NUDGE)) === guard.IDENTICAL_RESULTS_TO_ARM)
  check('the successful results before it were ordinary (not errors)', results.slice(0, guard.IDENTICAL_RESULTS_TO_ARM).every(t => !t.isError && t.text === 'echo:same'))
  const notice = systemNotices(r.yields).find(t => t.includes('Stopped this turn'))
  check('the notice says "identical result"', notice !== undefined && notice.includes('identical result'), notice)
}

// ── H3 ──────────────────────────────────────────────────────────────────────
section('H3 — poll shapes and moving results never trip the guard')
{
  const rounds = guard.IDENTICAL_RESULTS_TO_STOP * 2
  const poll = await run(i => (i < rounds ? toolTurn('EchoTool', { text: i % 2 === 0 ? 'check' : 'wait' }) : textTurn('done polling')))
  check(`A·B·A·B for ${rounds} rounds runs to completion`, poll.terminal.reason === 'completed' && poll.calls.length === rounds + 1, `${String(poll.terminal.reason)} calls=${poll.calls.length}`)
  check('…with no nudge and no notice', !toolResults(poll.yields).some(t => t.isError) && !systemNotices(poll.yields).some(t => t.includes('Stopped this turn')))
  const moving = await run(i => (i < rounds ? toolTurn('EchoTool', { text: 'tick:' }) : textTurn('done ticking')))
  check(`the same call with a MOVING result for ${rounds} rounds runs to completion`, moving.terminal.reason === 'completed' && moving.calls.length === rounds + 1, `${String(moving.terminal.reason)} calls=${moving.calls.length}`)
  check('…with no nudge', !toolResults(moving.yields).some(t => t.isError))
}

// ── H4 ──────────────────────────────────────────────────────────────────────
section('H4 — a parallel round of identical calls counts every settlement')
{
  // Round 0: two identical failing calls (streak 2 → armed). Round 1: the
  // same call → refused with the nudge. Round 2: text.
  const r = await run(i => (i === 0 ? toolTurn('EchoTool', { text: 'fail:pair' }, 2) : i === 1 ? toolTurn('EchoTool', { text: 'fail:pair' }) : textTurn('ok')))
  const results = toolResults(r.yields)
  check('the two parallel failures armed the guard: the third call was refused', results.length === 3 && results[2]!.text.includes(guard.IDENTICAL_RETRY_NUDGE), results.map(t => t.text.slice(0, 30)).join(' | '))
  check('the run then completed normally', r.terminal.reason === 'completed' && r.calls.length === 3)
}

// ── H5 ──────────────────────────────────────────────────────────────────────
section('H5 — the stopped round leaves nothing dangling and the transcript stays replayable')
{
  const r = await run(() => toolTurn('EchoTool', { text: 'fail:dangle' }))
  const lastCall = r.calls.at(-1)!
  const lastAssistant = [...(lastCall.messages as AnyMsg[])].reverse().find(m => m.type === 'assistant')
  check('the last model call still saw every earlier round paired (no unanswered tool_use in its request)', (() => {
    const msgs = lastCall.messages as AnyMsg[]
    const uses: string[] = []
    const answered = new Set<string>()
    for (const m of msgs) {
      const content = (m.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) continue
      for (const b of content as AnyMsg[]) {
        if (b?.type === 'tool_use') uses.push(String(b.id))
        if (b?.type === 'tool_result') answered.add(String(b.tool_use_id))
      }
    }
    return uses.length > 0 && uses.every(id => answered.has(id))
  })())
  check('the stopped round itself yielded its tool_result before the terminal', (() => {
    const kinds = r.yields.map(m => m.type)
    const lastResult = kinds.lastIndexOf('user')
    const lastAttachment = kinds.lastIndexOf('attachment')
    return lastResult !== -1 && lastAttachment !== -1 && lastResult < lastAttachment
  })())
  check('the run never asked the model again after the stop', lastAssistant !== undefined && r.calls.length === guard.IDENTICAL_FAILURES_TO_STOP + 1)
}

// ── H6 ──────────────────────────────────────────────────────────────────────
section('H6 — the wait primitive hammered with identical results never stops the turn')
{
  const rounds = guard.IDENTICAL_RESULTS_TO_STOP + 3
  const r = await run(i => (i < rounds ? toolTurn('Sleep', { text: 'zzz' }) : textTurn('awake')), ['Sleep'])
  check(`${rounds} identical Sleep results run to completion`, r.terminal.reason === 'completed' && r.calls.length === rounds + 1, `${String(r.terminal.reason)} calls=${r.calls.length}`)
  check('…with no nudge', !toolResults(r.yields).some(t => t.isError))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
