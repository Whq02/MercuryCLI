#!/usr/bin/env bun
// gate-watch: src/services/compact/autoCompact.ts src/services/compact/compact.ts src/run-core/turn-machine.ts src/services/providers/local/localWindow.ts src/services/providers/local/localCallModel.ts src/utils/model/capabilities.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'ANTHROPIC_API_KEY', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION', 'MERCURY_THINKING_BUDGET', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_MAX_OUTPUT_TOKENS']) delete process.env[key]
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'small-window-follow-up-'))
process.env.MERCURY_CONFIG_DIR = proofHome
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const debugLog = join(proofHome, 'd.log')
process.env.DEBUG = '1'
process.argv.push('--log-file', debugLog)

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
const fmt = (n: number): string => n.toLocaleString('en-US')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the small-window follow-up prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const SMALL = 'small-8k:latest'
const WINDOW = 8_192
const loaded = new Map<string, number>()
const chats: Array<{ model: string; numCtx: number | undefined; chars: number; messages: number }> = []
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const ollama = await new Promise<{ server: Server; root: string }>(resolve => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', chunk => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const url = req.url ?? ''
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      if (url === '/api/tags') return json(res, 200, { models: [{ name: SMALL, model: SMALL, size: 1_900_000_000, details: { family: 'llama', parameter_size: '3B', quantization_level: 'Q4_K_M' } }] })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [...loaded.entries()].map(([name, ctx]) => ({ name, model: name, size: 1_900_000_000, context_length: ctx, expires_at: '2026-01-01T00:00:00Z' })) })
      if (url === '/api/show') return json(res, 200, { modelfile: '', parameters: '', details: {}, model_info: { 'general.architecture': 'llama', 'llama.context_length': WINDOW }, capabilities: ['completion', 'tools'] })
      if (url === '/api/generate') {
        const options = body.options as { num_ctx?: number } | undefined
        loaded.set(String(body.model ?? ''), options?.num_ctx ?? WINDOW)
        return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
      }
      if (url === '/api/chat') {
        const options = body.options as { num_ctx?: number } | undefined
        const model = String(body.model ?? '')
        loaded.set(model, options?.num_ctx ?? WINDOW)
        chats.push({ model, numCtx: options?.num_ctx, chars: raw.length, messages: Array.isArray(body.messages) ? body.messages.length : 0 })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'The follow-up is answered.' }, done: false })}\n`)
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 6 })}\n`)
        res.end()
        return
      }
      json(res, 404, { error: 'not found' })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    resolve({ server, root: `http://127.0.0.1:${port}` })
  })
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
bootstrap.setSessionPersistenceDisabled(true)
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const w = await import('../../src/services/providers/local/localWindow.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const autoCompact = await import('../../src/services/compact/autoCompact.ts')
const { tokenCountWithEstimation } = await import('../../src/utils/tokens.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { Conversation } = await import('../../src/rows/turn.ts')
const { flushDebugLogs } = await import('../../src/utils/debug.ts')
type Message = import('../../src/types/message.ts').Message

const MODEL = `local/${SMALL}`
await refreshLocalDiscovery({ force: true })
const record8k = localRecordFor(MODEL)
check('the fixture states an 8,192-token model', record8k?.modelMaxContext === WINDOW, JSON.stringify(record8k))

function textOfTokens(tokens: number, seed: string): string {
  const line = `${seed} the earlier conversation continues here. `
  let repeat = Math.max(1, Math.round((tokens * 4) / line.length))
  for (;;) {
    const text = line.repeat(repeat)
    const count = tokenCountWithEstimation([createUserMessage({ content: text })] as never)
    if (Math.abs(count - tokens) <= 40 || repeat <= 1) return text
    repeat = Math.max(1, Math.round(repeat * (tokens / Math.max(1, count))))
  }
}

async function followUp(systemTokens: number, historyTokens: number): Promise<{ outcome: Record<string, unknown> | undefined; chat: (typeof chats)[number] | undefined; promptTokens: number; lines: string[] }> {
  const customSystemPrompt = textOfTokens(systemTokens, 'system:')
  const history: Message[] = []
  if (historyTokens > 0) {
    const user = createUserMessage({ content: textOfTokens(historyTokens, 'user:') })
    const assistant = createAssistantMessage({ content: 'Noted.' })
    assistant.message.model = MODEL
    history.push(user, assistant)
  }
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const conversation = new Conversation({
    cwd: proofHome,
    tools: [] as never,
    commands: [],
    mcpClients: [],
    agents: { activeAgents: [], allAgents: [] } as never,
    canUseTool: (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
    getAppState: () => appState as never,
    setAppState: ((f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    }) as never,
    readFileState: createFileStateCacheWithSizeLimit(100),
    customSystemPrompt,
    userSpecifiedModel: MODEL,
    thinkingConfig: { type: 'disabled' } as never,
    maxTurns: 1,
    initialMessages: history,
  })
  const before = chats.length
  rmSync(debugLog, { force: true })
  let outcome: Record<string, unknown> | undefined
  for await (const row of conversation.turn('and the follow-up question?')) {
    const draft = row as unknown as Record<string, unknown>
    if (draft.type === 'outcome') outcome = draft
  }
  await flushDebugLogs()
  let text = ''
  try {
    text = readFileSync(debugLog, 'utf8')
  } catch {
    text = ''
  }
  const promptTokens = tokenCountWithEstimation(history as never) + Math.ceil(customSystemPrompt.length / 4)
  return { outcome, chat: chats[before], promptTokens, lines: text.split('\n').filter(line => /autoCompact:|\[ERROR\]|compaction|blocking preempt/i.test(line)) }
}

section("§1 the tester's row: an 8,192-token model, a 6.3k prompt (a 4k system prompt and a 2k history), a -c follow-up — main sends it and the model answers")
{
  w.__resetLocalWindowsForTest()
  const window = resolveContextWindow(MODEL)
  record(`the window resolves to ${fmt(window.effectiveWindow)} (${window.fallbackReason ?? window.source}); blocking limit ${fmt(autoCompact.getBlockingLimit(MODEL))}, fold point ${fmt(autoCompact.getAutoCompactThreshold(MODEL))}`)
  const ran = await followUp(4_000, 2_000)
  const error = ran.outcome?.error as { message?: string; class?: string } | undefined
  record(`prompt ≈${fmt(ran.promptTokens)} tokens · outcome ${JSON.stringify(ran.outcome?.status)} ${JSON.stringify(error?.class ?? '')} · request ${ran.chat === undefined ? 'none' : `num_ctx ${String(ran.chat.numCtx)} · ${ran.chat.messages} messages · ${fmt(ran.chat.chars)} chars`}`)
  for (const line of ran.lines) record(`debug: ${line.replace(/^\S+ /, '')}`)
  check('the follow-up is sent at num_ctx 8192 and answered (status completed)', ran.outcome?.status === 'completed' && ran.chat?.numCtx === WINDOW && ran.chat.messages >= 3, JSON.stringify({ outcome: ran.outcome, chat: ran.chat }))
  check('the answer is the model\'s', ran.outcome?.answer === 'The follow-up is answered.', JSON.stringify(ran.outcome?.answer))
  check('no failed compaction row and no [ERROR] stack: the fold is skipped once, in the debug log only', !ran.lines.some(line => line.includes('[ERROR]')) && (error?.message ?? '') === '', JSON.stringify(ran.lines))
  check('no sentence naming "786 tokens" reaches the user (the outcome carries none)', !JSON.stringify(ran.outcome).includes('786 tokens'), JSON.stringify(ran.outcome).slice(0, 300))
}

section('§2 the other shape of a 6.3k request: a 1k system prompt and a 3.5k history — the history alone is over the 3,144-token blocking limit, and the follow-up is still sent and answered because the composed request fits the 8,192 window')
{
  w.__resetLocalWindowsForTest()
  const ran = await followUp(1_000, 3_500)
  const error = ran.outcome?.error as { message?: string; class?: string } | undefined
  record(`prompt ≈${fmt(ran.promptTokens)} tokens nominal · outcome ${JSON.stringify(ran.outcome?.status)} ${JSON.stringify(error?.class ?? '')}${error?.message ? `: ${error.message}` : ''} · request ${ran.chat === undefined ? 'none' : `num_ctx ${String(ran.chat.numCtx)} · ${ran.chat.messages} messages · ${fmt(Math.round(ran.chat.chars / 4))} tokens on the wire`}`)
  for (const line of ran.lines) record(`debug: ${line.replace(/^\S+ /, '')}`)
  check('the follow-up is sent at num_ctx 8192 and answered (status completed)', ran.outcome?.status === 'completed' && ran.chat?.numCtx === WINDOW && ran.chat.messages >= 3, JSON.stringify({ outcome: ran.outcome, chat: ran.chat }))
  check('no sentence naming "786 tokens" reaches the user (the outcome carries none)', !JSON.stringify(ran.outcome).includes('786 tokens'), JSON.stringify(ran.outcome).slice(0, 300))
}

section('§3 a prompt that genuinely overflows the 8,192 window (a 7k system prompt and a 5k history) keeps the class context_limit refusal, with no request sent')
{
  w.__resetLocalWindowsForTest()
  const ran = await followUp(7_000, 5_000)
  const error = ran.outcome?.error as { message?: string; class?: string } | undefined
  record(`prompt ≈${fmt(ran.promptTokens)} tokens · outcome ${JSON.stringify(ran.outcome?.status)} ${JSON.stringify(error?.class ?? '')}${error?.message ? `: ${error.message}` : ''} · request ${ran.chat === undefined ? 'none' : 'sent'}`)
  check('the run fails with the class context_limit and nothing reaches the server', ran.outcome?.status === 'failed' && error?.class === 'context_limit' && ran.chat === undefined, JSON.stringify({ outcome: ran.outcome, chat: ran.chat }))
  check('no sentence naming "786 tokens" reaches the user (the outcome carries none)', !JSON.stringify(ran.outcome).includes('786 tokens'), JSON.stringify(ran.outcome).slice(0, 300))
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
