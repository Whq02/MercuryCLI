#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the image-refusal retry prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-image-refusal-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
type Seen = { nth: number; images: number; texts: string[]; roles: string[] }
const seen: Seen[] = []
let refusals = 0
const MODEL = 'gpt-5.6-sol'
const REFUSAL_WORDS = 'Invalid image: this model accepts text only (images are not supported on this route).'
const SECOND_REFUSAL_WORDS = 'Invalid request: the route refused the retried request too (image policy).'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const replySse = (text: string): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')

function summarize(nth: number, body: Body): Seen {
  const out: Seen = { nth, images: 0, texts: [], roles: [] }
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  for (const item of input) {
    if (typeof item.role === 'string') out.roles.push(item.role)
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined
    if (typeof parts === 'string') {
      out.texts.push(parts)
      continue
    }
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<{ type?: string; text?: string }>) {
      if (part.type === 'input_image') out.images++
      else if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') out.texts.push(part.text)
    }
  }
  return out
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path === '/openai/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ slug: MODEL, display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text', 'image'], supported_in_api: true }] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      let body: Body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
      } catch {
        body = {}
      }
      const row = summarize(seen.length + 1, body)
      seen.push(row)
      if (refusals > 0) {
        refusals--
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: row.images > 0 ? REFUSAL_WORDS : SECOND_REFUSAL_WORDS, type: 'invalid_request_error', param: 'input', code: 'invalid_image' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(replySse(row.images > 0 ? 'I see the image.' : `I read it in words (request ${row.nth}).`))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { resumeAgentBackground } = await import('../../src/tools/AgentTool/resumeAgent.ts')
const { deriveAgentTerminalOutcome } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const leaf = await import('../../src/tools/AgentTool/refusalRetry.ts').catch(() => null)
const refusalRetryRowOf: (last: Message | undefined, retried: ReadonlySet<string>, model: string) => { refusalClass: string; row: Message & { isMeta?: boolean } } | null = leaf === null ? () => null : leaf.refusalRetryRowOf
const imageRefusalRetryLine: (model: string, detail: string | undefined) => string = leaf === null ? () => '' : leaf.imageRefusalRetryLine
const { mediaRefusalOf } = await import('../../src/services/api/mediaRefusal.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { getAgentTranscript } = await import('../../src/utils/sessionStorage/logs.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { registerAsyncAgent, failAgentTask, registerAgentName } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { generateTaskId } = await import('../../src/Task.ts')
await import('../../src/tasks.ts')
type Message = import('../../src/types/message.ts').Message
type AppState = import('../../src/state/AppStateStore.ts').AppState

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const allowAll = (async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'refusal rig' } })) as never
const definition = {
  agentType: 'image-refusal-probe',
  whenToUse: 'image refusal probe',
  source: 'projectSettings',
  getSystemPrompt: () => 'You are the probe. Describe what you were given in one line.',
} as never

type Store = { get: () => AppState; set: (u: (prev: AppState) => AppState) => void }
function makeStore(): Store {
  let st: AppState = { ...getDefaultAppState(), effortValue: 'high' } as AppState
  return { get: () => st, set: u => { st = u(st) } }
}
function makeCtx(store: Store, agentId?: string): never {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: store.get,
    setAppState: store.set,
    setAppStateForTasks: store.set,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId,
  } as never
}

type Drive = { rows: Message[]; threw: string | undefined; agentId: string }
async function drive(store: Store, agentId: string, refuse: number): Promise<Drive> {
  refusals = refuse
  const rows: Message[] = []
  let threw: string | undefined
  const prompt = createUserMessage({
    content: [
      { type: 'text', text: 'What is in this picture? Answer in one line.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ],
  }) as Message
  try {
    const stream = runAgent({
      agentDefinition: definition,
      promptMessages: [prompt],
      toolUseContext: makeCtx(store),
      canUseTool: allowAll,
      isAsync: true,
      canShowPermissionPrompts: false,
      querySource: 'agent:custom:image-refusal-probe' as never,
      availableTools: [] as never,
      model: MODEL,
      override: { agentId },
      description: 'the picture probe',
      name: 'picture',
    })
    for await (const message of stream) {
      const kind = (message as { type?: string }).type
      if (kind === 'assistant' || kind === 'user') rows.push(message as Message)
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  return { rows, threw, agentId }
}
const textOf = (row: Message | undefined): string => {
  const content = (row as unknown as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}
const isApiError = (row: Message | undefined): boolean => (row as { isApiErrorMessage?: boolean } | undefined)?.isApiErrorMessage === true

section('§1 the retry row: a pure leaf, once per class')
{
  check('the retry row has one owner beside the run loop', leaf !== null)
  const stamped = { type: 'assistant', isApiErrorMessage: true, mediaRefusal: { blockTypes: ['image'], detail: 'images are not supported' }, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: refused' }] } } as unknown as Message
  const first = refusalRetryRowOf(stamped, new Set(), MODEL)
  check('a stamped image refusal earns one retry row', first !== null && first.refusalClass === 'image')
  check('the row is a user row the model reads, marked as the harness\'s own words', first !== null && first.row.type === 'user' && first.row.isMeta === true)
  const line = first === null ? '' : textOf(first.row)
  check('the line names the model and its route, the refusal, the [image] stand-in and the way on', line.includes(MODEL) && line.includes('OpenAI route') && line.includes('refused an image') && line.includes('(images are not supported)') && line.includes('as [image]') && line.includes('in words'), line)
  check('the line is one line', !line.includes('\n'))
  check('the same class a second time earns no row (never a loop)', refusalRetryRowOf(stamped, new Set(['image']), MODEL) === null)
  const plainError = { ...stamped, mediaRefusal: undefined } as unknown as Message
  check('an api error without the stamp earns no row', refusalRetryRowOf(plainError, new Set(), MODEL) === null)
  const reply = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fine' }] } } as unknown as Message
  check('a reply earns no row; no last row earns no row', refusalRetryRowOf(reply, new Set(), MODEL) === null && refusalRetryRowOf(undefined, new Set(), MODEL) === null)
  const documentOnly = { ...stamped, mediaRefusal: { blockTypes: ['document'] } } as unknown as Message
  check('a refusal the plan cannot strip (a document) earns no retry', refusalRetryRowOf(documentOnly, new Set(), MODEL) === null)
  check('an unrecognised model id says "on its route"', imageRefusalRetryLine('no-such-model', undefined).startsWith('The model no-such-model on its route refused an image in the last request: '))
}

section('§2 the run: the refusal stands as a row, the run retries once from its transcript, the second request carries no image')
const storeA = makeStore()
const idA = generateTaskId('local_agent')
seen.length = 0
const a = await drive(storeA, idA, 1)
{
  check('the run did not throw', a.threw === undefined, a.threw ?? '')
  check('two requests reached the wire', seen.length === 2, `${seen.length} request(s)`)
  check('the first carried the image', seen[0]?.images === 1, JSON.stringify(seen[0]))
  check('the second carried no image', seen[1] !== undefined && seen[1].images === 0, JSON.stringify(seen[1]))
  check('the second carries the [image] stand-in where the image was', seen[1]?.texts.some(t => t.includes('[image]')) === true, JSON.stringify(seen[1]?.texts))
  check('the second carries the retry line', seen[1]?.texts.some(t => t.includes('refused an image in the last request') && t.includes('in words')) === true, JSON.stringify(seen[1]?.texts))
  check('the second still carries the question', seen[1]?.texts.some(t => t.includes('What is in this picture?')) === true)
  const errorRows = a.rows.filter(isApiError)
  check('the refusal stands as one error row the run yielded, stamped', errorRows.length === 1 && mediaRefusalOf(errorRows[0]) !== null, `${errorRows.length} error row(s)`)
  const errorAt = a.rows.findIndex(isApiError)
  const retryRow = a.rows[errorAt + 1]
  check('the retry row follows the error row', retryRow !== undefined && retryRow.type === 'user' && textOf(retryRow).includes('refused an image in the last request'), textOf(retryRow))
  const last = a.rows[a.rows.length - 1]
  check('the run ends on the reply to the retried request', last !== undefined && last.type === 'assistant' && !isApiError(last) && textOf(last).includes('I read it in words'), textOf(last))
  const outcome = deriveAgentTerminalOutcome(a.rows)
  check('the terminal outcome over the rows is completed (the error row stands, the reply ends it)', outcome.status === 'completed', JSON.stringify(outcome))
  const transcript = await getAgentTranscript(idA as never)
  const kinds = (transcript?.messages ?? []).map(m => (isApiError(m) ? 'error' : m.type === 'user' && textOf(m).includes('refused an image') ? 'retry' : m.type)).filter(k => k !== 'attachment')
  check('the transcript on disk holds the prompt, the error row, the retry row and the reply in order (the machine\'s own attachment rows aside)', JSON.stringify(kinds) === JSON.stringify(['user', 'error', 'retry', 'assistant']), JSON.stringify(kinds))
  const record = existsSync(getAgentTranscriptPath(idA as never)) ? readFileSync(getAgentTranscriptPath(idA as never), 'utf8') : ''
  check('the error row on disk keeps its stamp', record.includes('"mediaRefusal"'))
}

section('§3 once per class: a refusal of the retried request ends the run on its error row — no third request')
const storeB = makeStore()
const idB = generateTaskId('local_agent')
seen.length = 0
const b = await drive(storeB, idB, 2)
{
  check('the run did not throw', b.threw === undefined, b.threw ?? '')
  check('exactly two requests: the refusal, the one retry — no third', seen.length === 2, `${seen.length} request(s)`)
  check('the retried request carried no image and was refused on its words all the same', seen[1]?.images === 0)
  const errorRowsB = b.rows.filter(isApiError)
  check('the second error row carries no image stamp (nothing to strip), so no second retry is earned', errorRowsB.length === 2 && mediaRefusalOf(errorRowsB[1]) === null)
  const errorRows = b.rows.filter(isApiError)
  check('two error rows stand', errorRows.length === 2, `${errorRows.length}`)
  const retryRows = b.rows.filter(r => r.type === 'user' && textOf(r).includes('refused an image in the last request'))
  check('one retry row', retryRows.length === 1, `${retryRows.length}`)
  const outcome = deriveAgentTerminalOutcome(b.rows)
  check('the run ends failed, provider-declined, with the second refusal\'s words', outcome.status === 'failed' && outcome.reason === 'provider-declined' && outcome.error.includes('refused the retried request too'), JSON.stringify(outcome))
}

section('§4 the run that ended on the error stays resumable by message: the next line continues it from its transcript')
{
  seen.length = 0
  refusals = 0
  registerAsyncAgent({ agentId: idB, description: 'the picture probe', prompt: 'What is in this picture?', selectedAgent: definition, setAppState: storeB.set as never })
  registerAgentName('picture', idB, storeB.set as never)
  failAgentTask(idB, 'API Error: OpenAI stream failed (openai-invalid_image)', storeB.set as never)
  check('the task row reads failed before the message', storeB.get().tasks[idB]?.status === 'failed', String(storeB.get().tasks[idB]?.status))
  const ctx = makeCtx(storeB)
  const answer = (await SendMessageTool.call({ to: 'picture', message: 'Carry on in words: say what you were asked.' } as never, ctx, undefined as never, { requestId: 'req-1' } as never)) as { data: { success: boolean; message: string } }
  check('the message is delivered: the agent is resumed with it', answer.data.success === true && answer.data.message.includes('had failed') && answer.data.message.includes('resumed in the background with your message'), answer.data.message)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = storeB.get().tasks[idB]?.status
    if (status === 'completed' || status === 'failed') break
    await new Promise(r => setTimeout(r, 100))
  }
  check('the resumed run settled completed', storeB.get().tasks[idB]?.status === 'completed', String(storeB.get().tasks[idB]?.status))
  check('one request left for the resumed run', seen.length === 1, `${seen.length}`)
  check('it carried the message and the question, and no image', seen[0] !== undefined && seen[0].images === 0 && seen[0].texts.some(t => t.includes('Carry on in words')) && seen[0].texts.some(t => t.includes('What is in this picture?')), JSON.stringify(seen[0]))
  const transcript = await getAgentTranscript(idB as never)
  const last = transcript?.messages[transcript.messages.length - 1]
  check('the transcript on disk ends on the resumed reply, the error rows standing before it', last !== undefined && last.type === 'assistant' && !isApiError(last) && (transcript?.messages ?? []).filter(isApiError).length === 2, textOf(last))
}

section('§5 the source: the retry lives in the run loop, once per class, never on a stopped or cut run')
{
  const runAgentSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'runAgent.ts'), 'utf8')
  check('the run re-reads its rows for the retry and lands the retry row on its transcript', runAgentSrc.includes("import { refusalRetryRowOf } from './refusalRetry.js'") && runAgentSrc.includes('retriedRefusals.add(refusalRetry.refusalClass)') && runAgentSrc.includes('[refusalRetry.row],'))
  check('a run stopped by its max-turns, the loop guard, the watchdog, the budget or an abort never retries', runAgentSrc.includes('stoppedEarly || watchdog.fired || throttled !== null || abortController.signal.aborted'))
  check('the re-run carries the rows from the last compaction boundary on', runAgentSrc.includes('carried.findLastIndex(row => isCompactBoundaryMessage(row))'))
}

server.close()
console.log(`\nprove-agent-image-refusal-retry: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
