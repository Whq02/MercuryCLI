#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'ANTHROPIC_API_KEY', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION']) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-ladder-replay-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the fold ladder replay exceeded 300s')
  process.exit(1)
}, 300_000)
watchdog.unref?.()

const { startOverflowFixture } = await import('./overflowFixture.ts')
type Captured = import('./overflowFixture.ts').Captured
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { refreshGeminiCatalogue } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { getAutoCompactThreshold, getBlockingLimit } = await import('../../src/services/compact/autoCompact.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { requestGaugeDigest } = await import('../../src/services/run/requestGauge.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { compactConversation, buildPostCompactMessages, PROSE_SKIPPED_KEY } = await import('../../src/services/compact/compact.ts')
const { loadTranscriptFromFile } = await import('../../src/utils/sessionStorage/logs.ts')
type Message = import('../../src/types/message.ts').Message

const SHAPE_PATH = join(import.meta.dir, 'fixtures', 'argon-seat-shape-2026-10-17.json')
const shape = JSON.parse(readFileSync(SHAPE_PATH, 'utf8')) as { model: string; window: number; rows: Array<Record<string, unknown>> }
const MODEL: string = shape.model
const WINDOW: number = shape.window
const GEMINI_CHARS_PER_TOKEN = 2.94
const countOf = (body: Record<string, unknown>): number => Math.round(JSON.stringify(body).length / GEMINI_CHARS_PER_TOKEN)

const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ models: [{ name: `models/${MODEL}`, displayName: 'fixture', inputTokenLimit: WINDOW, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
await refreshGeminiCatalogue('api-key', { force: true, fetchImpl })

let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function filler(chars: number, label: string): string {
  if (chars <= 0) return ''
  const unit = `${label}: a fixture line standing in for the recorded bytes\n`
  let out = ''
  let n = 0
  while (out.length < chars) out += `${++n}\t${unit}`
  return out.slice(0, chars)
}
function messagesFromShape(rows: Array<Record<string, unknown>>): Message[] {
  const out: Message[] = []
  for (const row of rows) {
    if (row.type === 'user') {
      const meta = row.meta === true
      if (typeof row.text === 'number') {
        out.push(createUserMessage({ content: filler(row.text, 'operator text'), isMeta: meta }))
        continue
      }
      const blocks = (row.blocks as Array<Record<string, unknown>>).map(block =>
        block.kind === 'tool_result'
          ? { type: 'tool_result', tool_use_id: String(block.id), content: filler(Number(block.chars), `result ${String(block.id)}`), ...(block.error === true ? { is_error: true } : {}) }
          : { type: 'text', text: filler(Number(block.chars ?? 0), 'text') },
      )
      out.push(createUserMessage({ content: blocks as never, isMeta: meta }))
      continue
    }
    if (row.type !== 'assistant') continue
    const blocks = (row.blocks as Array<Record<string, unknown>>).map(block => {
      if (block.kind === 'tool_use') return { type: 'tool_use', id: String(block.id), name: String(block.name), input: typeof block.file === 'string' ? { file_path: block.file } : { command: 'fixture' } }
      if (block.kind === 'thinking') return { type: 'thinking', thinking: filler(Number(block.chars), 'thought'), signature: 'fixture-signature' }
      return { type: 'text', text: filler(Number(block.chars ?? 0), 'reply') }
    })
    const usage = row.usage as { input: number; output: number; cacheRead: number; cacheCreate: number }
    const message = {
      type: 'assistant',
      uuid: nextUuid(),
      timestamp: new Date().toISOString(),
      requestId: `req_${uuidSeq}`,
      message: {
        id: String(row.id),
        type: 'message',
        role: 'assistant',
        model: String(row.model),
        content: blocks,
        stop_reason: (row.stop as string | null) ?? null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheCreate },
      },
      ...(row.gauge !== undefined ? { contextGauge: { version: 1, ...(row.gauge as Record<string, unknown>), digest: '' } } : {}),
    } as unknown as Message
    out.push(message)
  }
  return out
}
function anchorGauge(messages: Message[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index] as Message & { contextGauge?: { digest: string } }
    if (row.type !== 'assistant' || row.contextGauge === undefined) continue
    let first = index
    for (let at = index - 1; at >= 0; at--) {
      const earlier = messages[at] as Message
      if (earlier.type !== 'assistant') continue
      if (earlier.message.id !== row.message.id) break
      first = at
    }
    row.contextGauge.digest = requestGaugeDigest(messages.slice(0, first))
    return
  }
}

function operatorAsk(messages: Message[]): string {
  const first = messages.find(row => row.type === 'user' && typeof (row as { message: { content: unknown } }).message.content === 'string') as { message: { content: string } } | undefined
  return JSON.stringify((first?.message.content ?? '').slice(0, 40)).slice(1, -1)
}
function toolUseIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const row of messages) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) continue
    for (const block of row.message.content as Array<{ type?: string; id?: string }>) if (block.type === 'tool_use' && typeof block.id === 'string') ids.push(block.id)
  }
  return ids
}
const firstToolUseId = (messages: Message[]): string | null => toolUseIds(messages)[0] ?? null
const lastToolUseId = (messages: Message[]): string | null => toolUseIds(messages).at(-1) ?? null

const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
type Drive = { landed: boolean; error?: string; pre?: number; post?: number; kept?: number; notes?: string[]; sent: number[]; summaryText?: string; ms: number }
async function fold(messages: Message[], road: 'auto' | 'manual'): Promise<Drive> {
  const sent: number[] = []
  fixture.script((request: Captured) => {
    const tokens = countOf(request.body)
    sent.push(tokens)
    if (tokens > Math.floor(WINDOW * 0.95)) return { text: '' }
    return { text: '<summary>1. Operator Intent: a research memo on context compaction.\n8. Where Work Stands: eleven repositories read; the memo is being written.\n10. Agents in flight: none.</summary>', usage: { input: tokens, output: 80 } }
  })
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: () => {},
    messages,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: { tools: [], commands: [], mcpClients: [], engineModel: MODEL, maxThinkingTokens: 0, thinkingConfig: { type: 'enabled', budget_tokens: 8_000 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
  }
  const cache = { systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages } as never
  const started = Date.now()
  try {
    const result = await compactConversation(messages, context as never, cache, road === 'auto', undefined, road === 'auto', { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: getAutoCompactThreshold(MODEL) }, undefined, MODEL)
    const summary = result.summaryMessages[0]
    const summaryText = summary !== undefined && typeof summary.message.content === 'string' ? summary.message.content : ''
    return { landed: true, pre: result.preCompactTokenCount, post: result.truePostCompactTokenCount, kept: result.messagesToKeep?.length ?? 0, notes: result.notes, sent, summaryText, ms: Date.now() - started }
  } catch (error) {
    return { landed: false, error: error instanceof Error ? error.message : String(error), sent, ms: Date.now() - started }
  }
}

async function replay(label: string, messages: Message[]): Promise<void> {
  const gauge = tokenCountWithEstimation(messages, MODEL)
  record(`${label}: ${messages.length} messages; the gauge reads ${gauge.toLocaleString('en-US')} tokens on a ${WINDOW.toLocaleString('en-US')}-token window (fold threshold ${getAutoCompactThreshold(MODEL).toLocaleString('en-US')}, blocking limit ${getBlockingLimit(MODEL).toLocaleString('en-US')})`)
  check(`${label}: the window resolved from the catalogue`, getContextWindowForModel(MODEL) === WINDOW, String(getContextWindowForModel(MODEL)))
  check(`${label}: the conversation stands between the fold threshold and the window, as the dead seat did`, gauge > 950_000 && gauge < WINDOW, String(gauge))
  for (const road of ['auto', 'manual'] as const) {
    const before = fixture.captured.length
    const run = await fold(messages, road)
    const requests = fixture.captured.slice(before)
    record(`${label} · ${road} road: ${run.landed ? 'LANDED' : `FAILED (${run.error ?? ''})`} after ${run.sent.length} summariser request(s) counted ${run.sent.map(n => n.toLocaleString('en-US')).join(', ')} tokens by the provider's density; ${run.ms} ms${run.landed ? `; context ${run.pre?.toLocaleString('en-US')} → ${run.post?.toLocaleString('en-US')} tokens, ${run.kept} messages kept verbatim` : ''}`)
    check(`${label} · ${road}: the fold landed (red on the base: "Failed to generate a conversation summary." after one request over the window)`, run.landed, run.error ?? '')
    check(`${label} · ${road}: rung 1 landed it in ONE summariser request`, run.sent.length === 1, String(run.sent.length))
    check(`${label} · ${road}: that request fitted the window by the provider's own count`, run.sent.every(n => n <= Math.floor(WINDOW * 0.95)), run.sent.join(','))
    const wire = requests.length === 1 ? JSON.stringify(requests[0]?.body) : ''
    const firstCall = firstToolUseId(messages)
    const lastCall = lastToolUseId(messages)
    check(`${label} · ${road}: the request carried the operator's ask and the oldest round (nothing dropped unsummarised) and left out the newest round (the kept tail split off before the send)`, wire.includes(operatorAsk(messages)) && (firstCall === null || wire.includes(firstCall)) && (lastCall === null || !wire.includes(lastCall)), `first ${firstCall} ${wire.includes(firstCall ?? '')} · last ${lastCall} ${wire.includes(lastCall ?? '')}`)
    check(`${label} · ${road}: the prose summary was written by the model (no skipped-prose line)`, run.landed && !(run.summaryText ?? '').includes(PROSE_SKIPPED_KEY) && (run.notes ?? []).length === 0, JSON.stringify(run.notes))
    check(`${label} · ${road}: the post-fold context is under the fold threshold with a verbatim tail kept`, run.landed && (run.post ?? Infinity) < getAutoCompactThreshold(MODEL) && (run.kept ?? 0) > 0, `${run.post} / ${run.kept}`)
  }
}

section('F1 the dead seat\'s own shape: 178 whole-file reads on a 1,048,576-token window, one turn past the fold threshold — the automatic fold and a manual /compact both land')
{
  const messages = messagesFromShape(shape.rows)
  anchorGauge(messages)
  await replay('shape fixture', messages)
}

section('F2 the recorded transcript itself when the box carries it (MERCURY_COMPACTION_FIXTURE names the .jsonl; absent elsewhere, the shape above stands for it)')
{
  const path = process.env.MERCURY_COMPACTION_FIXTURE
  if (path !== undefined && path !== '' && existsSync(path)) {
    const listing = await loadTranscriptFromFile(path)
    const messages = (listing.messages as Message[]).filter(row => (row as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true)
    record(`recorded transcript: ${path}`)
    await replay('recorded transcript', messages)
  } else {
    record('no recorded transcript named (MERCURY_COMPACTION_FIXTURE unset or absent) — the shape fixture stands for it')
  }
}

section('F3 the landed fold is a usable context: boundary, operator messages, summary, kept tail')
{
  const messages = messagesFromShape(shape.rows)
  anchorGauge(messages)
  const run = await (async () => {
    fixture.script((request: Captured) => (countOf(request.body) > Math.floor(WINDOW * 0.95) ? { text: '' } : { text: '<summary>1. Operator Intent: the memo.\n8. Where Work Stands: written.\n10. Agents in flight: none.</summary>' }))
    const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages, readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools: [], commands: [], mcpClients: [], engineModel: MODEL, maxThinkingTokens: 0, thinkingConfig: { type: 'enabled', budget_tokens: 8_000 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
    const cache = { systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages } as never
    try {
      return await compactConversation(messages, context as never, cache, true, undefined, true, { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: getAutoCompactThreshold(MODEL) }, undefined, MODEL)
    } catch (error) {
      check('the fold landed', false, error instanceof Error ? error.message : String(error))
      return null
    }
  })()
  const post = run === null ? [] : buildPostCompactMessages(run)
  const kinds = post.map(row => (row.type === 'system' ? `system:${(row as { subtype?: string }).subtype ?? ''}` : row.type === 'attachment' ? `attachment:${(row as { attachment: { type: string } }).attachment.type}` : row.type))
  check('the post-fold context opens on the compact boundary', kinds[0] === 'system:compact_boundary', kinds.slice(0, 4).join(' · '))
  check('the operator messages block rides verbatim', kinds.includes('attachment:compact_operator_messages'), kinds.join(' · ').slice(0, 300))
  check('the summary row follows and carries the model\'s prose', post.some(row => row.type === 'user' && (row as { isCompactSummary?: boolean }).isCompactSummary === true && String((row as { message: { content: unknown } }).message.content).includes('Where Work Stands')), '')
  const kept = run?.messagesToKeep ?? []
  const keptLast = kept.at(-1)
  check('the kept tail follows the summary and closes on a tool result', kept.length > 0 && keptLast?.type === 'user' && post.indexOf(keptLast) > post.findIndex(row => row.type === 'user' && (row as { isCompactSummary?: boolean }).isCompactSummary === true), `${kept.length} kept · last ${keptLast?.type}`)
}

await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-ladder-replay — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
