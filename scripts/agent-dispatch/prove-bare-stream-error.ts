#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const key of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_AUTH_SCOPE_DIR',
]) delete process.env[key]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bare-stream-error-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const wire = await import('../../src/services/providers/openai/openaiWire.ts')
const errors = await import('../../src/services/api/errors.ts')

section('§1 the fold: a bare error waits for the end; a reason, when the stream states one, wins')
{
  const countBefore = wire.bareStreamErrorCount()
  const fold = new wire.ResponsesStreamFold()
  fold.fold({ type: 'response.created', response: { id: 'resp_1' } })
  fold.fold({ type: 'response.output_text.delta', delta: 'partial words' })
  const atError = fold.fold({ type: 'error' })
  check('a bare error event yields no fault at once', atError.every(e => e.type !== 'stream-fault') && !fold.finished, JSON.stringify(atError))
  const taken = fold.takeBareStreamError()
  check('taken once at the end: the bare fault names what the provider sent and the count', taken !== null && taken.kind === 'response-failed' && taken.code === 'openai-stream-error' && taken.retryable === true && taken.message === `the provider ended the stream with an error carrying no reason — no code, no message (the ${countBefore + 1 === 1 ? '1st' : `${countBefore + 1}th`} this session)`, JSON.stringify(taken))
  check('…and only once', fold.takeBareStreamError() === null)

  const failed = new wire.ResponsesStreamFold()
  failed.fold({ type: 'response.created', response: { id: 'resp_2' } })
  failed.fold({ type: 'error' })
  const atFailed = failed.fold({ type: 'response.failed', response: { id: 'resp_2', error: { code: 'server_error', message: 'the fixture failed the response' } } })
  const failedFault = atFailed.find(e => e.type === 'stream-fault') as { fault?: { code?: string; message?: string } } | undefined
  check('a failed response after a bare error names its own reason; the bare error is superseded', failedFault?.fault?.code === 'openai-server_error' && failedFault?.fault?.message === 'the fixture failed the response' && failed.takeBareStreamError() === null && failed.finished, JSON.stringify(atFailed))

  const completed = new wire.ResponsesStreamFold()
  completed.fold({ type: 'response.created', response: { id: 'resp_3' } })
  completed.fold({ type: 'response.output_text.delta', delta: 'the whole reply' })
  completed.fold({ type: 'error' })
  const atDone = completed.fold({ type: 'response.completed', response: { id: 'resp_3', usage: { input_tokens: 10, output_tokens: 3 } } })
  check('a completed response after a bare error ends the stream whole: no fault, nothing held', atDone.every(e => e.type !== 'stream-fault') && completed.takeBareStreamError() === null && completed.finished, JSON.stringify(atDone.map(e => e.type)))

  const coded = new wire.ResponsesStreamFold()
  coded.fold({ type: 'response.created', response: { id: 'resp_4' } })
  const atCoded = coded.fold({ type: 'error', code: 'server_error', message: 'the fixture broke the stream' })
  const codedFault = atCoded.find(e => e.type === 'stream-fault') as { fault?: { code?: string; message?: string } } | undefined
  check('an error carrying a code settles at once, on the existing road', codedFault?.fault?.code === 'openai-server_error' && codedFault?.fault?.message === 'the fixture broke the stream' && coded.takeBareStreamError() === null, JSON.stringify(atCoded))
  check('the session count advanced on the three bare errors only', wire.bareStreamErrorCount() === countBefore + 3, `${countBefore} → ${wire.bareStreamErrorCount()}`)

  const text = errors.streamFaultAfterPartialText('ChatGPT Plus subscription', 'openai-stream-error', 'the provider ended the stream with an error carrying no reason — no code, no message (the 2nd this session)')
  const facts = errors.streamFaultFactsOf(text)
  check('the composed fault text reads back: the road, the code, the words', facts !== null && facts.provider === 'ChatGPT Plus subscription' && facts.code === 'openai-stream-error' && facts.message.startsWith('the provider ended the stream with an error carrying no reason'), JSON.stringify(facts))
  const line = errors.streamFaultNoticeLine(text, 'asked the model to continue from where it stopped (continuation 1 of 1)')
  check('the notice names the road, what the provider sent, and what Mercury did', line === 'ChatGPT Plus subscription ended the stream after partial content — the provider ended the stream with an error carrying no reason — no code, no message (the 2nd this session) (openai-stream-error); asked the model to continue from where it stopped (continuation 1 of 1)', line)
  check('a row without the marker gets the plain line', errors.streamFaultNoticeLine('API Error: something else', 'stopped after 1 continuation; the reply so far stands') === 'The provider stream dropped after partial content — stopped after 1 continuation; the reply so far stands' && errors.streamFaultFactsOf('plain words') === null)
  check('the fault text keeps the continuable marker every reader keys on', errors.isContinuableStreamFaultText(text))
}

const PARTIAL = 'partial words that streamed before the error'
type Mode = 'bare-eof' | 'bare-then-failed' | 'bare-then-completed' | 'coded'
let mode: Mode = 'bare-eof'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}
const posts: string[] = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify(MODELS_BODY))
      return
    }
    if (req.method !== 'POST' || !path.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    posts.push(mode)
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
    res.write(sse({ type: 'response.output_text.delta', delta: PARTIAL }))
    if (mode === 'coded') {
      res.end(sse({ type: 'error', code: 'server_error', message: 'the fixture broke the stream' }))
      return
    }
    res.write(sse({ type: 'error' }))
    if (mode === 'bare-then-failed') {
      res.end(sse({ type: 'response.failed', response: { id: 'resp_fixture', error: { code: 'server_error', message: 'the fixture failed the response' }, usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
      return
    }
    if (mode === 'bare-then-completed') {
      res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: PARTIAL }] } }))
      res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
      return
    }
    res.end()
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, { MERCURY_OPENAI_API_BASE: `${base}/openai/v1`, OPENAI_API_KEY: 'fixture-openai-key' })

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

type Drive = { yielded: Array<Record<string, unknown>>; thrown: string | null }
async function drive(): Promise<Drive> {
  const abort = new AbortController()
  const yielded: Array<Record<string, unknown>> = []
  let thrown: string | null = null
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'the operator asks for a long answer ' + 'x'.repeat(400) })] as never,
      systemPrompt: asSystemPrompt(['You are the stream fixture. ' + 'y'.repeat(800)]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: abort.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(getEmptyToolPermissionContext()),
        model: 'gpt-5.6-sol',
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        querySource: 'agent' as never,
        agents: [],
        mcpTools: [],
      },
    } as never)
    for await (const event of stream) yielded.push(event as Record<string, unknown>)
  } catch (e) {
    thrown = String(e)
  }
  return { yielded, thrown }
}
const apiErrorText = (d: Drive): string | null => {
  for (const e of d.yielded) {
    if (e.type !== 'assistant' || (e as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true) continue
    const content = (e as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const text = (block as { type?: string; text?: unknown }).type === 'text' ? (block as { text?: unknown }).text : undefined
      if (typeof text === 'string') return text
    }
  }
  return null
}
const streamedText = (d: Drive): string =>
  d.yielded
    .filter(e => e.type === 'stream_event')
    .map(e => {
      const ev = (e as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
      return ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? (ev.delta.text ?? '') : ''
    })
    .join('')

section('§2 the Responses runtime on the wire: the bare error is read after the end, and the row names the road')
try {
  const countBefore = wire.bareStreamErrorCount()
  mode = 'bare-eof'
  const eof = await drive()
  const eofText = apiErrorText(eof)
  check('bare error then the close: the run settled without throwing and the partial words streamed', eof.thrown === null && streamedText(eof).includes(PARTIAL), `${eof.thrown} ${streamedText(eof).slice(0, 80)}`)
  check('the API-error row names the road (the key), the bare words and the count', eofText !== null && /^API Error: OpenAI API key \(/.test(eofText) && eofText.includes('stream fault after partial content (openai-stream-error) — the provider ended the stream with an error carrying no reason — no code, no message (the ') && eofText.includes('this session)'), eofText ?? '(none)')
  check('the notice words read the road off the row', eofText !== null && errors.streamFaultNoticeLine(eofText, 'asked the model to continue from where it stopped (continuation 1 of 1)').startsWith('OpenAI API key ('), eofText === null ? '(none)' : errors.streamFaultNoticeLine(eofText, 'x'))

  mode = 'bare-then-failed'
  const failed = await drive()
  const failedText = apiErrorText(failed)
  check('bare error then response.failed: the row carries the failed reason, never the bare words', failedText !== null && failedText.includes('(openai-server_error) — the fixture failed the response') && !failedText.includes('no reason'), failedText ?? '(none)')

  mode = 'bare-then-completed'
  const done = await drive()
  check('bare error then response.completed: the reply stands with no fault', apiErrorText(done) === null && done.thrown === null && streamedText(done).includes(PARTIAL), `${apiErrorText(done)} ${done.thrown}`)

  mode = 'coded'
  const coded = await drive()
  const codedText = apiErrorText(coded)
  check('an error carrying a code keeps its road: the row names the code and the message', codedText !== null && codedText.includes('(openai-server_error) — the fixture broke the stream'), codedText ?? '(none)')
  check('one request per drive (no reissue after content)', posts.length === 4, JSON.stringify(posts))
  check('the session count advanced by the three bare errors', wire.bareStreamErrorCount() === countBefore + 3, `${countBefore} → ${wire.bareStreamErrorCount()}`)
} finally {
  server.close()
}

console.log(failures === 0 ? '\nprove-bare-stream-error: all green' : `\nprove-bare-stream-error: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
