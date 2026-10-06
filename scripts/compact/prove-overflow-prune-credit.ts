#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-prune-credit-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-prune-credit-daemon-'))
for (const k of [
  'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'MERCURY_MODEL', 'MERCURY_PRUNE_PCT', 'MERCURY_DISABLE_1M_CONTEXT',
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
  console.log('\nTIMEOUT — overflow prune-credit prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
const fmt = (n: number): string => n.toLocaleString('en-US')

console.log('============================================================')
console.log(' the prune rung credits its saving on a usage-anchored view')
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
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/tmp/lane/module-${i}.ts` } }],
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
const BREAKER_TRIPPED = { wasCompacted: false, consecutiveFailures: 3 }

section('P1 the owner\'s shape — the breaker tripped, the view over the limit by a small gap, every prunable result before the anchor: the prune rung clears the old results and the retry GOES OUT')
{
  const seed = seedLongLane(20, 776_000, 16_000)
  const estimate = tokenCountWithEstimation(seed as never, MODEL)
  const saving = projectTimeBasedMicrocompact(seed as never, 'sdk', { pressure: true })?.tokensSaved ?? 0
  check(`the view is anchored on the last reply's usage and over the limit by a small gap (${fmt(estimate)} > ${fmt(BLOCKING)}; gap ${fmt(estimate - BLOCKING)})`, estimate > BLOCKING && estimate - BLOCKING < 10_000, `${estimate}`)
  check(`the prune rung's projected saving covers the gap and brings the view under the limit (~${fmt(saving)} tokens)`, saving >= (estimate - BLOCKING) * 1.2 && estimate - saving < BLOCKING, `${saving}`)
  const r = await run({ seed, script: [[ping(), asstText('the retry after the prune')]], compactAnswer: BREAKER_TRIPPED })
  const refusals = errorYields(r.yields).map(textOf)
  check('the retry after the prune went out: one model call, terminal completed', r.terminal.reason === 'completed' && r.calls.length === 1, `${JSON.stringify(r.terminal)} calls=${r.calls.length} refusals=${JSON.stringify(refusals)}`)
  check('the transition names the prune rung from the estimate', JSON.stringify(settledTransitions(r.events)).includes('"reason":"overflow_recovery","rung":"prune","source":"estimate"'), JSON.stringify(settledTransitions(r.events)))
  const notice = noticeTexts(r.yields).find(t => t.startsWith('context overflowed (estimated '))
  check(`the notice names the estimate, the count and the reclaimed tokens`, notice !== undefined && /^context overflowed \(estimated [\d,]+ tokens > 777,000\) — pruned \d+ superseded tool results \(~[\d,]+ tokens\) and retrying$/.test(notice), JSON.stringify(noticeTexts(r.yields)))
  const cleared = r.calls[0] !== undefined ? toolResultsOf(r.calls[0].messages).filter(x => isPlaceholder(x.content)) : []
  check(`the request on the wire carries the placeholders of the cleared results (${cleared.length} cleared) and the newest results whole`, r.calls[0] !== undefined && cleared.length >= 5 && !isPlaceholder(toolResultsOf(r.calls[0].messages).at(-1)?.content), JSON.stringify(cleared.map(c => c.id)))
  check('no refusal row ever yields — the number moved, the breaker was never asked', refusals.length === 0, JSON.stringify(refusals))
  check('no fold was forced past the breaker', r.compact.every(c => c.forced === undefined), JSON.stringify(r.compact.map(c => c.forced)))
  check('the last settled assistant is the reply', textOf(r.yields.filter(y => y.type === 'assistant').at(-1)) === 'the retry after the prune')
}

section('P2 the compaction gate reads the same credit — the freed tokens ride the decision on the pruned iteration only; a fresh anchor after the reply carries none')
{
  const seed = seedLongLane(20, 776_000, 16_000)
  const replyWithUsage = {
    type: 'assistant',
    uuid: '00000000-0000-4000-a000-000000000900',
    timestamp: new Date().toISOString(),
    requestId: 'req_reply',
    message: {
      id: 'msg_reply',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_after_prune', name: 'Read', input: { file_path: '/tmp/lane/next.ts' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 20, cache_creation_input_tokens: 500, cache_read_input_tokens: 602_000 },
    },
  }
  const r = await run({ seed, script: [[ping(), replyWithUsage], [ping(), asstText('the round after the prune')]], compactAnswer: BREAKER_TRIPPED })
  check('two model calls: the pruned retry, then the round after its tool result; terminal completed', r.terminal.reason === 'completed' && r.calls.length === 2, `${JSON.stringify(r.terminal)} calls=${r.calls.length}`)
  check('the gate was asked three times: before the prune, on the pruned iteration, after the reply anchored afresh', r.compact.length === 3, String(r.compact.length))
  const [first, second, third] = r.compact
  check('the first ask carried no credit (nothing was pruned yet)', first !== undefined && (first.snip ?? 0) === 0, JSON.stringify(first?.snip))
  const notice = noticeTexts(r.yields).find(t => t.startsWith('context overflowed (estimated ')) ?? ''
  const reclaimed = Number((/\(~([\d,]+) tokens\)/.exec(notice)?.[1] ?? '0').replace(/,/g, ''))
  check(`the second ask carried the prune's own receipt as its credit (${fmt(second?.snip ?? 0)} = the notice's ~${fmt(reclaimed)})`, second !== undefined && reclaimed > 0 && second.snip === reclaimed, `snip=${second?.snip} reclaimed=${reclaimed}`)
  check('the third ask carried no credit — the reply\'s own usage is the anchor now and already reads the pruned prompt', third !== undefined && (third.snip ?? 0) === 0, JSON.stringify(third?.snip))
  const retry = r.calls[1]
  const retryCount = retry !== undefined ? tokenCountWithEstimation(retry.messages as never, MODEL) : -1
  check(`the round after the reply counts from the fresh anchor (${fmt(retryCount)}, under the limit) with the placeholders still in place`, retry !== undefined && retryCount > 600_000 && retryCount < BLOCKING && toolResultsOf(retry.messages).some(x => isPlaceholder(x.content)), `${retryCount}`)
}

clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
