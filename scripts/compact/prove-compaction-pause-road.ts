#!/usr/bin/env bun
// gate-watch: src/commands/compact/compact.ts src/run-core/turn-machine.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compaction-pause-road-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'compaction-pause-road-daemon-'))
for (const k of [
  'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'MERCURY_MODEL', 'MERCURY_PRUNE_PCT', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_CTX_COMPACTION',
]) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = resolve(import.meta.dir, '..', '..')
const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')
const { estimateOverflowSignal } = await import('../../src/services/api/overflowSignal.ts')
const autoCompact = await import('../../src/services/compact/autoCompact.ts')
const { overflowRefusalText, foldAvailability } = await import('../../src/services/compact/overflowRecovery.ts')
const compactionBreakerText: ((opts: { nonInteractive: boolean }) => string) | undefined = (autoCompact as { compactionBreakerText?: (opts: { nonInteractive: boolean }) => string }).compactionBreakerText

type AnyMsg = Record<string, unknown> & { type?: string }
type AnyEvent = Record<string, unknown> & { kind: string }

const MODEL = 'claude-opus-5-5'
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compaction pause road prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

console.log('============================================================')
console.log(' the compaction breaker names a road that works, and the road is true')
console.log('============================================================')

const INTERACTIVE_LINE = 'automatic compaction failed 3 times in a row and is paused for the rest of this run. /compact folds the conversation by hand; the next message makes a fresh automatic attempt.'
const HEADLESS_LINE = 'automatic compaction failed 3 times in a row and is paused for the rest of this run. The next prompt makes a fresh automatic attempt.'
const signal = estimateOverflowSignal({ family: 'anthropic', actualTokens: 777_170, limitTokens: 777_000 })

section('B1 the words — the paused breaker names /compact by hand and the next message, says the pause is the run\'s, and keeps the /clear and /model remedies')
{
  check('the sentence has one builder (compactionBreakerText)', typeof compactionBreakerText === 'function')
  if (typeof compactionBreakerText === 'function') {
    check('the interactive sentence', compactionBreakerText({ nonInteractive: false }) === INTERACTIVE_LINE, compactionBreakerText({ nonInteractive: false }))
    check('the headless sentence', compactionBreakerText({ nonInteractive: true }) === HEADLESS_LINE, compactionBreakerText({ nonInteractive: true }))
  }
  const interactive = overflowRefusalText(signal, 'breaker', { nonInteractive: false })
  check('the estimate-side refusal, interactive, is the stable key, the numbers, the sentence and the slash remedies', interactive === `${PROMPT_TOO_LONG_ERROR_MESSAGE} — the request is over the window (estimated 777,170 tokens > 777,000): ${INTERACTIVE_LINE} /clear starts fresh, or /model picks a model with a larger window.`, interactive)
  check('…and never calls the pause the session\'s', !/session/.test(interactive), interactive)
  const headless = overflowRefusalText(signal, 'breaker', { nonInteractive: true })
  check('the headless refusal names the next prompt and the fresh-run remedy', headless === `${PROMPT_TOO_LONG_ERROR_MESSAGE} — the request is over the window (estimated 777,170 tokens > 777,000): ${HEADLESS_LINE} Start a fresh run, or pass --model with a larger window.`, headless)
  check('the availability law still answers breaker at three failures', foldAvailability({ tracking: { compacted: false, turnCounter: 0, turnId: '', consecutiveFailures: 3 }, hasHistory: true }).available === false && (foldAvailability({ tracking: { compacted: false, turnCounter: 0, turnId: '', consecutiveFailures: 3 }, hasHistory: true }) as { why?: string }).why === 'breaker')
}

section('B2 the forced road — a fold forced past the tripped breaker refuses with the same sentence, undressed')
{
  const ctx = {
    abortController: new AbortController(),
    options: { engineModel: MODEL, tools: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [] } },
    getAppState: () => getDefaultAppState(),
    setAppState: () => {},
    readFileState: createFileStateCacheWithSizeLimit(10),
    messages: [],
    agentId: undefined,
  }
  const tracking = { compacted: false, turnCounter: 0, turnId: '', consecutiveFailures: 3 }
  const forced = await autoCompact.autoCompactIfNeeded([] as never, ctx as never, { systemPrompt: [] } as never, 'sdk', tracking, 0, signal)
  check('the forced fold at the breaker does not fold and names the sentence as its refusal', forced.wasCompacted === false && forced.refusal === INTERACTIVE_LINE, JSON.stringify(forced))
  const dressed = overflowRefusalText(signal, 'fold-failed', { nonInteractive: false, detail: forced.refusal })
  check('the ladder prints that refusal as the sentence itself — never "the fold failed (…)" around it, never the by-hand clause twice', dressed.includes(`: ${INTERACTIVE_LINE} /clear starts fresh`) && !dressed.includes('the fold failed') && dressed.split('/compact').length === 2, dressed)
  const headlessCtx = { ...ctx, options: { ...ctx.options, isNonInteractiveSession: true } }
  const forcedHeadless = await autoCompact.autoCompactIfNeeded([] as never, headlessCtx as never, { systemPrompt: [] } as never, 'sdk', tracking, 0, signal)
  check('the headless forced refusal is the headless sentence', forcedHeadless.refusal === HEADLESS_LINE, JSON.stringify(forcedHeadless))
}

const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}
const asstText = (text: string): unknown => createAssistantMessage({ content: text })
const ping = (): unknown => ({ type: 'stream_event', event: { type: 'ping' } })
type CallRecord = { model: unknown; messages: unknown[] }
function makeModel(script: unknown[][]): { calls: CallRecord[]; callModel: (req: never) => AsyncGenerator<never, void> } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[]; options: Record<string, unknown> }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ model: req.options.model, messages: [...req.messages] })
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel: callModel as never }
}
type CompactCall = { forced: unknown; tracking: unknown }
function rigFoldResult(): Record<string, unknown> {
  const boundaryMarker = createCompactBoundaryMessage('auto', 900)
  const summary = createUserMessage({ content: 'RIG SUMMARY of the folded history', isCompactSummary: true })
  return {
    wasCompacted: true,
    compactionResult: { boundaryMarker, summaryMessages: [summary], attachments: [], hookResults: [], preCompactTokenCount: 900, postCompactTokenCount: 120, truePostCompactTokenCount: 120, compactionUsage: undefined },
  }
}
function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ file_path: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    call: async () => ({ data: 'rig' }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [makeTool('Read')], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
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
function seedOverLimit(anchorInputTokens: number): unknown[] {
  return [
    createUserMessage({ content: 'the lane ask' }),
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-a000-000000000001',
      timestamp: new Date().toISOString(),
      requestId: 'req_1',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'an earlier reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: anchorInputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
    createUserMessage({ content: 'the next ask' }),
  ]
}
type RunResult = { yields: AnyMsg[]; terminal: Record<string, unknown>; calls: CallRecord[]; compact: CompactCall[] }
async function run(ctx: Record<string, unknown>, seed: unknown[], script: unknown[][], answers: Array<Record<string, unknown>>): Promise<RunResult> {
  const { calls, callModel } = makeModel(script)
  const compact: CompactCall[] = []
  let n = 0
  const autocompact = async (_m: unknown[], _c: unknown, _cache: unknown, _s?: string, tracking?: unknown, _snip?: number, forced?: unknown) => {
    compact.push({ forced, tracking })
    if (forced !== undefined) return { wasCompacted: false, refusal: 'rig: the breaker' }
    return answers[Math.min(n++, answers.length - 1)]!
  }
  const gen = queryEvents({
    messages: seed as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: autocompact as never,
      uuid: (() => {
        let k = 0
        return () => `00000000-0000-4000-8000-${String(++k).padStart(12, '0')}`
      })(),
    } as never,
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    for (const y of legacyYieldsOf(r.value as never)) yields.push(y as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, terminal: r.value as Record<string, unknown>, calls, compact }
}
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)

section('B3 the road is true — the run after a paused refusal makes a fresh automatic attempt and, when it lands, the turn proceeds')
{
  saveGlobalConfig(c => ({ ...c, autoCompactWindow: 800_000 }))
  const ctx = makeCtx()
  const first = await run(ctx, seedOverLimit(778_000), [[ping(), asstText('never reached')]], [{ wasCompacted: false, consecutiveFailures: 3 }])
  const refusal = errorTexts(first.yields)[0] ?? ''
  check('run 1: the breaker refuses typed with zero model calls', first.terminal.reason === 'blocking_limit' && first.calls.length === 0, JSON.stringify(first.terminal))
  check('run 1: the refusal carries the sentence', refusal.includes(INTERACTIVE_LINE), refusal)
  const second = await run(ctx, seedOverLimit(778_000), [[ping(), asstText('the reply after the fresh fold')]], [rigFoldResult()])
  const firstAsk = second.compact[0]
  check('run 2: the compaction gate is asked afresh — no failure count rides in from the paused run', firstAsk !== undefined && ((firstAsk.tracking as { consecutiveFailures?: number } | undefined)?.consecutiveFailures ?? 0) === 0, JSON.stringify(firstAsk?.tracking))
  check('run 2: the fold landed and the reply came — one model call, terminal completed', second.terminal.reason === 'completed' && second.calls.length === 1 && textOf(second.yields.filter(y => y.type === 'assistant').at(-1)) === 'the reply after the fresh fold', JSON.stringify(second.terminal))
  check('run 2: the request opened on the fold\'s summary', second.calls[0] !== undefined && JSON.stringify(second.calls[0].messages).includes('RIG SUMMARY of the folded history'))
}

section('B4 the hand road — /compact reads no failure count: the command calls the fold directly')
{
  const command = readFileSync(join(ROOT, 'src/commands/compact/compact.ts'), 'utf8')
  check('the command calls compactConversation itself', /await compactConversation\(/.test(command))
  check('…and consults no breaker, no failure count, no automatic orchestration', !/consecutiveFailures|autoCompactIfNeeded|compactionBreakerAllows|MAX_CONSECUTIVE_FAILURES/.test(command))
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check('the failure count is seeded empty at every run entry — the pause is the run\'s', /autoCompactTracking: undefined,/.test(machine))
}

clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
