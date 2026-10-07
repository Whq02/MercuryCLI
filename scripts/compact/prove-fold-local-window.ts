#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_(AUTH_TOKEN|BASE_URL|API_KEY)|MERCURY_(MODEL|SMALL_FAST_MODEL)|MERCURY_OAUTH_TOKEN|MERCURY_SCRIPTED_STREAM|MERCURY_BARE|MERCURY_MAX_OUTPUT_TOKENS|MERCURY_HOME|MERCURY_EFFORT_LEVEL|MERCURY_THINKING_BUDGET|MERCURY_COMPACT_KEEP_TAIL|MERCURY_AUTOCOMPACT_PCT_OVERRIDE|MERCURY_BLOCKING_LIMIT_OVERRIDE|MERCURY_DISABLE_1M_CONTEXT|MERCURY_COMPACT|MERCURY_AUTO_COMPACT|MERCURY_CTX_COMPACTION|MERCURY_THINKING_BINDING)$/.test(key) ||
    /^(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|GOOGLE|OPENROUTER|HF)_/.test(key) ||
    /^HF_TOKEN$/.test(key) ||
    /^MERCURY_(OPENAI|ZAI|MOONSHOT|DEEPSEEK|GEMINI|OPENROUTER|HUGGINGFACE|COMPAT|LOCAL)_/.test(key)
  ) {
    delete process.env[key]
  }
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fold-local-window-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the fold local-window prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const MODEL = 'small-window:latest'
const SERVED = 4096
const hits: Array<{ method: string; url: string }> = []
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
      hits.push({ method: req.method ?? 'GET', url })
      if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 1, details: { family: 'llama', parameter_size: '3B', quantization_level: 'Q4_K_M' } }] })
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 1, context_length: SERVED, expires_at: '2026-01-01T00:00:00Z' }] })
      if (url === '/api/show') return json(res, 200, { modelfile: '', parameters: '', details: {}, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] })
      if (url === '/api/generate') return json(res, 200, { model: MODEL, response: '', done: true, done_reason: 'load' })
      if (url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'a summary that should never be reached' }, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compactModule = await import('../../src/services/compact/compact.ts')
const { compactConversation } = compactModule
const FOLD_WINDOW_REFUSAL_KEY: string = compactModule.FOLD_WINDOW_REFUSAL_KEY ?? "the fold cannot run on this model's window"
const overflowModule = await import('../../src/services/compact/overflowRecovery.ts')
const { overflowRefusalText } = overflowModule
const foldRemedyIsHeadless: (flag: boolean | undefined) => boolean = overflowModule.foldRemedyIsHeadless ?? ((flag: boolean | undefined) => flag === true)
const { estimateOverflowSignal } = await import('../../src/services/api/overflowSignal.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { setAskChannel, getAskChannel } = await import('../../src/bootstrap/state.ts')
const windowModule = await import('../../src/services/providers/local/localWindow.ts')
await refreshLocalDiscovery({ force: true })
windowModule.writeLocalWindowSetting?.({ id: MODEL }, 'server')

const PERSISTED = `local/${MODEL}`
let uuidSeq = 0
const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`
function assistantRow(text: string): unknown {
  const id = `msg_${nextUuid().slice(-6)}`
  return {
    type: 'assistant',
    uuid: nextUuid(),
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: { id, type: 'message', role: 'assistant', model: PERSISTED, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } },
  }
}
const BIG = 'the long history of this session, repeated. '.repeat(1000)
function makeMessages(): unknown[] {
  return [
    createUserMessage({ content: `please read all of this: ${BIG}` }),
    assistantRow('Read it all; nothing to change.'),
    createUserMessage({ content: 'now write the changelog entry' }),
  ]
}
function makeContext(isNonInteractiveSession: boolean): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = { toolPermissionContext, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'high' }
  const readFileState = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState,
    options: { tools: [], mcpClients: [], engineModel: PERSISTED, maxThinkingTokens: 0, thinkingConfig: { type: 'disabled' as const }, isNonInteractiveSession, agentDefinitions: { activeAgents: [] } },
  }
}
async function runFold(isNonInteractiveSession: boolean): Promise<{ error?: string; result?: unknown }> {
  const ctx = makeContext(isNonInteractiveSession)
  try {
    const result = await compactConversation(makeMessages() as never, ctx as never, { systemPrompt: asSystemPrompt(['You are a fixture session.']) } as never, true)
    return { result }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

section('§1 the seated model serves a 4,096-token window the fold\'s own request cannot fit (the window setting "server": the server\'s own choice governs): the fold refuses in plain words, never a nested API Error')
{
  check('discovery states the served window (4096 · served)', localRecordFor(PERSISTED)?.contextWindow?.tokens === SERVED && localRecordFor(PERSISTED)?.contextWindow?.source === 'served', JSON.stringify(localRecordFor(PERSISTED)?.contextWindow))
  const before = hits.length
  const run = await runFold(false)
  const chat = hits.slice(before).filter(h => h.url === '/v1/chat/completions' || h.url === '/api/chat')
  check('the fold did not produce a summary (the guard refused the fold\'s own request)', run.result === undefined && run.error !== undefined, JSON.stringify(run.result ?? null).slice(0, 200))
  check('no summary request reached the server (refused before the send)', chat.length === 0, `${chat.length} escaped`)
  const message = run.error ?? ''
  console.log(`  [record] the fold's refusal as thrown: ${message}`)
  check('the sentence opens with the plain key: the fold cannot run on this model\'s window (4,096 tokens, served)', message.startsWith(`${FOLD_WINDOW_REFUSAL_KEY} (4,096 tokens, served)`), message.slice(0, 120))
  check('it names the fold\'s own request size and the silent truncation', /its own request \(≈\d+k tokens\) does not fit and the server would silently truncate it/.test(message), message)
  check('the remedy names the in-app window road before the server env', message.includes('/config → Local model window') && message.indexOf('/config → Local model window') < message.indexOf('OLLAMA_CONTEXT_LENGTH'), message)
  check('no "API Error" is nested anywhere in it', !message.includes('API Error'), message)

  const signal = estimateOverflowSignal({ family: 'local', actualTokens: 461, limitTokens: 72 })
  const ladder = overflowRefusalText(signal, 'fold-failed', { nonInteractive: false, detail: message })
  console.log(`  [record] the ladder's sentence: ${ladder}`)
  check('the ladder\'s exhaustion sentence carries the plain fold-window words, not "the fold failed (…)"', ladder.includes(FOLD_WINDOW_REFUSAL_KEY) && !ladder.includes('the fold failed ('), ladder)
  check('and no "API Error" nested inside it', !ladder.includes('API Error'), ladder)
  const generic = overflowRefusalText(signal, 'fold-failed', { nonInteractive: false, detail: 'API Error: Ollama stream failed (http-500) — boom' })
  check('any other fold failure loses its "API Error:" dress inside the ladder\'s sentence', generic.includes('the fold failed (Ollama stream failed (http-500) — boom)') && !generic.includes('API Error'), generic)
}

section('§2 the remedy\'s spelling follows whether a client can act on a slash command, not the runner\'s flag alone')
{
  const signal = estimateOverflowSignal({ family: 'local', actualTokens: 461, limitTokens: 72 })
  const saved = getAskChannel()
  setAskChannel('operator')
  check('a runner flagged non-interactive with a client attached (a TUI on a daemon-hosted runner) is NOT headless', foldRemedyIsHeadless(true) === false)
  const attached = overflowRefusalText(signal, 'fold-failed', { nonInteractive: foldRemedyIsHeadless(true) })
  check('…so its words are the in-app ones (/clear · /model · /compact by hand), never "pass --model"', attached.includes('/model picks a model with a larger window') && attached.includes('/compact folds the conversation by hand') && !attached.includes('--model'), attached)
  setAskChannel('sdk')
  check('an SDK client that answers asks can act too: not headless', foldRemedyIsHeadless(true) === false)
  setAskChannel('none')
  check('a run with no attached client is headless', foldRemedyIsHeadless(true) === true)
  const headless = overflowRefusalText(signal, 'fold-failed', { nonInteractive: foldRemedyIsHeadless(true) })
  check('…and only then the CLI spelling (a fresh run, --model)', headless.includes('Start a fresh run, or pass --model with a larger window.') && !headless.includes('/compact folds'), headless)
  check('an interactive session is never headless, whatever the channel', foldRemedyIsHeadless(false) === false && foldRemedyIsHeadless(undefined) === false)
  setAskChannel(saved)
  const ctxRun = await runFold(true)
  check('the fold seam on a flagged-non-interactive context still refuses in the plain words (the spelling is the ladder\'s, the key is the same)', (ctxRun.error ?? '').startsWith(FOLD_WINDOW_REFUSAL_KEY), ctxRun.error ?? '')
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
