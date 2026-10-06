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
  console.log('\nTIMEOUT — long-lane shape prover exceeded 300s')
  process.exit(1)
}, 300_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
  'MERCURY_PRUNE_PCT', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_STREAM_IDLE_TIMEOUT_MS', 'MERCURY_CTX_COMPACTION', 'MERCURY_TIME_BASED_MC',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'overflow-long-lane-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'overflow-long-lane-daemon-'))
process.env.MERCURY_CREWS_DIR = mkdtempSync(join(tmpdir(), 'overflow-long-lane-crews-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
type Turn = import('./overflowFixture.ts').Turn
type Captured = import('./overflowFixture.ts').Captured
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' the long lane\'s shape through the whole road, over the loopback')
console.log('============================================================')

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { contextFill, tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { getBlockingLimit, getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')
const { refusalRetryChunkChars, conversationAsText, FOLD_REFUSED_RETRY_NOTE } = await import('../../src/services/compact/compact.ts')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { getSdkBetas } = await import('../../src/bootstrap/state.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-5-5'
const fmt = (n: number): string => n.toLocaleString('en-US')
const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'max' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
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

function seedLongLane(rounds: number, anchorInputTokens: number, resultChars: number): unknown[] {
  const out: unknown[] = [createUserMessage({ content: 'the lane ask: work through every module of the estate, land each fix with its proof, and keep the notes tidy' })]
  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1
    const id = `toolu_${String(i).padStart(4, '0')}`
    const name = i % 3 === 0 ? 'Bash' : i % 3 === 1 ? 'Read' : 'Edit'
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(1000 + i).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [
          { type: 'text', text: `step ${i}: ${name === 'Bash' ? 'running the suite' : name === 'Read' ? 'reading the module' : 'landing the edit'} for module ${i % 40}` },
          { type: 'tool_use', id, name, input: name === 'Bash' ? { command: `bun scripts/suite-${i % 40}/run-all.sh` } : { file_path: `/tmp/lane/module-${i % 40}.ts` } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: last
          ? { input_tokens: 2, output_tokens: 8, cache_creation_input_tokens: 1_901, cache_read_input_tokens: anchorInputTokens - 1_903 }
          : { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    out.push({
      type: 'user',
      uuid: `00000000-0000-4000-b000-${String(1000 + i).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `${name} result ${i}: ${'[PASS] the check holds and the row reads as it should; '.repeat(Math.ceil(resultChars / 56))}` }] },
    })
  }
  return out
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; wire: Captured[] }
async function drive(ctx: Record<string, unknown>, messages: unknown[]): Promise<Drive> {
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
      toolUseContext: ctx as never,
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
const boundaryOf = (yields: AnyMsg[]): AnyMsg | undefined => yields.find(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary')
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)
const noticeTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system' && (y as { subtype?: string }).subtype !== 'compact_boundary').map(y => String(y.content ?? ''))
const isSummariserRequest = (body: Record<string, unknown>): boolean => /summar/i.test(JSON.stringify((body.messages as unknown[] | undefined)?.at(-1) ?? ''))
const bodyTokens = (body: Record<string, unknown>): number => Math.ceil(JSON.stringify(body).length / 4)

saveGlobalConfig(c => ({ ...c, autoCompactWindow: 800_000 }))
const BLOCKING = getBlockingLimit(MODEL)
const THRESHOLD = getAutoCompactThreshold(MODEL)
const WIRE_WINDOW = getContextWindowForModel(MODEL, getSdkBetas())
const wirePromptTooLong = (actual: number): Turn => ({
  error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${actual} tokens > ${WIRE_WINDOW} maximum` } } },
})
function scriptWithWireLaw(turns: Turn[]): void {
  let ordinal = 0
  fixture.script((request: Captured) => {
    const actual = bodyTokens(request.body)
    if (actual > WIRE_WINDOW) return wirePromptTooLong(actual)
    return turns[ordinal++] ?? { text: 'script exhausted' }
  })
}

section('S1 the shape — the 800,000-token window setting, a 760,000-token anchor, 320 tool rounds of large results: the fold threshold is crossed and the text is bigger than one part')
const seed = seedLongLane(320, 760_000, 10_000)
const ctx = makeCtx()
const estimate = tokenCountWithEstimation(seed as never, MODEL)
const chunkChars = refusalRetryChunkChars(MODEL)
const textChars = conversationAsText(seed as never).length
const partCount = Math.ceil(textChars / chunkChars)
check(`the window setting gives the owner's numbers: fold at ${fmt(THRESHOLD)}, blocked at ${fmt(BLOCKING)}; the wire's own window is ${fmt(WIRE_WINDOW)}`, THRESHOLD === 757_000 && BLOCKING === 777_000 && WIRE_WINDOW === 1_000_000)
check(`the view by Mercury's count is over the fold threshold and under the blocking limit (${fmt(estimate)})`, estimate >= THRESHOLD && estimate < BLOCKING, String(estimate))
check(`the conversation as text (${fmt(textChars)} chars) is bigger than one refusal-retry part (${fmt(chunkChars)} chars): ${partCount} parts`, partCount >= 2, `${textChars} ${chunkChars}`)
check('the shape holds hundreds of tool rounds (641 rows)', seed.length === 641, String(seed.length))

section('S2 the road — the summariser refuses the conversation as the owner\'s did, on the fork lane and again on the direct lane; the retry walks the parts as text; the whole lands; the boundary rows; the retry answers; the run completes')
{
  scriptWithWireLaw([
    { refusal: true },
    { refusal: true },
    ...Array.from({ length: partCount }, (_, index) => ({ text: `PART ${index + 1}: the lane worked modules of the estate, each fix landing with its proof.` })),
    { text: 'WHOLE SUMMARY: the lane worked through every module of the estate, landing each fix with its proof; the notes stayed tidy; the next step is the remaining suites.' },
    { text: 'the reply after the fold', usage: { input: 9_000, output: 12 } },
  ])
  const r = await drive(ctx, seed)
  const summaries = r.wire.filter(w => isSummariserRequest(w.body))
  check('the run completed without throwing', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} errors=${JSON.stringify(errorTexts(r.yields))}`)
  check(`${4 + partCount} requests reached the wire: the refused fold on the fork lane, the refused fold on the direct lane, ${partCount} parts as text, the whole, then the retry`, r.wire.length === 4 + partCount, `${r.wire.length}: ${r.wire.map(w => (isSummariserRequest(w.body) ? 'summary' : 'turn')).join(',')}`)
  check(`${3 + partCount} of them were summary requests`, summaries.length === 3 + partCount, String(summaries.length))
  check('every request fit the wire\'s window (no prompt-too-long answer was ever needed)', fixture.refusals.length === 0 && r.wire.every(w => bodyTokens(w.body) <= WIRE_WINDOW), JSON.stringify(r.wire.map(w => bodyTokens(w.body))))
  const parts = summaries.slice(2, 2 + partCount)
  check('every part request hands the conversation over as text in a user turn — no assistant row, no tool round replayed', parts.length === partCount && parts.every(p => ((p.body.messages as Array<{ role: string }>) ?? []).every(row => row.role === 'user')), JSON.stringify(parts.map(p => ((p.body.messages as unknown[]) ?? []).length)))
  const whole = summaries.at(-1)
  check('the whole opens on the parts\' summaries', whole !== undefined && JSON.stringify(whole.body).includes('PART 1: the lane worked') && JSON.stringify(whole.body).includes(`PART ${partCount}: the lane worked`))
  const boundary = boundaryOf(r.yields)
  const meta = (boundary as { compactMetadata?: { trigger?: string; preTokens?: number } } | undefined)?.compactMetadata
  check(`the compact_boundary row yields, typed 'auto', carrying the folded weight (${fmt(meta?.preTokens ?? 0)})`, meta?.trigger === 'auto' && typeof meta.preTokens === 'number' && meta.preTokens >= THRESHOLD, JSON.stringify(meta))
  const summaryRow = r.yields.find(y => y.type === 'user' && (y as { isCompactSummary?: boolean }).isCompactSummary === true)
  check('the summary that lands is the whole\'s answer', summaryRow !== undefined && textOf(summaryRow).includes('WHOLE SUMMARY: the lane worked through every module'), summaryRow !== undefined ? textOf(summaryRow).slice(0, 200) : 'no summary row')
  check('the refusal-retry note exists for the hand road\'s outcome row (the automatic fold keeps it on its result)', typeof FOLD_REFUSED_RETRY_NOTE === 'string' && FOLD_REFUSED_RETRY_NOTE.length > 0)
  const retry = r.wire.at(-1)
  check('the retried request opens on the summary and carries none of the folded rounds', retry !== undefined && !isSummariserRequest(retry.body) && JSON.stringify(retry.body).includes('WHOLE SUMMARY') && !JSON.stringify(retry.body).includes('Bash result 3:'), retry !== undefined ? String(bodyTokens(retry.body)) : 'no retry')
  check('the last settled assistant is the reply', textOf(r.yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage !== true).at(-1)) === 'the reply after the fold')
  check('no refusal row, no overflow notice: the fold ran at the loop head, never through the emergency ladder', errorTexts(r.yields).length === 0 && !noticeTexts(r.yields).some(t => t.startsWith('context overflowed')), JSON.stringify({ errors: errorTexts(r.yields), notices: noticeTexts(r.yields) }))
  const transcript = [...seed, ...r.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'system')]
  const fill = contextFill(transcript as never, MODEL)
  check(`the gauge after the fold anchors on the reply's own usage (${fmt(fill.tokens)}), never the folded weight`, fill.source === 'usage' && fill.tokens === 9_012, JSON.stringify(fill))
}

section('S3 the wire\'s own law stands in the rig — a request over the wire\'s window is refused as the home wire refuses it')
{
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  const over = wirePromptTooLong(1_200_000)
  check('the rig\'s refusal is the home wire\'s shape (status 400, invalid_request_error, "prompt is too long")', 'error' in over && over.error.status === shape.status && /prompt is too long: 1200000 tokens > 1000000 maximum/.test(JSON.stringify(over.error.body)))
}

await fixture.close()
clearTimeout(watchdog)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
