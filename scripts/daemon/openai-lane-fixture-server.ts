#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  DELEGATE_GPT_ASK,
  DELEGATE_GPT_SHORT_SPEND_ASK,
  DELEGATE_GPT_SPEND_ASK,
  DELEGATE_REPORT,
  GPT_ID,
  RESET_LONG_SECONDS,
  RESET_SHORT_SECONDS,
  SHORT_SPEND_ASK,
  SPEND_ASK,
  SUBAGENT_ASK,
  SUBAGENT_REPLY,
} from './openai-lane-fixture-words.ts'

const captureFile = process.argv[2]
const modelsFailFlag = process.argv[3]
if (!captureFile) {
  console.error('usage: openai-lane-fixture-server.ts <captureFile> [modelsFailFlagPath]')
  process.exit(2)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}

type Item = { role?: string; type?: string; content?: unknown; output?: unknown }
type Block = { type?: string; text?: string; content?: unknown }

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

function lastToolResultText(body: Record<string, unknown>): string | undefined {
  const items = itemsOf(body)
  const last = [...items].reverse().find(m => m.role === 'user')
  if (last === undefined || !Array.isArray(last.content)) return undefined
  const results = (last.content as Block[]).filter(b => b.type === 'tool_result')
  if (results.length === 0) return undefined
  const content = results[results.length - 1]!.content
  if (typeof content === 'string') return content
  return textsOf(content).join('\n')
}

function immediateFunctionOutput(body: Record<string, unknown>): string | undefined {
  const items = itemsOf(body)
  const last = items[items.length - 1]
  if (last === undefined || last.type !== 'function_call_output') return undefined
  const output = last.output
  return typeof output === 'string' ? output : textsOf(output).join('\n')
}

const bearerTail = (req: IncomingMessage): string => {
  const raw = req.headers.authorization
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.slice(-4) : ''
}

const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
function openMessage(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(named('message_start', { type: 'message_start', message: { id: `msg_lane_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }))
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
function answerAgent(res: ServerResponse, model: string, prompt: string): void {
  openMessage(res, model)
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_lane_${Date.now()}`, name: 'Agent', input: {} } }))
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'the gpt errand', prompt, model: GPT_ID }) } }))
  res.end(closeMessage('tool_use'))
}

const bands = (resetAfterSeconds: number, usedPct: number): Record<string, string> => ({
  'x-codex-primary-used-percent': String(usedPct),
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-after-seconds': String(resetAfterSeconds),
})

function responsesText(text: string): string {
  const rid = `resp_lane_${Date.now()}`
  return [
    sse({ type: 'response.created', response: { id: rid } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function answerWalled(res: ServerResponse, resetInSeconds: number): void {
  res.writeHead(429, { 'content-type': 'application/json', ...bands(resetInSeconds, 100) })
  res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: resetInSeconds, plan_type: 'plus' } }))
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
    const token = bearerTail(req)
    if (req.method === 'GET' && url.endsWith('/models')) {
      const failing = modelsFailFlag !== undefined && existsSync(modelsFailFlag)
      record({ kind: 'models', token, status: failing ? 500 : 200, at: Date.now() })
      if (failing) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'the catalogue is down for the fixture' } }))
        return
      }
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
        record({ kind: 'openai', arm: 'report', token, ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream', ...bands(RESET_LONG_SECONDS, 40) })
        res.end(responsesText(`${DELEGATE_REPORT} ${output.slice(0, 900)}`))
        return
      }
      if (ask.includes(SHORT_SPEND_ASK)) {
        record({ kind: 'openai', arm: 'short-spend', token, ask: ask.slice(0, 80), model, status: 429, at: Date.now() })
        answerWalled(res, RESET_SHORT_SECONDS)
        return
      }
      if (ask.includes(SPEND_ASK)) {
        record({ kind: 'openai', arm: 'spend', token, ask: ask.slice(0, 80), model, status: 429, at: Date.now() })
        answerWalled(res, RESET_LONG_SECONDS)
        return
      }
      if (ask.includes(SUBAGENT_ASK)) {
        record({ kind: 'openai', arm: 'delegate', token, ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        res.writeHead(200, { 'content-type': 'text/event-stream', ...bands(RESET_LONG_SECONDS, 40) })
        res.end(responsesText(SUBAGENT_REPLY))
        return
      }
      record({ kind: 'openai', arm: 'heard', token, ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream', ...bands(RESET_LONG_SECONDS, 40) })
      res.end(responsesText(`heard: ${ask.split('\n')[0]!.slice(0, 80)}`))
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const ask = askOf(body)
      const trimmed = ask.trim()
      const result = lastToolResultText(body)
      if (result !== undefined) {
        record({ kind: 'anthropic', arm: 'report', ask: ask.slice(0, 80), model, status: 200, result: result.slice(0, 400), at: Date.now() })
        answerText(res, model, `${DELEGATE_REPORT} ${result.slice(0, 900)}`)
        return
      }
      if (trimmed === DELEGATE_GPT_SHORT_SPEND_ASK) {
        record({ kind: 'anthropic', arm: 'delegate-short-spend', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerAgent(res, model, SHORT_SPEND_ASK)
        return
      }
      if (trimmed === DELEGATE_GPT_SPEND_ASK) {
        record({ kind: 'anthropic', arm: 'delegate-spend', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerAgent(res, model, SPEND_ASK)
        return
      }
      if (trimmed === DELEGATE_GPT_ASK) {
        record({ kind: 'anthropic', arm: 'delegate', ask: ask.slice(0, 80), model, status: 200, at: Date.now() })
        answerAgent(res, model, SUBAGENT_ASK)
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
