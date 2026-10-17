#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EXTRA_BODY', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION', 'MERCURY_THINKING_BUDGET']) delete process.env[key]
const home = mkdtempSync(join(tmpdir(), 'fold-at-threshold-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const DUMP_DIR = mkdtempSync(join(tmpdir(), 'fold-at-threshold-dump-'))
process.env.MERCURY_WIRE_DUMP = DUMP_DIR

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the fold-at-threshold prover exceeded 300s')
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
const { conversationAtThreshold } = await import('./thresholdFixture.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { recordSentRequest } = await import('../../src/utils/forkedAgent.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { compactConversation, shouldRideCacheSharingFork, PROSE_SKIPPED_KEY } = await import('../../src/services/compact/compact.ts')

const GEMINI = 'gemini-3-pro'
const GEMINI_WINDOW = 1_048_576
const OPUS = 'claude-opus-4-8'
const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ models: [{ name: `models/${GEMINI}`, displayName: 'fixture', inputTokenLimit: GEMINI_WINDOW, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true }] }), { status: 200, headers: { 'content-type': 'application/json' } })
await refreshGeminiCatalogue('api-key', { force: true, fetchImpl })


const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
type Body = Record<string, any>
const ENVELOPE = new Set(['messages', 'input', 'system', 'instructions', 'tools', 'metadata', 'stream', 'stream_options', 'tool_choice', 'prompt_cache_key', 'previous_response_id', 'store', 'user', 'safety_identifier', 'model', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'include', 'cache_control', 'n', 'contents', 'systemInstruction', 'toolConfig'])
const posture = (body: Body | undefined): Record<string, unknown> => {
  if (body === undefined) return { absent: true }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(body).sort()) if (!ENVELOPE.has(key)) out[key] = body[key]
  return out
}
const ceilingOf = (body: Body | undefined): unknown => body === undefined ? undefined : (body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens ?? null)
const rowsOf = (body: Body | undefined): unknown[] => body === undefined ? [] : Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : []
const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner)))
const lastModelRowAt = (rows: any[]): number => rows.reduce((last, row, at) => (row.role === 'assistant' || row.role === 'model' || row.type === 'reasoning' ? at : last), -1)
const count = (text: string, needle: string): number => text.split(needle).length - 1
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)
type FoldRow = { kind: string; family?: string; road?: string; outcome?: string; model?: string }
function foldRows(): FoldRow[] {
  const rows: FoldRow[] = []
  for (const file of readdirSync(DUMP_DIR).filter(f => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(DUMP_DIR, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as FoldRow
      if (row.kind === 'fold') rows.push(row)
    }
  }
  return rows
}

async function atThreshold(label: string, model: string, family: string, resultChars: number, fixed: number, ratio: number, thinkingConfig: Record<string, unknown>): Promise<void> {
  section(label)
  const window = getContextWindowForModel(model)
  const threshold = getAutoCompactThreshold(model)
  const blocking = getBlockingLimit(model)
  const built = conversationAtThreshold({ model, family, resultChars, fixed, ratio, target: threshold })
  const { gauge, byDensity } = built
  const bytes = JSON.stringify(built.messages).length
  record(`${built.messages.length} messages (${built.ids.length} Read rounds of ${resultChars.toLocaleString('en-US')} chars, ${(bytes / 1_048_576).toFixed(1)} MB of JSON); the calibrated gauge reads ${gauge.toLocaleString('en-US')} on a ${window.toLocaleString('en-US')} window — the fold threshold is ${threshold.toLocaleString('en-US')}, the blocking limit ${blocking.toLocaleString('en-US')}; by density the request reads ${byDensity.toLocaleString('en-US')} (fixed material ${fixed.toLocaleString('en-US')}, ratio ${ratio})`)
  check(`${label}: the gauge sits exactly at the auto-compact threshold`, gauge === threshold, `${gauge} vs ${threshold}`)
  check(`${label}: by density too the conversation is under the blocking limit (a normal day's fold, not the dead seat's)`, byDensity < blocking && byDensity > threshold - 25_000, `${byDensity} vs ${blocking}`)
  const context: any = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: built.messages, readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024), options: { tools: [FileReadTool], commands: [], mcpClients: [], engineModel: model, maxThinkingTokens: 0, thinkingConfig, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  const systemPrompt = asSystemPrompt(['Synthetic fold request proof.'])
  const owner = String(rosterOwnerFromToolUseContext(context))
  fixture.script([{ text: 'Reading module next.' }])
  const referenceAt = fixture.captured.length
  let referenceError = ''
  try {
    for await (const _ of routedCallModel({ messages: built.messages, systemPrompt, thinkingConfig: thinkingConfig as never, tools: [FileReadTool], signal: context.abortController.signal, options: { model, getToolPermissionContext: async () => state.toolPermissionContext, isNonInteractiveSession: true, hasAppendSystemPrompt: false, maxOutputTokensOverride: undefined, querySource: 'main_thread' as never, agents: [], mcpTools: [], effortValue: state.effortValue as never, ownerKey: owner, onWait: () => {}, onStreamActivity: () => {} } })) {}
  } catch (caught) {
    referenceError = String(caught)
  }
  const reference = fixture.captured[referenceAt]?.body as Body | undefined
  check(`${label}: the session's own request went out on the ${family} wire (the reference)`, reference !== undefined && referenceError === '' && fixture.captured.length === referenceAt + 1, referenceError || String(fixture.captured.length - referenceAt))
  recordSentRequest(owner, built.messages)
  const summary = '<summary>1. Operator Intent: the memo on the fold ladder.\n8. Where Work Stands: the sources are read; the memo is being written.\n10. Agents in flight: none.</summary>'
  fixture.script([{ text: summary, usage: { input: 1000, output: 80 } }, { text: summary, usage: { input: 1000, output: 80 } }, { text: summary, usage: { input: 1000, output: 80 } }])
  const foldsBefore = foldRows().length
  const before = fixture.captured.length
  const started = Date.now()
  let error = ''
  let result: Awaited<ReturnType<typeof compactConversation>> | undefined
  try {
    result = await compactConversation(built.messages, context, { systemPrompt, userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: built.messages } as never, true, undefined, true, { isRecompaction: false, turnsSincePreviousCompact: 3, autoCompactThreshold: threshold })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const requests = fixture.captured.slice(before)
  const wire = JSON.stringify(requests[0]?.body ?? {})
  const refWire = JSON.stringify(reference ?? {})
  const roads = foldRows().slice(foldsBefore)
  const summaryText = result?.summaryMessages[0] !== undefined && typeof result.summaryMessages[0].message.content === 'string' ? result.summaryMessages[0].message.content : ''
  record(`${label}: ${error === '' ? 'LANDED' : `FAILED (${error})`} after ${requests.length} summariser request(s) on the ${requests.map(r => r.dialect).join(', ')} wire in ${Date.now() - started} ms; fold roads ${roads.map(r => `${r.road}:${r.outcome}`).join(', ') || 'none'}${result ? `; context ${result.preCompactTokenCount.toLocaleString('en-US')} → ${result.truePostCompactTokenCount.toLocaleString('en-US')}, ${result.messagesToKeep?.length ?? 0} messages kept verbatim` : ''}`)
  check(`${label}: the fold landed in ONE summariser request (red on 41304f7c53 by the second check below: the request was shaped)`, error === '' && requests.length === 1, error || String(requests.length))
  const carriesIds = refWire.includes(`"${built.ids[0]}"`)
  const missingRounds = built.ids.map((id, i) => ({ id, path: built.paths[i] ?? '' })).filter(round => !wire.includes(escaped(round.path)) || (carriesIds && !wire.includes(`"${round.id}"`)))
  check(`${label}: every Read round rides, the newest included — no tail split off before the send (${carriesIds ? 'call ids and paths' : 'paths; this wire carries no call ids'})`, missingRounds.length === 0, `${missingRounds.length} of ${built.ids.length} absent: ${missingRounds.slice(0, 3).map(round => round.id).join(', ')}${missingRounds.some(round => round.id === built.ids.at(-1)) ? ' (the newest round among them)' : ''}`)
  const missingBodies = built.results.filter(body => !wire.includes(escaped(body)))
  check(`${label}: every Read result rides whole, byte for byte — no result capped, nothing omitted`, missingBodies.length === 0 && !wire.includes('characters omitted for the compaction'), `${missingBodies.length} of ${built.results.length} results not whole; omitted-marker ${wire.includes('characters omitted for the compaction')}`)
  const refThoughts = count(refWire, 'fixture-signature-round-')
  const foldThoughts = count(wire, 'fixture-signature-round-')
  check(`${label}: the thinking blocks ride exactly as the session's own request carried them (${refThoughts} signed blocks on this wire's reference)`, foldThoughts === refThoughts && (family !== 'anthropic' || foldThoughts === built.ids.length), `${foldThoughts} vs ${refThoughts}`)
  check(`${label}: no part capsule, no truncation marker, no skipped-prose line — the whole conversation, unshaped`, !wire.includes('earlier turns folded into this summary') && !wire.includes('[Earlier conversation truncated') && !summaryText.includes(PROSE_SKIPPED_KEY) && (result?.notes ?? []).length === 0, summaryText.slice(0, 200))
  const refRows = uncached(rowsOf(reference)) as any[]
  const foldRowsAll = uncached(rowsOf(requests[0]?.body as Body | undefined)) as any[]
  const lastAt = lastModelRowAt(refRows)
  const identical = lastAt >= 0 && JSON.stringify(refRows.slice(0, lastAt + 1)) === JSON.stringify(foldRowsAll.slice(0, lastAt + 1))
  check(`${label}: the request's rows through the session's last model row are byte-identical to the session's own request (${lastAt + 1} rows, ${(refWire.length / 1_048_576).toFixed(1)} MB)`, identical, `rows ${foldRowsAll.length} vs ${refRows.length}; first differing row ${refRows.findIndex((row, at) => JSON.stringify(row) !== JSON.stringify(foldRowsAll[at]))}`)
  check(`${label}: the posture and the output ceiling are the session request's`, JSON.stringify(posture(reference)) === JSON.stringify(posture(requests[0]?.body as Body | undefined)) && JSON.stringify(ceilingOf(reference)) === JSON.stringify(ceilingOf(requests[0]?.body as Body | undefined)), JSON.stringify({ reference: posture(reference), fold: posture(requests[0]?.body as Body | undefined) }).slice(0, 300))
  if (shouldRideCacheSharingFork(model, thinkingConfig as never)) {
    check(`${label}: the cache-sharing fork carried the summary — no direct lane, no hand-over`, roads.length === 1 && roads[0]?.road === 'fork' && roads[0]?.outcome === 'summary', roads.map(r => `${r.road}:${r.outcome}`).join(', '))
    const rows = rowsOf(requests[0]?.body as Body | undefined) as any[]
    const marked = rows.map((row, at) => (Array.isArray(row.content) && row.content.some((block: any) => block.cache_control !== undefined) ? at : -1)).filter(at => at >= 0)
    const markedRound = marked.length === 1 ? built.ids.indexOf(rows[marked[0]!]?.content?.find((block: any) => block.type === 'tool_result')?.tool_use_id) : -1
    check(`${label}: the fork's one cache marker sits on a conversation result row of the last two rounds, ahead of the row that carries the prompt — the session's cached prefix is read, never re-written`, marked.length === 1 && markedRound >= built.ids.length - 2 && marked[0]! < rows.length - 1, `marked ${marked.join(',')} of ${rows.length} (round ${markedRound} of ${built.ids.length})`)
  } else {
    check(`${label}: the direct lane carried the summary in its one request`, roads.length === 1 && roads[0]?.road === 'direct' && roads[0]?.outcome === 'summary', roads.map(r => `${r.road}:${r.outcome}`).join(', '))
  }
  check(`${label}: the post-fold context is under the threshold with a verbatim tail kept`, result !== undefined && result.truePostCompactTokenCount < threshold && (result.messagesToKeep?.length ?? 0) > 0, `${result?.truePostCompactTokenCount} / ${result?.messagesToKeep?.length}`)
}

check('claude-opus-4-8 resolves a 200,000-token window', getContextWindowForModel(OPUS) === 200_000, String(getContextWindowForModel(OPUS)))
check('gemini-3-pro resolves the 1,048,576-token window from the catalogue', getContextWindowForModel(GEMINI) === GEMINI_WINDOW, String(getContextWindowForModel(GEMINI)))
try {
  await atThreshold('T1 a normal automatic fold AT the threshold on a 200,000 window (Anthropic, the fork lane)', OPUS, 'anthropic', 24_000, 20_000, 1, { type: 'adaptive' })
  await atThreshold('T2 a normal automatic fold AT the threshold on a 1,048,576 window (Gemini, the direct lane)', GEMINI, 'gemini', 30_000, 42_723, 1.3, { type: 'enabled', budget_tokens: 8_000 })
} finally {
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(DUMP_DIR, { recursive: true, force: true })
}
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-fold-at-threshold-unshaped — ${checks} checks, ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
