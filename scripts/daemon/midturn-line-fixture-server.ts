#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: midturn-line-fixture-server.ts <captureFile> [roundOneSleepSeconds] [foldFirstDeltaMs]')
  process.exit(2)
}
export const THREE_ROUNDS_ASK = 'three tool rounds'
export const LONG_ROUND_ASK = 'one long tool round'
export const ROUND_ONE_SLEEP_SECONDS = Number(process.argv[3] ?? 4)
export const ROUND_TWO_SLEEP_SECONDS = 3
export const ROUND_THREE_SLEEP_SECONDS = 2
export const LONG_ROUND_SLEEP_SECONDS = 30
export const FOLD_MARKER = 'Write the running record of this conversation'
export const FOLD_FIRST_DELTA_MS = Number(process.argv[4] ?? 2500)
export const FOLD_DELTA_MS = 800
export const WATCHED_WORDS = [
  'the first mid-turn line',
  'the second mid-turn line',
  'the third mid-turn line',
  'the line before the escape',
  'the line during the fold',
  '/cost',
] as const
const FOLD_DELTAS = [
  '<analysis>the walk</analysis>',
  '<summary>1. Operator Intent: ',
  'the operator asked for tool rounds. ',
  '2. Technical Ground: none. 3. Files and Code Touched: none. 4. Errors and Corrections: none. 5. Problems Worked: none. 6. Operator Messages: tool rounds. 7. Open Work: none. 8. Where Work Stands: idle. 9. Next Move (optional): none. 10. Agents in flight: none.',
  '</summary>',
]

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const j = (v: unknown): string => JSON.stringify(v)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = withoutCacheControl(v)
    }
    return out
  }
  return value
}
type Block = { type?: string; text?: string; tool_use_id?: string; id?: string; name?: string }
type Item = { role?: string; content?: unknown }
function itemsOf(body: Record<string, unknown>): Item[] {
  return Array.isArray(body.messages) ? (body.messages as Item[]) : []
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map(part => (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>') ? part.text : ''))
    .filter(text => text !== '')
    .join('\n')
}
function askOf(content: unknown): string {
  if (typeof content === 'string') return textOf(content)
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
type Recorded = { type: string; text?: string; tool_use_id?: string }
function blocksOf(item: Item | undefined): Recorded[] {
  if (item === undefined) return []
  if (typeof item.content === 'string') return [{ type: 'text', text: item.content.slice(0, 12000) }]
  if (!Array.isArray(item.content)) return []
  const out: Recorded[] = []
  for (const b of item.content as Array<Block & { content?: unknown }>) {
    out.push({
      type: String(b.type ?? ''),
      ...(typeof b.text === 'string' ? { text: b.text.slice(0, 12000) } : {}),
      ...(typeof b.tool_use_id === 'string' ? { tool_use_id: b.tool_use_id } : {}),
    })
    if (b.type !== 'tool_result') continue
    if (typeof b.content === 'string') out.push({ type: 'tool_result/text', text: b.content.slice(0, 12000) })
    if (Array.isArray(b.content)) {
      for (const inner of b.content as Block[]) {
        out.push({ type: `tool_result/${String(inner.type ?? '')}`, ...(typeof inner.text === 'string' ? { text: inner.text.slice(0, 12000) } : {}) })
      }
    }
  }
  return out
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
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_midturn_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
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
function answerSleep(res: ServerResponse, n: number, model: string, id: string, seconds: number): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `sleep ${seconds}`, description: `a ${seconds}s sleep` }) } }))
  res.end(closeMessage('tool_use'))
}
function answerFold(res: ServerResponse, n: number, model: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  let i = 0
  const step = (): void => {
    if (res.destroyed || res.writableEnded) return
    if (i < FOLD_DELTAS.length) {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FOLD_DELTAS[i]! } }))
      i++
      setTimeout(step, FOLD_DELTA_MS).unref()
      return
    }
    res.end(closeMessage('end_turn'))
    record({ kind: 'fold-landed', n, at: Date.now() })
  }
  setTimeout(step, FOLD_FIRST_DELTA_MS).unref()
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
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const fold = raw.includes(FOLD_MARKER)
    const trimmedAsk = ask.trim()
    const arm = fold ? 'fold' : trimmedAsk === THREE_ROUNDS_ASK ? 'three' : trimmedAsk === LONG_ROUND_ASK ? 'long' : 'plain'
    const counts: Record<string, number> = {}
    for (const w of WATCHED_WORDS) counts[w] = countOf(raw, w)
    record({
      kind: 'request',
      n,
      arm,
      step,
      ask: ask.slice(0, 80),
      tools,
      at: Date.now(),
      system: sha(j(withoutCacheControl(body.system))),
      toolsDigest: sha(j(withoutCacheControl(body.tools))),
      items: items.map(m => ({ role: m.role ?? '', sha: sha(j(withoutCacheControl(m))) })),
      last: blocksOf([...items].reverse().find(m => m.role === 'user')),
      counts,
    })
    if (fold) {
      answerFold(res, n, model)
      return
    }
    if (arm === 'three') {
      if (step === 0) return answerSleep(res, n, model, `toolu_r1_c${n}`, ROUND_ONE_SLEEP_SECONDS)
      if (step === 1) return answerSleep(res, n, model, `toolu_r2_c${n}`, ROUND_TWO_SLEEP_SECONDS)
      if (step === 2) return answerSleep(res, n, model, `toolu_r3_c${n}`, ROUND_THREE_SLEEP_SECONDS)
      return answerText(res, n, model, `done: ${THREE_ROUNDS_ASK}`)
    }
    if (arm === 'long') {
      if (step === 0) return answerSleep(res, n, model, `toolu_long_c${n}`, LONG_ROUND_SLEEP_SECONDS)
      return answerText(res, n, model, `done: ${LONG_ROUND_ASK}`)
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
