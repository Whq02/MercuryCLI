#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
if (!captureFile) {
  console.error('usage: compaction-hold-fixture-server.ts <captureFile> [foldPaceMs]')
  process.exit(2)
}
export const FOLD_MARKER = 'Write the running record of this conversation'
export const FOLD_FIRST_DELTA_MS = Number(process.argv[3] ?? 2500)
export const FOLD_DELTA_MS = 800
export const TOOL_ASK = 'run a tool then fold'
export const TOOL_TURN_INPUT_TOKENS = 190_000
export const WATCHED_WORDS = ['first held words', 'second held words', 'the later line', 'the words to take back', 'the auto-held words', 'the second auto-held words'] as const
const FOLD_DELTAS = [
  '<analysis>the walk</analysis>',
  '<summary>1. Operator Intent: ',
  'the operator said hello. ',
  '2. Technical Ground: none. 3. Files and Code Touched: none. 4. Errors and Corrections: none. 5. Problems Worked: none. 6. Operator Messages: hello. 7. Open Work: none. 8. Where Work Stands: idle. 9. Next Move (optional): none. 10. Agents in flight: none.',
  '</summary>',
]

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify(entry)}\n`)
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      const rec = part as { type?: string; text?: unknown }
      return typeof rec.text === 'string' && !rec.text.trimStart().startsWith('<system-reminder>') ? rec.text : ''
    })
    .filter(text => text !== '')
    .join('\n')
}
type Item = { role?: string; content?: unknown }
function itemsOf(body: Record<string, unknown>): Item[] {
  return Array.isArray(body.messages) ? (body.messages as Item[]) : []
}
function lastAskOf(body: Record<string, unknown>): string {
  const last = [...itemsOf(body)].reverse().find(m => m.role === 'user' && textOf(m.content) !== '')
  return last === undefined ? '' : textOf(last.content)
}
function lastUserRawOf(body: Record<string, unknown>): string {
  const last = [...itemsOf(body)].reverse().find(m => m.role === 'user')
  return last === undefined ? '' : JSON.stringify(last)
}
function toolResultsOf(body: Record<string, unknown>): number {
  return itemsOf(body).filter(m => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(p => p.type === 'tool_result')).length
}
function orderOfWords(raw: string): string[] {
  return WATCHED_WORDS.map(w => ({ w, at: raw.indexOf(w) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(x => x.w)
}

let calls = 0
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function openText(res: ServerResponse, n: number, model: string, u: typeof usage): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_fold_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } } }))
}
const closeText = (u: typeof usage): string =>
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: u }) +
  sse('message_stop', { type: 'message_stop' })

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
    const ask = lastAskOf(body)
    const fold = raw.includes(FOLD_MARKER)
    const toolTurn = !fold && ask.trim().replace(/\s+please$/, '') === TOOL_ASK && toolResultsOf(body) === 0
    record({ kind: fold ? 'fold' : toolTurn ? 'tool-turn' : 'anthropic', n, ask: ask.slice(0, 80), order: orderOfWords(raw), last: orderOfWords(lastUserRawOf(body)), tools, at: Date.now() })
    if (toolTurn) {
      const big = { ...usage, input_tokens: TOOL_TURN_INPUT_TOKENS }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('message_start', { type: 'message_start', message: { id: `msg_fold_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...big, output_tokens: 1 } } }))
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_sleep_c${n}`, name: 'Bash', input: {} } }))
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 2', description: 'a short sleep' }) } }))
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: big }))
      res.end(sse('message_stop', { type: 'message_stop' }))
      return
    }
    openText(res, n, model, usage)
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    if (fold) {
      let i = 0
      const step = (): void => {
        if (res.destroyed || res.writableEnded) return
        if (i < FOLD_DELTAS.length) {
          res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FOLD_DELTAS[i]! } }))
          i++
          setTimeout(step, FOLD_DELTA_MS).unref()
          return
        }
        res.end(closeText(usage))
        record({ kind: 'fold-landed', n, at: Date.now() })
      }
      setTimeout(step, FOLD_FIRST_DELTA_MS).unref()
      return
    }
    const heard = ask === '' || tools === 0 ? 'svc' : `heard: ${ask.trim().split('\n').pop()} (#${n})`
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: heard } }))
    res.end(closeText(usage))
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
