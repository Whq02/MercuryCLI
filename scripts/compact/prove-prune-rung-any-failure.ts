#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prune-rung-any-failure-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'prune-rung-any-failure-daemon-'))
for (const k of [
  'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { queryEvents } = await import('../../src/query.ts')
const { legacyYieldsOf } = await import('../../src/run-core/project-legacy.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { MC_DIGEST_PREFIX, MC_CLEARED_PLACEHOLDER } = await import('../../src/services/compact/microCompactDigest.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { projectTimeBasedMicrocompact } = await import('../../src/services/compact/microCompact.ts')
const { getBlockingLimit, getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../../src/services/api/errors.ts')

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
  console.log('\nTIMEOUT — the prune-rung prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
const fmt = (n: number): string => n.toLocaleString('en-US')

console.log('============================================================')
console.log(' the prune rung fires on any fold failure that is not the operator\'s own cancel')
console.log('============================================================')

saveGlobalConfig(c => ({ ...c, autoCompactWindow: 800_000 }))
const BLOCKING = getBlockingLimit(MODEL)
const THRESHOLD = getAutoCompactThreshold(MODEL)
check(`the owner's window: an 800,000 auto-compact window gives the 777,000 blocking limit and the 757,000 fold threshold`, BLOCKING === 777_000 && THRESHOLD === 757_000, `${BLOCKING} ${THRESHOLD}`)

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

type CompactCall = { messages: unknown[]; forced: unknown; tracking: unknown; snip: number | undefined }
function makeCompact(answer: Record<string, unknown>) {
  const calls: CompactCall[] = []
  const autocompact = async (messages: unknown[], _ctx: unknown, _cache: unknown, _source?: string, tracking?: unknown, snip?: number, forced?: unknown) => {
    calls.push({ messages: [...messages], forced, tracking, snip })
    if (forced !== undefined) return { wasCompacted: false, refusal: 'rig: the breaker' }
    return answer
  }
  return { calls, autocompact }
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
    options: {
      commands: [],
      tools: [makeTool('Read')],
      engineModel: MODEL,
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

type RunResult = { events: AnyEvent[]; yields: AnyMsg[]; terminal: Record<string, unknown>; calls: CallRecord[]; compact: CompactCall[] }
async function run(opts: { seed: unknown[]; script: unknown[][]; compactAnswer: Record<string, unknown> }): Promise<RunResult> {
  const ctx = makeCtx()
  const { calls, callModel } = makeModel(opts.script)
  const compact = makeCompact(opts.compactAnswer)
  const gen = queryEvents({
    messages: opts.seed as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: compact.autocompact as never,
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
  return { events, yields, terminal: r.value as Record<string, unknown>, calls, compact: compact.calls }
}

function seedLongLane(rounds: number, anchorInputTokens: number, resultChars: number): unknown[] {
  const out: unknown[] = [createUserMessage({ content: 'the lane ask: work through the modules' })]
  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1
    const id = `toolu_read_${String(i).padStart(3, '0')}`
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(100 + i).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/fixture/repeated-module.ts' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: last
          ? { input_tokens: 2, output_tokens: 8, cache_creation_input_tokens: 1_901, cache_read_input_tokens: anchorInputTokens - 1_903 }
          : { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    out.push({
      type: 'user',
      uuid: `00000000-0000-4000-b000-${String(100 + i).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `module ${i} body ${'const row = read(); '.repeat(Math.ceil(resultChars / 20))}` }] },
    })
  }
  return out
}
const toolResultsOf = (msgs: unknown[]): Array<{ id: string; content: unknown }> => {
  const out: Array<{ id: string; content: unknown }> = []
  for (const m of msgs as AnyMsg[]) {
    if (m.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(c)) continue
    for (const b of c as AnyMsg[]) if (b.type === 'tool_result') out.push({ id: String(b.tool_use_id), content: b.content })
  }
  return out
}
const isPlaceholder = (content: unknown): boolean =>
  typeof content === 'string' && (content === MC_CLEARED_PLACEHOLDER || content.startsWith(MC_DIGEST_PREFIX))
const settledTransitions = (events: AnyEvent[]): unknown[] => events.filter(e => e.kind === 'turn_settled').map(e => e.transition)
const noticeTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system').map(y => String(y.content ?? ''))
const errorYields = (yields: AnyMsg[]): AnyMsg[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true)
const { ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, ERROR_MESSAGE_USER_ABORT, ERROR_MESSAGE_FOLD_TIMEOUT } = await import('../../src/services/compact/compact.js')

async function pruneAfter(refusal: string, label: string, expectPrune: boolean): Promise<void> {
  const seed = seedLongLane(20, 776_000, 16_000)
  const estimate = tokenCountWithEstimation(seed as never, MODEL)
  const saving = projectTimeBasedMicrocompact(seed as never, 'sdk', { pressure: true })?.tokensSaved ?? 0
  check(`${label}: the view is over the limit by a small gap the prune covers (${fmt(estimate)} > ${fmt(BLOCKING)}; saving ≈${fmt(saving)})`, estimate > BLOCKING && saving >= (estimate - BLOCKING) * 1.2, `${estimate} ${saving}`)
  const r = await run({ seed, script: [[ping(), asstText('the retry after the prune')]], compactAnswer: { wasCompacted: false, consecutiveFailures: 1, refusal } })
  const refusals = errorYields(r.yields).map(textOf)
  if (expectPrune) {
    check(`${label}: the prune rung fired and the retry went out (one model call, terminal completed) — red on the base, where only the ceiling sentence unlocked the prune`, r.terminal.reason === 'completed' && r.calls.length === 1 && refusals.length === 0, `${JSON.stringify(r.terminal)} calls=${r.calls.length} refusals=${JSON.stringify(refusals).slice(0, 300)}`)
    check(`${label}: the transition names the prune rung from the estimate`, JSON.stringify(settledTransitions(r.events)).includes('"reason":"overflow_recovery","rung":"prune","source":"estimate"'), JSON.stringify(settledTransitions(r.events)))
    const cleared = r.calls[0] !== undefined ? toolResultsOf(r.calls[0].messages).filter(x => isPlaceholder(x.content)) : []
    check(`${label}: the request carries the cleared results' placeholders and the newest result whole`, r.calls[0] !== undefined && cleared.length >= 5 && !isPlaceholder(toolResultsOf(r.calls[0].messages).at(-1)?.content), JSON.stringify(cleared.map(c => c.id)))
  } else {
    check(`${label}: no prune, no call — the operator's own cancel ends the turn where it stood`, r.calls.length === 0 && r.terminal.reason !== 'completed', `${JSON.stringify(r.terminal)} calls=${r.calls.length}`)
  }
}

section('Q1 the loop-head fold failed with the ceiling sentence: the prune rung fires (the base\'s one unlocked case, unchanged)')
await pruneAfter(ERROR_MESSAGE_POST_COMPACT_OVER_THRESHOLD, 'ceiling', true)

section('Q2 the loop-head fold failed for any other reason — the summariser stalled, a provider refusal in its own words, a generic failure: the prune rung fires too (red on the base: the typed refusal "the fold failed (…)" and a terminal blocking_limit with zero calls)')
await pruneAfter(ERROR_MESSAGE_FOLD_TIMEOUT, 'stall timeout', true)
await pruneAfter('API Error: 400 the provider refused this request', 'a provider refusal in its own words', true)
await pruneAfter('The summariser produced no summary: the answer had no text (stop reason end_turn; 0 thinking blocks, 0 tool calls)', 'a no-summary answer at the floor', true)

section('Q3 the operator\'s own cancel is not a failure the prune answers')
await pruneAfter(ERROR_MESSAGE_USER_ABORT, 'cancel', false)

clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
