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
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the served-window prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE',
  'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_PROVIDER_BETAS',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'table-above-served-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'table-above-served-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { startOverflowFixture } = await import('../compact/overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const { getAutoCompactThreshold } = await import('../../src/services/compact/autoCompact.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}

const SERVED = 200_000
const CHARS_PER_TOKEN = 4
const OPERATOR_ASK = 'operator ask: land the change and run its checks'
const REPLY = 'the served answer'
const SUMMARY = 'SUMMARY: the modules were adjusted one by one and their checks pass; the operator now asks to land the change.'
const sizeOf = (body: Record<string, unknown>): number => Math.round(JSON.stringify(body).length / CHARS_PER_TOKEN)
const isSummaryRequest = (body: Record<string, unknown>): boolean => JSON.stringify(body.messages ?? '').includes('Produce the summary now') || /summar(y|ise|ize) (of )?the conversation/i.test(JSON.stringify(body.messages ?? '').slice(-6000))

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      engineModel: model,
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
}

function seed(rounds: number, charsPerSide: number): AnyMsg[] {
  const out: AnyMsg[] = []
  let running = 0
  for (let i = 0; i < rounds; i++) {
    const ask = `ask ${i}: adjust module ${i} ${'and keep the notes tidy '.repeat(Math.ceil(charsPerSide / 24))}`.slice(0, charsPerSide)
    const reply = `reply ${i}: module ${i} adjusted ${'and its checks pass '.repeat(Math.ceil(charsPerSide / 20))}`.slice(0, charsPerSide)
    running += Math.round((ask.length + reply.length) / CHARS_PER_TOKEN)
    out.push(createUserMessage({ content: ask }) as unknown as AnyMsg)
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(100000000000 + i)}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: running, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }
  out.push(createUserMessage({ content: OPERATOR_ASK }) as unknown as AnyMsg)
  return out
}

type Seen = { count: number; summary: boolean; refused: boolean; model: unknown; betas: string }
async function drive(model: string, messages: AnyMsg[]): Promise<{ yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; seen: Seen[] }> {
  const seen: Seen[] = []
  fixture.script(request => {
    const count = sizeOf(request.body)
    const summary = isSummaryRequest(request.body)
    const refused = count > SERVED
    seen.push({ count, summary, refused, model: request.body.model, betas: String((request as { headers?: Record<string, string> }).headers?.['anthropic-beta'] ?? '') })
    if (refused) return { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: `prompt is too long: ${count} tokens > ${SERVED} maximum` } } } }
    if (summary) return { text: SUMMARY, usage: { input: count, output: 40 } }
    return { text: REPLY, usage: { input: count, output: 12 } }
  })
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
      toolUseContext: makeCtx(model) as never,
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
  return { yields, terminal, threw, seen }
}
const boundaries = (yields: AnyMsg[]): AnyMsg[] => yields.filter(y => y.type === 'system' && (y as { subtype?: string }).subtype === 'compact_boundary')
const lastAssistantText = (yields: AnyMsg[]): string => textOf(yields.filter(y => y.type === 'assistant').at(-1))
const errorTexts = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true).map(textOf)
const show = (seen: Seen[]): string => seen.map(s => `${s.summary ? 'summary' : 'turn'}${s.refused ? '/refused' : ''}:${s.count}`).join(' → ')

section('an account that serves 200,000 tokens of a model whose row reads 1M: the request goes out, the vendor answers "prompt is too long", ONE fold follows and the retried request is served')
for (const model of ['claude-opus-4-8', 'claude-fable-5']) {
  const table = caps.getContextWindowForModel(model)
  const messages = seed(26, 20_000)
  const r = await drive(model, messages)
  const first = r.seen[0]
  const last = r.seen.at(-1)
  const folds = boundaries(r.yields)
  const meta = (folds[0] as { compactMetadata?: { trigger?: string; overflow?: { limitTokens?: number; actualTokens?: number } } } | undefined)?.compactMetadata
  console.log(`  [record] ${model}: table ${table} · fold point ${getAutoCompactThreshold(model)} · wire ${show(r.seen)} · folds ${folds.length} ${JSON.stringify({ trigger: meta?.trigger, overflow: meta?.overflow })} · terminal ${JSON.stringify(r.terminal)}${r.threw ? ` · threw ${r.threw}` : ''}`)
  check(`${model}: the row reads 1M, so a history of about 260,000 tokens is sent as it stands`, table === 1_000_000 && first !== undefined && !first.summary && first.count > SERVED, `table ${table} · first ${JSON.stringify(first)}`)
  check(`${model}: the vendor refused that request for its size and Mercury read the limit from the refusal`, first?.refused === true && meta?.trigger === 'overflow' && meta.overflow?.limitTokens === SERVED, JSON.stringify(meta ?? null))
  check(`${model}: ONE fold answered it`, folds.length === 1, `${folds.length} boundary rows`)
  check(`${model}: the retried request fitted the 200,000 the account serves and its reply settled`, last !== undefined && !last.summary && !last.refused && last.count <= SERVED && lastAssistantText(r.yields) === REPLY && r.threw === undefined && r.terminal.reason === 'completed', `${JSON.stringify(last)} · "${lastAssistantText(r.yields)}" · ${JSON.stringify(r.terminal)}`)
  check(`${model}: no loop — the refusals stop once a request fits, no request is resent at the size that was refused, the run takes ${r.seen.length} requests in all and no error row reaches the conversation`, r.seen.length <= 6 && r.seen.every((s, at) => at === 0 || s.count !== r.seen[at - 1]!.count) && r.seen.findLastIndex(s => s.refused) < r.seen.findIndex(s => !s.refused) && errorTexts(r.yields).length === 0, `${show(r.seen)} · ${JSON.stringify(errorTexts(r.yields))}`)
}

await fixture.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
