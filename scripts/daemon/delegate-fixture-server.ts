#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  DELEGATE_ASK,
  DELEGATE_MODEL,
  DELEGATE_REPORT,
  DELEGATE_SPEND_ASK,
  ERRAND_ASK,
  ERRAND_LAUNCHED,
  GPT_ID,
  NOTICE_REPLY,
  RESET_IN_SECONDS,
  SPEND_ASK,
  SUBAGENT_ASK,
  SUBAGENT_REPLY,
} from './delegate-fixture-words.ts'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: delegate-fixture-server.ts <captureFile> [subagentDelayMs] [holdMs]')
  process.exit(2)
}
const SUBAGENT_DELAY_MS = Number(process.argv[3] ?? 0)
const HOLD_MS = Number(process.argv[4] ?? 8000)

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

type Item = { role?: string; type?: string; content?: unknown; output?: unknown }
type Block = { type?: string; text?: string }

function itemsOf(body: Record<string, unknown>): Item[] {
  if (Array.isArray(body.messages)) return body.messages as Item[]
  if (Array.isArray(body.input)) return body.input as Item[]
  return []
}

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).map(b => (typeof b.text === 'string' ? b.text : '')).filter(t => t !== '')
}

function askOf(body: Record<string, unknown>): string {
  const items = itemsOf(body)
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role !== 'user') continue
    const texts = textsOf(item.content).filter(t => !t.trimStart().startsWith('<system-reminder>'))
    if (texts.length > 0) return texts[texts.length - 1]!
  }
  return typeof body.input === 'string' ? body.input : ''
}

function lastUserHasToolResult(body: Record<string, unknown>): boolean {
  const items = itemsOf(body)
  const last = [...items].reverse().find(m => m.role === 'user')
  return last !== undefined && Array.isArray(last.content) && (last.content as Block[]).some(b => b.type === 'tool_result')
}

function immediateFunctionOutput(body: Record<string, unknown>): string | undefined {
  const items = itemsOf(body)
  const last = items[items.length - 1]
  if (last === undefined || last.type !== 'function_call_output') return undefined
  const output = last.output
  return typeof output === 'string' ? output : textsOf(output).join('\n')
}

const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
function openMessage(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(named('message_start', { type: 'message_start', message: { id: `msg_dlg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use'): string =>
  named('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  named('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { ...usage, output_tokens: 8 } }) +
  named('message_stop', { type: 'message_stop' })
function answerText(res: ServerResponse, model: string, text: string): void {
  openMessage(res, model)
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(closeMessage('end_turn'))
}
function answerHeldText(res: ServerResponse, model: string, text: string, holdMs: number): void {
  openMessage(res, model)
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  const finish = (): void => {
    if (res.destroyed || res.writableEnded) return
    res.end(closeMessage('end_turn'))
    record({ kind: 'anthropic', arm: 'held-released', at: Date.now() })
  }
  setTimeout(finish, holdMs).unref()
}
function answerAgentLaunch(res: ServerResponse, model: string): void {
  openMessage(res, model)
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_dlg_${Date.now()}`, name: 'Agent', input: {} } }))
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'the errand', prompt: SUBAGENT_ASK, run_in_background: true }) } }))
  res.end(closeMessage('tool_use'))
}
function answerSpent(res: ServerResponse): void {
  const resetAt = Math.floor(Date.now() / 1000) + RESET_IN_SECONDS
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetAt),
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-5h-reset': String(resetAt),
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'overage_not_provisioned',
    'retry-after': String(RESET_IN_SECONDS),
    'x-should-retry': 'false',
  })
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit." } }))
}

function responsesText(text: string): string {
  const rid = `resp_dlg_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function responsesAgentCall(input: Record<string, unknown>): string {
  const rid = `resp_dlg_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Agent', call_id: `call_dlg_${Date.now() % 100000}`, arguments: JSON.stringify(input) } }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    const body = ((): Record<string, unknown> => {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    const model = String(body.model ?? '')
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'models', url, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          models: [
            {
              slug: GPT_ID,
              display_name: 'GPT-5.6 Sol',
              supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort, description: effort })),
              default_reasoning_level: 'high',
              visibility: 'list',
              priority: 1,
              context_window: 400_000,
              input_modalities: ['text', 'image'],
              supported_in_api: true,
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      const output = immediateFunctionOutput(body)
      const ask = askOf(body)
      if (output !== undefined) {
        record({ kind: 'openai', arm: 'report', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(responsesText(`${DELEGATE_REPORT} ${output.slice(0, 900)}`))
        return
      }
      if (ask.includes(DELEGATE_SPEND_ASK)) {
        record({ kind: 'openai', arm: 'delegate-spend', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(responsesAgentCall({ description: 'the spend', prompt: SPEND_ASK, model: DELEGATE_MODEL, run_in_background: true }))
        return
      }
      if (ask.includes(DELEGATE_ASK)) {
        record({ kind: 'openai', arm: 'delegate', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(responsesAgentCall({ description: 'the errand', prompt: SUBAGENT_ASK, model: DELEGATE_MODEL }))
        return
      }
      record({ kind: 'openai', arm: 'heard', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesText(`heard: ${ask.split('\n')[0]!.slice(0, 80)}`))
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const ask = askOf(body)
      const trimmed = ask.trim()
      if (ask.includes(SPEND_ASK)) {
        record({ kind: 'anthropic', arm: 'spent', ask: ask.slice(0, 80), model, status: 429, at: Date.now() })
        answerSpent(res)
        return
      }
      if (lastUserHasToolResult(body) && trimmed === ERRAND_ASK) {
        record({ kind: 'anthropic', arm: 'held', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerHeldText(res, model, ERRAND_LAUNCHED, HOLD_MS)
        return
      }
      if (trimmed === ERRAND_ASK) {
        record({ kind: 'anthropic', arm: 'launch', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerAgentLaunch(res, model)
        return
      }
      if (trimmed === SUBAGENT_ASK || ask.includes(`\n${SUBAGENT_ASK}`)) {
        record({ kind: 'anthropic', arm: 'delegate', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        setTimeout(() => answerText(res, model, SUBAGENT_REPLY), SUBAGENT_DELAY_MS).unref()
        return
      }
      if (ask.includes('<task-notification>')) {
        record({ kind: 'anthropic', arm: 'notice', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerText(res, model, NOTICE_REPLY)
        return
      }
      record({ kind: 'anthropic', arm: 'heard', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
      answerText(res, model, ask === '' ? 'svc' : `heard: ${trimmed.split('\n').pop()}`)
      return
    }
    record({ kind: 'other', url: `${req.method} ${url}`, at: Date.now() })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.stdout.write(`PORT ${port}\n`)
})

const shutdown = (): void => {
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
const parentPid = process.ppid
const parentGone = (): boolean => {
  try {
    process.kill(parentPid, 0)
    return false
  } catch (err) {
    return (err as { code?: string }).code === 'ESRCH'
  }
}
setInterval(() => {
  if (process.ppid !== parentPid || parentGone()) shutdown()
}, 1000).unref()
