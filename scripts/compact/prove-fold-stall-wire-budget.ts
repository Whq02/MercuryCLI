#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_(MODEL|SMALL_FAST_MODEL)|MERCURY_OAUTH_TOKEN|MERCURY_SCRIPTED_STREAM|MERCURY_BARE|MERCURY_MAX_OUTPUT_TOKENS|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MERCURY_THINKING_BUDGET|MERCURY_COMPACT_KEEP_TAIL|MERCURY_AUTOCOMPACT_PCT_OVERRIDE|MERCURY_BLOCKING_LIMIT_OVERRIDE|MERCURY_DISABLE_1M_CONTEXT|MERCURY_COMPACT|MERCURY_AUTO_COMPACT|MERCURY_CTX_COMPACTION|MERCURY_THINKING_BINDING|MERCURY_STREAM_IDLE_TIMEOUT_MS|MERCURY_SILENT_AFTER_HEADERS_MS|MERCURY_TOOL_DEFER_PROBE|DEBUG)$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^HF_TOKEN$/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-stall-wire-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_DIR
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const DEBUG_LOG = join(CONFIG_DIR, 'debug.txt')
process.argv.push(`--log-file=${DEBUG_LOG}`)

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
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — fold stall wire-budget prover exceeded 420s')
  process.exit(1)
}, 420_000)
guard.unref?.()

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
const SUMMARY_TEXT = 'Fixture summary: the lane worked through the modules, the suite ran green, and the changelog entry is the next step.'
const SILENCE_MS = 123_000
const FLAT_STALL_MS = 120_000

type Seen = { n: number; startedAt: number; firstEventAt?: number; summaryAt?: number; closedAt?: number; finished: boolean }
const seen: Seen[] = []
const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
function writeSummary(res: ServerResponse, entry: Seen, n: number): void {
  res.write(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SUMMARY_TEXT } }))
  res.write(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
  res.write(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  res.write(evt('message_stop', { type: 'message_stop' }))
  entry.summaryAt = Date.now()
  entry.finished = true
  res.end()
}
const silentServer = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const n = seen.length + 1
    const entry: Seen = { n, startedAt: Date.now(), finished: false }
    seen.push(entry)
    let timer: NodeJS.Timeout | null = null
    res.on('close', () => {
      entry.closedAt = Date.now()
      if (timer !== null) clearTimeout(timer)
    })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(evt('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage } }))
    entry.firstEventAt = Date.now()
    timer = setTimeout(() => {
      if (!res.destroyed) writeSummary(res, entry, n)
    }, SILENCE_MS)
  })
})
await new Promise<void>(resolve => silentServer.listen(0, '127.0.0.1', resolve))
const silentAddress = silentServer.address()
const SILENT_BASE = `http://127.0.0.1:${typeof silentAddress === 'object' && silentAddress ? silentAddress.port : 0}`

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation, shouldRideCacheSharingFork } = compactModule
const foldStallMsFor: ((model: string, floorMs?: number) => number) | undefined = (compactModule as { foldStallMsFor?: (model: string, floorMs?: number) => number }).foldStallMsFor
const { streamIdleTimeoutMsForRoute, STREAM_IDLE_DEFAULT_MS } = await import('../../src/services/providers/streamIdleBudget.ts')
const { PATIENCE_NORMAL } = await import('../../src/services/providers/patience.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')

const HOME_MODEL = 'claude-opus-5-5'
const OPENAI_MODEL = 'gpt-5.6-sol'
let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function assistantRow(model: string, text: string, inputTokens = 100): unknown {
  const id = `msg_${nextUuid().slice(-6)}`
  return {
    type: 'assistant',
    uuid: nextUuid(),
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }
}
function makeMessages(model: string): unknown[] {
  return [
    createUserMessage({ content: 'please work through the modules and run the tests' }),
    assistantRow(model, 'Worked through the modules and ran the suite — all green.'),
    createUserMessage({ content: 'now write the changelog entry' }),
  ]
}
type Run = { result?: Record<string, unknown>; error?: Error; ms: number }
async function runFold(model: string, history: unknown[] = makeMessages(model)): Promise<Run> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = { toolPermissionContext, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: { tools: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig: { type: 'disabled' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
  const messages = history
  const posture = asSystemPrompt(['You are a fixture-driven session posture.'])
  const cacheSafe = shouldRideCacheSharingFork(model, { type: 'disabled' })
    ? { systemPrompt: posture, userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: messages }
    : { systemPrompt: posture }
  const startedAt = Date.now()
  let result: Record<string, unknown> | undefined
  let error: Error | undefined
  try {
    result = (await compactConversation(messages as never, ctx as never, cacheSafe as never, true)) as never as Record<string, unknown>
  } catch (err) {
    error = err as Error
  }
  return { result, error, ms: Date.now() - startedAt }
}
const summaryOf = (run: Run): string => j(run.result?.summaryMessages ?? [])
let debugCursor = 0
function debugLinesSince(): string[] {
  const text = existsSync(DEBUG_LOG) ? readFileSync(DEBUG_LOG, 'utf8') : ''
  const fresh = text.slice(debugCursor)
  debugCursor = text.length
  return fresh.split('\n').filter(l => l.includes('compact:'))
}

console.log('============================================================')
console.log(' the fold\'s stall after the first event is the wire\'s own idle budget')
console.log('============================================================')

section('§1 the law, pure — the stall after the first event is the wire\'s idle budget for the model\'s route, never under the flat floor')
check('the law exists (foldStallMsFor)', typeof foldStallMsFor === 'function')
if (typeof foldStallMsFor === 'function') {
  const anthropicIdle = streamIdleTimeoutMsForRoute('anthropic')
  check(`a home-wire model waits the Anthropic idle budget (${anthropicIdle} ms = the patience's 6 minutes)`, foldStallMsFor(HOME_MODEL) === anthropicIdle && anthropicIdle === PATIENCE_NORMAL.streamIdleMs && anthropicIdle === 360_000, String(foldStallMsFor(HOME_MODEL)))
  const openaiIdle = streamIdleTimeoutMsForRoute('openai')
  check(`an OpenAI model waits the quiet idle budget (${openaiIdle} ms = the patience's 15 minutes)`, foldStallMsFor(OPENAI_MODEL) === openaiIdle && openaiIdle === PATIENCE_NORMAL.quietStreamIdleMs, String(foldStallMsFor(OPENAI_MODEL)))
  check(`a model with no route keeps the flat floor (${FLAT_STALL_MS} ms = the default idle budget)`, foldStallMsFor('no-such-model-anywhere') === FLAT_STALL_MS && STREAM_IDLE_DEFAULT_MS === FLAT_STALL_MS, String(foldStallMsFor('no-such-model-anywhere')))
  check('a floor above the wire\'s budget stands', foldStallMsFor(HOME_MODEL, 1_000_000) === 1_000_000)
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '200000'
  check('the wire\'s pinned idle budget is the fold\'s stall too (200 s pinned → 200,000 ms)', foldStallMsFor(HOME_MODEL) === 200_000, String(foldStallMsFor(HOME_MODEL)))
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '30000'
  check('a pinned budget under the floor never lowers the stall below the floor (30 s pinned → 120,000 ms)', foldStallMsFor(HOME_MODEL) === FLAT_STALL_MS, String(foldStallMsFor(HOME_MODEL)))
  delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
}

section('§2 the armed bound names the wire\'s number — both lanes over the loopback at production bounds')
{
  fixture.script([{ text: SUMMARY_TEXT }])
  debugLinesSince()
  const fork = await runFold(HOME_MODEL)
  const forkLines = debugLinesSince()
  check('the home model rides the fork lane', shouldRideCacheSharingFork(HOME_MODEL, { type: 'disabled' }) === true)
  check(`the fold landed over the loopback (${fork.ms} ms)`, fork.result !== undefined && fork.error === undefined && summaryOf(fork).includes(SUMMARY_TEXT), (fork.error?.message ?? '').slice(0, 300))
  check('the fork lane\'s bound was armed with the Anthropic idle budget as its stall (stall 360000 ms after the first event)', forkLines.some(l => /fork lane bound armed — first-byte allowance \d+ ms for ≈\d+ tokens, stall 360000 ms after the first event/.test(l)), j(forkLines))
  check('the first-byte allowance is never shorter than the route idle budget', forkLines.some(l => /fork lane bound armed — first-byte allowance 360000 ms for ≈\d+ tokens/.test(l)), j(forkLines))
  check('the fork lane itself landed the summary — no hand-over to the direct call', !forkLines.some(l => /handing over to the direct call/.test(l)) && !forkLines.some(l => /direct lane bound armed/.test(l)), j(forkLines))

  fixture.script([{ text: SUMMARY_TEXT }])
  debugLinesSince()
  const direct = await runFold(OPENAI_MODEL)
  const directLines = debugLinesSince()
  check('the OpenAI model rides the direct lane', shouldRideCacheSharingFork(OPENAI_MODEL, { type: 'disabled' }) === false)
  check(`the fold landed over the loopback (${direct.ms} ms)`, direct.result !== undefined && direct.error === undefined && summaryOf(direct).includes(SUMMARY_TEXT), (direct.error?.message ?? '').slice(0, 300))
  check('the direct lane\'s bound was armed with the quiet idle budget as its stall (stall 900000 ms after the first event)', directLines.some(l => /direct lane bound armed — first-byte allowance \d+ ms for ≈\d+ tokens, stall 900000 ms after the first event/.test(l)), j(directLines))
}

section(`§3 the long lane's death, driven — the summariser sends its first event, then nothing for ${SILENCE_MS / 1000} s (past the flat 120 s, well inside the wire's 6 minutes), then the summary: the fold LANDS on the fork lane`)
{
  const savedBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = SILENT_BASE
  debugLinesSince()
  const run = await runFold(HOME_MODEL)
  const lines = debugLinesSince()
  process.env.ANTHROPIC_BASE_URL = savedBase
  const first = seen[0]
  check(`the fold landed after ${run.ms} ms with the whole summary`, run.result !== undefined && run.error === undefined && summaryOf(run).includes(SUMMARY_TEXT), (run.error?.message ?? '').slice(0, 300))
  check(`one request reached the wire, completed by the server after its ${SILENCE_MS} ms silence (never a hand-over to the direct lane)`, seen.length === 1 && first !== undefined && first.finished, j(seen.map(s => ({ n: s.n, finished: s.finished, silentMs: (s.summaryAt ?? 0) - (s.firstEventAt ?? 0) }))))
  check(`the fold outlived the flat stall: ${run.ms} ms ≥ ${SILENCE_MS} ms`, run.ms >= SILENCE_MS, String(run.ms))
  check('no fold bound was hit and no lane was cut', !lines.some(l => /hit its fold bound|lane cut for/.test(l)), j(lines))
  check('the fork lane recorded its summary, not a hand-over', lines.some(l => /fork lane bound armed/.test(l)) && !lines.some(l => /handing over to the direct call/.test(l)), j(lines))
}

section('§4 the first-byte allowance on a cold prefix is never shorter than the transport\'s own first-byte budget (the fold waits at least as long as the session\'s turn would)')
{
  const { firstByteBudgetMs, coldPrefixOf } = await import('../../src/services/providers/streamIdleBudget.ts')
  const allowanceOf = (lines: string[]): { allowance: number; tokens: number; prefix: string } | null => {
    const line = lines.find(l => /fork lane bound armed — first-byte allowance \d+ ms for ≈\d+ tokens/.test(l))
    const m = line === undefined ? null : /first-byte allowance (\d+) ms for ≈(\d+) tokens.*\((cold|warm) prefix\)/.exec(line)
    return m === null ? null : { allowance: Number(m[1]), tokens: Number(m[2]), prefix: m[3]! }
  }
  fixture.script([{ text: SUMMARY_TEXT }])
  debugLinesSince()
  const warmRun = await runFold(HOME_MODEL)
  const warm = allowanceOf(debugLinesSince())
  check(`warm prefix (the last reply is ${HOME_MODEL}'s): the fold landed`, warmRun.result !== undefined && warmRun.error === undefined, (warmRun.error?.message ?? '').slice(0, 300))
  check('warm prefix: the armed line names it warm and the allowance is the route idle budget (360000 ms)', warm !== null && warm.prefix === 'warm' && warm.allowance === 360_000, j(warm))
  const longAsk = createUserMessage({ content: 'carry every detail of this long exploration into the summary: ' + 'the parser accepts quoted commas, the CLI verifies the output, '.repeat(400) })
  const coldHistory = [longAsk, assistantRow('claude-opus-4-1', 'Worked through the modules under the previous model.', 150_000), createUserMessage({ content: 'now write the changelog entry' })]
  check('the cold history reads cold to the transport\'s own prefix reader (the last reply came from another model)', coldPrefixOf(coldHistory, HOME_MODEL) === true)
  fixture.script([{ text: SUMMARY_TEXT }])
  debugLinesSince()
  const coldRun = await runFold(HOME_MODEL, coldHistory)
  const cold = allowanceOf(debugLinesSince())
  check('cold prefix: the fold landed', coldRun.result !== undefined && coldRun.error === undefined, (coldRun.error?.message ?? '').slice(0, 300))
  const transport = cold === null ? Number.NaN : firstByteBudgetMs({ cold: true, promptTokens: cold.tokens, idleMs: 360_000 })
  check(`cold prefix: the armed line names it cold and the allowance (${cold?.allowance} ms for ≈${cold?.tokens} tokens) is at least the transport's own cold first-byte budget (${transport} ms) — longer than the route idle budget alone`, cold !== null && cold.prefix === 'cold' && cold.allowance >= transport && transport > 360_000, j({ cold, transport }))
}

fixture.close()
silentServer.closeAllConnections?.()
await new Promise<void>(resolve => silentServer.close(() => resolve()))
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
