#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: mid-turn-reply-fixture-server.ts <captureFile>')
  process.exit(2)
}
const TWO_ROUNDS_ASK = 'two tool rounds then a summary'
const SILENT_ROUNDS_ASK = 'two tool rounds, the second silent, then a summary'
const LONG_ROUND_ASK = 'answer then a long tool'
const HEARD_LEAD = 'heard mid-turn: '
const ROUND_ONE_SLEEP_SECONDS = 4
const ROUND_TWO_SLEEP_SECONDS = 2
const LONG_ROUND_SLEEP_SECONDS = 30
const OPENING = 'The operator sent a new message while you were working:'

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
type Block = { type?: string; text?: string; tool_use_id?: string }
type Item = { role?: string; content?: unknown }
function itemsOf(body: Record<string, unknown>): Item[] {
  return Array.isArray(body.messages) ? (body.messages as Item[]) : []
}
const plainText = (text: string): boolean => !text.trimStart().startsWith('<system-reminder>')
function askOf(content: unknown): string {
  if (typeof content === 'string') return plainText(content) ? content : ''
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && plainText(part.text)) return part.text
  }
  return ''
}
function isToolResultItem(item: Item): boolean {
  return item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')
}
function askIndexOf(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.role === 'user' && askOf(items[i]!.content) !== '') return i
  }
  return -1
}
function operatorLinesOf(item: Item | undefined): string[] {
  if (item === undefined || !Array.isArray(item.content)) return []
  const lines: string[] = []
  for (const part of item.content as Block[]) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    const re = /<system-reminder>\n([^\n]*)\n([^\n]*)\n/g
    for (let m = re.exec(part.text); m !== null; m = re.exec(part.text)) {
      if (m[1] === OPENING) lines.push(m[2]!)
    }
  }
  return lines
}

let calls = 0
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function openMessage(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_reply_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use'): string =>
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) + sse('message_stop', { type: 'message_stop' })
function textBlock(res: ServerResponse, index: number, text: string): void {
  res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
}
function sleepBlock(res: ServerResponse, index: number, id: string, seconds: number): void {
  res.write(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `sleep ${seconds}`, description: `a ${seconds}s sleep` }) } }))
  res.write(sse('content_block_stop', { type: 'content_block_stop', index }))
}
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  openMessage(res, n, model)
  textBlock(res, 0, text)
  res.end(closeMessage('end_turn'))
}
function answerSleep(res: ServerResponse, n: number, model: string, id: string, seconds: number): void {
  openMessage(res, n, model)
  sleepBlock(res, 0, id, seconds)
  res.end(closeMessage('tool_use'))
}
function answerHeardThenSleep(res: ServerResponse, n: number, model: string, lines: string[], id: string, seconds: number): void {
  openMessage(res, n, model)
  textBlock(res, 0, `${HEARD_LEAD}${lines.join(' | ')}`)
  sleepBlock(res, 1, id, seconds)
  res.end(closeMessage('tool_use'))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
      record({ kind: 'hit', method: req.method, url, at: Date.now() })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${url}` } }))
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
    }
    const n = ++calls
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    const items = itemsOf(body)
    const askIndex = askIndexOf(items)
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content).trim()
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const lines = operatorLinesOf([...items].reverse().find(m => m.role === 'user'))
    const arm = ask === TWO_ROUNDS_ASK ? 'two' : ask === SILENT_ROUNDS_ASK ? 'silent' : ask === LONG_ROUND_ASK ? 'long' : 'plain'
    record({ kind: 'request', n, arm, step, ask: ask.slice(0, 60), lines, at: Date.now() })
    if (arm === 'two') {
      if (step === 0) return answerSleep(res, n, model, `toolu_two_r1_c${n}`, ROUND_ONE_SLEEP_SECONDS)
      if (step === 1) return answerHeardThenSleep(res, n, model, lines, `toolu_two_r2_c${n}`, ROUND_TWO_SLEEP_SECONDS)
      return answerText(res, n, model, `done: ${TWO_ROUNDS_ASK}`)
    }
    if (arm === 'silent') {
      if (step === 0) return answerSleep(res, n, model, `toolu_silent_r1_c${n}`, ROUND_ONE_SLEEP_SECONDS)
      if (step === 1) return answerSleep(res, n, model, `toolu_silent_r2_c${n}`, ROUND_TWO_SLEEP_SECONDS)
      return answerText(res, n, model, `done: ${SILENT_ROUNDS_ASK}`)
    }
    if (arm === 'long') {
      if (step === 0) return answerSleep(res, n, model, `toolu_long_r1_c${n}`, ROUND_ONE_SLEEP_SECONDS)
      if (step === 1) return answerHeardThenSleep(res, n, model, lines, `toolu_long_r2_c${n}`, LONG_ROUND_SLEEP_SECONDS)
      return answerText(res, n, model, `done: ${LONG_ROUND_ASK}`)
    }
    answerText(res, n, model, ask === '' || tools === 0 ? 'svc' : `heard: ${ask.split('\n').pop()} (#${n})`)
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  console.log(`PORT ${port}`)
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
