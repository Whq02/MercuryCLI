#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: dupline-fixture-server.ts <captureFile> [agentSleepSeconds] [mainSleepSeconds]')
  process.exit(2)
}
export const AGENT_TURN_ASK = 'agent turn'
export const AGENT_PROMPT = 'sub agent work'
export const THREE_ROUNDS_ASK = 'three tool rounds'
export const AGENT_SLEEP_SECONDS = Number(process.argv[3] ?? 20)
export const MAIN_SLEEP_SECONDS = Number(process.argv[4] ?? 6)
export const WATCHED_WORDS = ['the line during the agent', 'the line during the main tool', 'the mid-turn line one', 'the between-turns line'] as const

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const j = (v: unknown): string => JSON.stringify(v)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
type Block = { type?: string; text?: string; tool_use_id?: string; id?: string; name?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
function itemsOf(body: Record<string, unknown>): Item[] {
  return Array.isArray(body.messages) ? (body.messages as Item[]) : []
}
function askOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}
function isToolResultItem(item: Item): boolean {
  return item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')
}
function askIndexOf(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.role === 'user' && askOf(item.content) !== '') return i
  }
  return -1
}
function firstAsk(items: Item[]): string {
  for (const item of items) {
    if (item.role === 'user') {
      const a = askOf(item.content)
      if (a !== '') return a
    }
  }
  return ''
}
function countOf(raw: string, word: string): number {
  let n = 0
  let at = raw.indexOf(word)
  while (at >= 0) {
    n++
    at = raw.indexOf(word, at + word.length)
  }
  return n
}

let calls = 0
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function openMessage(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_dupline_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use'): string =>
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) +
  sse('message_stop', { type: 'message_stop' })
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(closeMessage('end_turn'))
}
function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  res.end(closeMessage('tool_use'))
}
const answerSleep = (res: ServerResponse, n: number, model: string, id: string, seconds: number): void =>
  answerTool(res, n, model, id, 'Bash', { command: `sleep ${seconds}`, description: `a ${seconds}s sleep` })

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
    const toolNames = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(t => String(t.name ?? '')) : []
    const items = itemsOf(body)
    const askIndex = askIndexOf(items)
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const opening = firstAsk(items)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const trimmedAsk = ask.trim()
    const isAgent = opening.trim() === AGENT_PROMPT
    const arm = isAgent ? 'subwork' : trimmedAsk === AGENT_TURN_ASK ? 'agent' : trimmedAsk === THREE_ROUNDS_ASK ? 'three' : 'plain'
    const counts: Record<string, number> = {}
    for (const w of WATCHED_WORDS) counts[w] = countOf(raw, w)
    record({ kind: 'request', n, arm, step, ask: ask.slice(0, 80), opening: opening.slice(0, 40), tools, hasAgentTool: toolNames.includes('Agent'), at: Date.now(), system: sha(j(body.system)), counts })
    if (arm === 'agent') {
      if (step === 0) return answerTool(res, n, model, `toolu_agent_c${n}`, 'Agent', { description: 'sub work', prompt: AGENT_PROMPT })
      return answerText(res, n, model, `done: ${AGENT_TURN_ASK}`)
    }
    if (arm === 'subwork') {
      if (step === 0) return answerSleep(res, n, model, `toolu_sub_c${n}`, AGENT_SLEEP_SECONDS)
      return answerText(res, n, model, 'agent done: the sub agent finished')
    }
    if (arm === 'three') {
      if (step === 0) return answerSleep(res, n, model, `toolu_r1_c${n}`, MAIN_SLEEP_SECONDS)
      if (step === 1) return answerSleep(res, n, model, `toolu_r2_c${n}`, 3)
      if (step === 2) return answerSleep(res, n, model, `toolu_r3_c${n}`, 2)
      return answerText(res, n, model, `done: ${THREE_ROUNDS_ASK}`)
    }
    const heard = ask === '' || tools === 0 ? 'svc' : `heard: ${trimmedAsk.split('\n').pop()} (#${n})`
    answerText(res, n, model, heard)
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
