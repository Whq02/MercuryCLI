#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-compat-cut-reply exceeded 120s; it was waiting for the compat road to answer the fixture server\'s cut stream and its reissue, so read the compat road in src/models/roads/openaicompat/compatChatCallModel.ts and the turn in src/engine/loop/turn/streamModel.ts')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

for (const name of ['NODE_ENV', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_MAX_RETRIES', 'MERCURY_STREAM_IDLE_TIMEOUT_MS']) delete process.env[name]
const home = mkdtempSync(join(tmpdir(), 'compat-cut-reply-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Sent = { role: string; content: unknown }
const requests: Sent[][] = []
const frame = (row: unknown): string => `data: ${JSON.stringify(row)}\n\n`
const whole = (text: string): string => frame({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\n\n'
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    if (req.method !== 'POST' || !(req.url ?? '').split('?')[0]!.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Sent[] }
    requests.push(body.messages ?? [])
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests.length === 1) {
      res.write(frame({ choices: [{ delta: { role: 'assistant', content: 'the partial words' }, finish_reason: null }] }), () => void setTimeout(() => res.socket?.destroy(), 25))
      return
    }
    res.end(whole(requests.length === 2 ? 'the whole answer' : 'the second answer'))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_RECONNECT_SCALE: '0.01',
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_COMPAT_MODELS: 'fixture-model',
  MERCURY_COMPAT_LABEL: 'Fixture',
})

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/engine/turnDoor.ts')
const { productionDeps } = await import('../../src/engine/turn-entry/turnLoopDeps.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')

const MODEL = 'compat/fixture-model'
type Row = { type?: string; uuid?: string; subtype?: string; isApiErrorMessage?: boolean; error?: { message?: string }; message?: { uuid?: string; content?: unknown } }
const textOf = (row: Row): string => (Array.isArray(row.message?.content) ? (row.message.content as Array<{ text?: string }>).map(block => block.text ?? '').join('') : String(row.message?.content ?? ''))

function context(): Record<string, unknown> {
  let appState = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (change: (prev: never) => never): void => {
      appState = change(appState as never) as unknown as typeof appState
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

async function turn(history: unknown[]): Promise<{ said: string[]; kept: unknown[] }> {
  const deps = productionDeps()
  const said: string[] = []
  const kept: Row[] = []
  for await (const raw of query({
    messages: history as never,
    systemPrompt: ['Only answer the request.'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'deny', message: 'no tool in this fixture', decisionReason: { type: 'other', reason: 'fixture' } })) as never,
    toolUseContext: context() as never,
    querySource: 'sdk' as never,
    deps: { callModel: deps.callModel, autocompact: (async () => ({ wasCompacted: false })) as never, microcompact: (async (messages: unknown[]) => ({ messages })) as never, uuid: deps.uuid },
  }) as AsyncGenerator<Row>) {
    if (raw.type === 'assistant' && raw.isApiErrorMessage !== true) {
      said.push(`reply "${textOf(raw)}"`)
      kept.push(raw)
    } else if (raw.type === 'assistant') {
      said.push(`red "${textOf(raw)}"`)
      kept.push(raw)
    } else if (raw.type === 'tombstone') {
      const withdrawn = raw.message as Row | undefined
      said.push(`withdrawn "${withdrawn === undefined ? '' : textOf(withdrawn)}"`)
      const at = kept.findIndex(row => row.uuid === withdrawn?.uuid)
      if (at !== -1) kept.splice(at, 1)
    } else if (raw.type === 'system' && raw.subtype === 'api_error') {
      said.push(`notice "${raw.error?.message ?? ''}"`)
    }
  }
  return { said, kept }
}

const asked = createUserMessage({ content: 'Say hello.' })
const first = await turn([asked])
const second = await turn([asked, ...first.kept, createUserMessage({ content: 'And once more.' })])
server.closeAllConnections()
await new Promise<void>(resolve => server.close(() => resolve()))
rmSync(home, { recursive: true, force: true })

const roles = (sent: Sent[] | undefined): string => (sent ?? []).map(row => `${row.role}:${typeof row.content === 'string' ? row.content : JSON.stringify(row.content)}`).join(' | ')
console.log(`turn 1 said: ${first.said.join(' · ')}`)
console.log(`turn 2 said: ${second.said.join(' · ')}`)
requests.forEach((sent, index) => console.log(`request ${index + 1}: ${roles(sent)}`))

check('the stream is cut after its first words and the request goes out again: two requests in the first turn, the same messages in both', requests.length === 3 && roles(requests[0]) === roles(requests[1]) && roles(requests[0]) === 'system:Only answer the request. | user:Say hello.', roles(requests[1]))
check('the user is told the connection dropped, and the whole answer follows', first.said.some(row => row.startsWith('notice "connection dropped')) && first.said.at(-1) === 'reply "the whole answer"', first.said.join(' · '))
check('the cut reply is withdrawn once the request is answered again: it was said, then taken back, before the whole answer', first.said.indexOf('reply "the partial words"') !== -1 && first.said.indexOf('withdrawn "the partial words"') > first.said.indexOf('reply "the partial words"') && first.said.indexOf('withdrawn "the partial words"') < first.said.indexOf('reply "the whole answer"'), first.said.join(' · '))
check('the turn leaves one reply standing, the whole one', first.kept.length === 1 && textOf(first.kept[0] as Row) === 'the whole answer', JSON.stringify(first.kept.map(row => textOf(row as Row))))
check('the next request carries the whole answer and never the cut one', roles(requests[2]) === 'system:Only answer the request. | user:Say hello. | assistant:the whole answer | user:And once more.', roles(requests[2]))
check('the second turn is answered', second.said.at(-1) === 'reply "the second answer"', second.said.join(' · '))

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-compat-cut-reply: a reply cut mid-stream is withdrawn when the request is answered again' : `prove-compat-cut-reply: ${failures} FAILURE(S) — the compat road reissues a cut stream in src/models/roads/openaicompat/compatChatCallModel.ts; the turn withdraws a reply at onStreamingFallback (src/engine/loop/turn/streamModel.ts)`)
process.exit(failures === 0 ? 0 : 1)
