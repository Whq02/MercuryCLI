#!/usr/bin/env bun
// gate-watch: src/engine/compaction/autoFold.ts src/engine/context-window/contextWindowWarmup.ts src/models/roads/local/localWindow.ts src/models/roads/local/localCallModel.ts src/engine/loop/turn-machine.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'ANTHROPIC_API_KEY', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_CTX_COMPACTION', 'MERCURY_THINKING_BUDGET', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_MAX_OUTPUT_TOKENS']) delete process.env[key]
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'first-check-local-window-'))
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
  console.log('\nTIMEOUT — the first-check local-window prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const CODER = 'coder-32k:latest'
const TRAINED_MAX = 32_768
const TAGS_DELAY_MS = 3_500
let tagsAnswered = 0
const loaded = new Map<string, number>()
const chats: Array<{ model: string; numCtx: number | undefined; chars: number }> = []
const hits: Array<{ at: number; url: string }> = []
const startedAtMs = Date.now()
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
      hits.push({ at: Date.now() - startedAtMs, url })
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      if (url === '/api/tags') {
        tagsAnswered++
        const answer = (): void => json(res, 200, { models: [{ name: CODER, model: CODER, size: 1_900_000_000, details: { family: 'qwen2', parameter_size: '3B', quantization_level: 'Q4_K_M' } }] })
        if (tagsAnswered === 1) setTimeout(answer, TAGS_DELAY_MS)
        else answer()
        return
      }
      if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
      if (url === '/api/ps') return json(res, 200, { models: [...loaded.entries()].map(([name, ctx]) => ({ name, model: name, size: 1_900_000_000, context_length: ctx, expires_at: '2026-01-01T00:00:00Z' })) })
      if (url === '/api/show') return json(res, 200, { modelfile: '', parameters: '', details: {}, model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': TRAINED_MAX }, capabilities: ['completion', 'tools'] })
      if (url === '/api/generate') {
        const options = body.options as { num_ctx?: number } | undefined
        loaded.set(String(body.model ?? ''), options?.num_ctx ?? 4096)
        return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' })
      }
      if (url === '/api/chat') {
        const options = body.options as { num_ctx?: number } | undefined
        const model = String(body.model ?? '')
        loaded.set(model, options?.num_ctx ?? 4096)
        chats.push({ model, numCtx: options?.num_ctx, chars: raw.length })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'ok.' }, done: false })}\n`)
        res.write(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(raw.length / 4), eval_count: 2 })}\n`)
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

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
bootstrap.setAskChannel('none')
bootstrap.setSessionPersistenceDisabled(true)
const { getCachedLocalDiscovery } = await import('../../src/models/roads/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/models/roads/local/localCatalogue.ts')
const w = await import('../../src/models/roads/local/localWindow.ts')
const { resolveContextWindow } = await import('../../src/models/facts/capabilities.ts')
const autoCompact = await import('../../src/engine/compaction/autoFold.ts')
const { tokenCountWithEstimation } = await import('../../src/engine/context-window/contextTokenCount.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { Conversation } = await import('../../src/engine/rows/turn.ts')
const { flushDebugLogs } = await import('../../src/platform/logs/debugLog.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message

const CODER_MODEL = `local/${CODER}`
const HISTORY_TOKENS = 35_000

function makeHistory(model: string): Message[] {
  const line = 'the long history of this session, repeated. '
  let repeat = 2_000
  for (;;) {
    const user = createUserMessage({ content: `please keep all of this in mind: ${line.repeat(repeat)}` })
    const assistant = createAssistantMessage({ content: 'Kept in mind; nothing to change yet.' })
    assistant.message.model = model
    const count = tokenCountWithEstimation([user, assistant] as never)
    if (count >= HISTORY_TOKENS) return [user, assistant] as Message[]
    repeat = Math.ceil(repeat * (HISTORY_TOKENS / Math.max(1, count)) * 1.02)
  }
}

async function headlessTurn(model: string, history: Message[]): Promise<{ outcome: Record<string, unknown> | undefined; chatsBefore: number }> {
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
    customSystemPrompt: 'You are a fixture session.',
    userSpecifiedModel: model,
    thinkingConfig: { type: 'disabled' } as never,
    maxTurns: 1,
    initialMessages: history,
  })
  const chatsBefore = chats.length
  let outcome: Record<string, unknown> | undefined
  for await (const row of conversation.turn('and now write the changelog entry')) {
    const draft = row as unknown as Record<string, unknown>
    if (draft.type === 'outcome') outcome = draft
  }
  return { outcome, chatsBefore }
}

function autoCompactLines(): string[] {
  let text = ''
  try {
    text = readFileSync(debugLog, 'utf8')
  } catch {
    text = ''
  }
  return text.split('\n').filter(line => line.includes('autoCompact:'))
}

section("§1 a fresh process on a `-c` history of 35k tokens: the first auto-compaction check reads the model's own 32,768-token window — never the 200k default — so the 35k prompt is folded or refused, not sent at num_ctx 32768")
{
  check('nothing is discovered yet (a fresh process: no snapshot, no hold)', getCachedLocalDiscovery() === null && w.heldLocalWindow({ id: CODER, server: 'ollama' }) === undefined, 'state from an earlier import leaked into this process: look at heldLocalWindow in src/models/roads/local/localWindow.ts and getCachedLocalDiscovery in src/models/roads/local/localDiscovery.ts')
  const before = resolveContextWindow(CODER_MODEL)
  record(`before the first check the window resolves to ${fmt(before.effectiveWindow)} (${before.source}: ${before.fallbackReason ?? 'no reason'})`)
  const history = makeHistory(CODER_MODEL)
  const historyTokens = tokenCountWithEstimation(history as never)
  record(`the resumed history is ≈${fmt(historyTokens)} tokens by the pre-flight's count`)
  rmSync(debugLog, { force: true })
  const startedAt = Date.now()
  const ran = await headlessTurn(CODER_MODEL, history)
  await flushDebugLogs()
  const lines = autoCompactLines()
  const first = lines.find(line => /autoCompact: tokens=/.test(line))
  const effective = Number(/effectiveWindow=(\d+)/.exec(first ?? '')?.[1] ?? NaN)
  const sent = chats.slice(ran.chatsBefore)
  const oversize = sent.filter(chat => chat.numCtx !== undefined && Math.ceil(chat.chars / 4) > chat.numCtx)
  const error = ran.outcome?.error as { message?: string; class?: string } | undefined
  record(`the first check's line: ${first ?? '(no autoCompact line)'}`)
  record(`the server's hits (ms since the proof started): ${hits.map(hit => `${hit.url}@${hit.at}`).join(' · ')}`)
  record(`outcome ${JSON.stringify(ran.outcome?.status)} ${JSON.stringify(error?.class ?? '')} · ${sent.length} chat request(s) · ${oversize.length} oversize · ${Math.round((Date.now() - startedAt) / 100) / 10}s`)
  if (error?.message !== undefined) record(`the outcome's sentence: ${error.message}`)
  const planned = localRecordFor(CODER_MODEL) !== undefined ? w.localPlannedWindow(localRecordFor(CODER_MODEL)!) : undefined
  check('discovery landed before the check decided (the model and its window are known to the process)', localRecordFor(CODER_MODEL) !== undefined && planned?.tokens === TRAINED_MAX, `discovery must finish before the first auto-compaction check: see localPlannedWindow in src/models/roads/local/localWindow.ts and the discovery wait in src/engine/compaction/autoFold.ts · ${JSON.stringify({ record: localRecordFor(CODER_MODEL)?.id, planned })}`)
  check(`the first check read the 32,768-token window (effectiveWindow ${fmt(TRAINED_MAX - 8_192)}), not the 200k default (180,000)`, effective === TRAINED_MAX - 8_192, `shouldAutoCompact in src/engine/compaction/autoFold.ts must read the local model window from src/models/roads/local/localWindow.ts, not the default · ${first ?? 'no autoCompact line in the debug log'}`)
  check('no request larger than its own num_ctx reached the server (the 35k prompt was never sent at num_ctx 32768)', oversize.length === 0, `a prompt larger than num_ctx was sent: the first check must fold or refuse before the call, see src/engine/compaction/autoFold.ts and src/models/roads/local/localCallModel.ts · ${JSON.stringify(oversize)}`)
  check('the turn folded the history or refused with the class context_limit — never a silent send', ran.outcome?.status === 'completed' || (ran.outcome?.status === 'failed' && error?.class === 'context_limit'), `the turn must fold the history or fail with class context_limit, see src/engine/compaction/autoFold.ts · ${JSON.stringify(ran.outcome)}`)
}

section('§2 a window the process cannot know makes no check against a default: a local id no server lists is left alone, a 200k model is unchanged')
{
  const ghost = 'local/ghost-not-listed:latest'
  const history = makeHistory(ghost)
  const big = [...history, ...history, ...history, ...history, ...history]
  const ghostTokens = tokenCountWithEstimation(big as never)
  rmSync(debugLog, { force: true })
  const ghostDecision = await autoCompact.shouldAutoFold(big, ghost, 'sdk')
  await flushDebugLogs()
  const ghostLines = autoCompactLines()
  record(`an unlisted local id with ≈${fmt(ghostTokens)} tokens: shouldAutoCompact ${ghostDecision}; lines ${JSON.stringify(ghostLines)}`)
  check('an unlisted local model is not compacted against the 200k default (the window is unknown, so no check is made)', ghostDecision === false && !ghostLines.some(line => /tokens=/.test(line)), `shouldAutoCompact in src/engine/compaction/autoFold.ts must make no check when the local window is unknown · ${JSON.stringify(ghostLines)}`)
  const wide = 'compat/my-model'
  const small = await autoCompact.shouldAutoFold(history, wide, 'sdk')
  const large = await autoCompact.shouldAutoFold(big, wide, 'sdk')
  const threshold = autoCompact.getAutoFoldThreshold(wide)
  record(`the 200k model: threshold ${fmt(threshold)}; 35k history → ${small}; ${fmt(ghostTokens)} tokens → ${large}`)
  check('a 200k model is unchanged: the 35k history is under its 157,000 threshold and a 175k history is over it', threshold === 157_000 && small === false && large === true, `threshold ${threshold}, small ${small}, large ${large}: the 200k path in src/engine/compaction/autoFold.ts must stay unchanged`)
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
