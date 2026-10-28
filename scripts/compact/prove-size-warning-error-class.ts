#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — size-warning error-class prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT_KEEP_TAIL',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'size-warning-class-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'size-warning-class-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_AUTO_COMPACT = '0'
process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '1000000'

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
type Turn = import('./overflowFixture.ts').Turn
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, autoCompactWindow: 100_000 }))
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { requestSizeWarningApplies } = await import('../../src/services/compact/overflowRecovery.ts')
const { createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')

type AnyMsg = Record<string, unknown> & { type?: string }
const textOf = (m: unknown): string => {
  const msg = (m ?? {}) as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}

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

const OPERATOR_ASK = 'operator ask: land the change and run its checks'
function seedNearWindow(): AnyMsg[] {
  const out: unknown[] = []
  for (let i = 0; i < 40; i++) {
    out.push(createUserMessage({ content: `ask ${i}: adjust module ${i}` }))
    out.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-0000000000${String(10 + i)}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${i}`,
      message: {
        id: `msg_${i}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [{ type: 'text', text: `reply ${i}: ${`module ${i} adjusted line ${'x'.repeat(40)}\n`.repeat(50)}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: i === 39 ? 90_000 : 900 + i, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }
  out.push(createUserMessage({ content: OPERATOR_ASK }))
  return out as AnyMsg[]
}

type Drive = { yields: AnyMsg[]; terminal: Record<string, unknown>; threw: string | undefined; requests: number }
async function drive(model: string, messages: AnyMsg[], querySource = 'sdk'): Promise<Drive> {
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
      toolUseContext: makeCtx(model) as never,
      querySource: querySource as never,
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
  return { yields, terminal, threw, requests: fixture.captured.length - before }
}

const noticesOf = (yields: AnyMsg[]): string[] => yields.filter(y => y.type === 'system').map(y => String((y as { content?: unknown }).content ?? ''))
const errorRows = (yields: AnyMsg[]): AnyMsg[] => yields.filter(y => y.type === 'assistant' && y.isApiErrorMessage === true)
const SIZE_LINE = 'this conversation is near the window'

const RATE_LIMIT_MESSAGE = "This request would exceed your account's rate limit. Please try again later."
const CREDIT_MESSAGE = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
const shapes: Array<{ label: string; turn: Turn; error: string; wait: boolean }> = [
  {
    label: 'a rate limit with the provider wait named (the session\'s 477,204 s)',
    turn: { error: { status: 429, headers: { 'retry-after': '477204' }, body: { type: 'error', error: { type: 'rate_limit_error', message: RATE_LIMIT_MESSAGE } } } },
    error: 'rate_limit',
    wait: true,
  },
  {
    label: 'a credit balance refusal',
    turn: { error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: CREDIT_MESSAGE } } } },
    error: 'billing_error',
    wait: false,
  },
  {
    label: 'a refused credential (401)',
    turn: { error: { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } } },
    error: 'authentication_failed',
    wait: false,
  },
]

section('S1 an error that is not about size on a conversation at 90% of the window: the error row stands alone (red on the base: the size line followed every one)')
for (const shape of shapes) {
  fixture.script([shape.turn])
  const r = await drive('claude-opus-4-8', seedNearWindow())
  const rows = errorRows(r.yields)
  const row = rows[0]
  check(`${shape.label}: the turn ended on one error row of class ${shape.error}`, r.threw === undefined && r.terminal.reason === 'completed' && rows.length === 1 && row?.error === shape.error, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} rows=${rows.length} class=${String(row?.error)} text=${textOf(row).slice(0, 160)}`)
  check(`${shape.label}: the row ${shape.wait ? 'carries' : 'carries no'} provider wait`, (typeof row?.providerWaitEndsAtMs === 'number') === shape.wait, JSON.stringify(row?.providerWaitEndsAtMs))
  check(`${shape.label}: no size line follows it`, noticesOf(r.yields).every(text => !text.includes(SIZE_LINE)), JSON.stringify(noticesOf(r.yields)).slice(0, 300))
}

section('S2 the two cases the line is for keep it: a fault the wire did not classify, and the overflow itself')
{
  fixture.script([{ error: { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'the request was not accepted' } } } }])
  const r = await drive('claude-opus-4-8', seedNearWindow())
  const row = errorRows(r.yields)[0]
  const lines = noticesOf(r.yields).filter(text => text.includes(SIZE_LINE))
  check('an unclassified 400 at 90% of the window: ONE size line names the cause and the remedy, as today', row?.error === 'unknown' && lines.length === 1 && /about [\d,]+ of the model's 100,000-token window/.test(lines[0] ?? '') && /\/compact folds it by hand/.test(lines[0] ?? ''), `class=${String(row?.error)} notices=${JSON.stringify(noticesOf(r.yields)).slice(0, 300)}`)
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  fixture.script([{ error: { status: shape.status, body: shape.body } }])
  const overflow = await drive('claude-opus-4-8', seedNearWindow(), 'compact')
  const overflowRow = errorRows(overflow.yields)[0]
  const overflowLines = noticesOf(overflow.yields).filter(text => text.includes(SIZE_LINE))
  check('an overflow on a road the ladder does not arm (a service fork): the overflow row carries its signal and the size line follows it, as today', overflowRow?.overflowSignal !== undefined && overflowLines.length === 1, `signal=${JSON.stringify(overflowRow?.overflowSignal)} notices=${JSON.stringify(noticesOf(overflow.yields)).slice(0, 300)}`)
}

section('S3 the gate, read directly: every class the line never follows, the two it does')
{
  const row = (fields: Record<string, unknown>) => ({ ...createAssistantAPIErrorMessage({ content: 'API Error: fixture' }), ...fields }) as never
  for (const error of ['rate_limit', 'billing_error', 'authentication_failed', 'invalid_request', 'max_output_tokens'] as const) {
    check(`${error}: the line does not apply`, !requestSizeWarningApplies(row({ error })))
  }
  check('a row with a provider wait and no class: the line does not apply', !requestSizeWarningApplies(row({ providerWaitEndsAtMs: Date.now() + 60_000 })))
  check('the unclassified 429 frame: the line does not apply', !requestSizeWarningApplies(createAssistantAPIErrorMessage({ content: 'API Error (429): Anthropic says: slow down', error: 'unknown' })))
  check('an unclassified fault: the line applies', requestSizeWarningApplies(row({ error: 'unknown' })))
  check('a server fault: the line applies', requestSizeWarningApplies(row({ error: 'server_error' })))
  check('a row of no class: the line applies', requestSizeWarningApplies(row({})))
  check('an overflow signal applies even on an invalid_request row', requestSizeWarningApplies(row({ error: 'invalid_request', overflowSignal: { family: 'anthropic', shape: 'prompt-too-long', source: 'provider' } })))
}

await fixture.close()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-size-warning-error-class — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
