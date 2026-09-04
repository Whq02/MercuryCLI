#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'

const captureFile = process.argv[2]
const fixtureCwd = process.argv[3] ?? process.cwd()
if (!captureFile) {
  console.error('usage: turn-end-fixture-server.ts <captureFile> [fixtureCwd]')
  process.exit(2)
}

export const REPLY_TEXT = 'the reply stands here after its last item'
export const HOLD_AFTER_SETTLE_ASK = 'hold after settle'
export const CLOSE_AFTER_SETTLE_ASK = 'close after settle'
export const HOLD_AFTER_END_ASK = 'hold after end'
export const READ_THREE_ASK = 'read three files'
export const SLEEP_TOOL_ASK = 'run the long sleep'
export const READ_HOLD_MS = 6_000
export const SLEEP_SECONDS = 40

type Arm = 'hold-after-settle' | 'close-after-settle' | 'hold-after-end' | 'read-three' | 'sleep-tool' | 'complete'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`
const DELTAS = ['the reply stands here ', 'after its ', 'last item']

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

function lastAskOf(body: Record<string, unknown>): string {
  const input = body.input
  if (typeof input === 'string') return input
  const items = Array.isArray(input) ? input : Array.isArray(body.messages) ? body.messages : []
  const last = [...(items as Array<{ role?: string; content?: unknown; type?: string }>)]
    .reverse()
    .find(m => m.role === 'user' && textOf(m.content) !== '')
  return last === undefined ? '' : textOf(last.content)
}

function armOf(ask: string): Arm {
  const words = ask.trim().replace(/\s+please$/, '')
  if (words === HOLD_AFTER_SETTLE_ASK) return 'hold-after-settle'
  if (words === CLOSE_AFTER_SETTLE_ASK) return 'close-after-settle'
  if (words === HOLD_AFTER_END_ASK) return 'hold-after-end'
  return 'complete'
}

function toolArmOf(body: Record<string, unknown>): { arm: 'read-three' | 'sleep-tool'; step: number } | null {
  const input = body.input
  const items = Array.isArray(input) ? input : Array.isArray(body.messages) ? body.messages : []
  let step = 0
  let first = ''
  for (const raw of items as Array<{ role?: string; content?: unknown; type?: string; call_id?: string }>) {
    if (raw.type === 'function_call_output') step++
    if (raw.role === 'user') {
      const content = raw.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if ((part as { type?: string }).type === 'tool_result') step++
        }
      }
      const text = textOf(content)
      if (first === '' && text !== '') first = text.trim().replace(/\s+please$/, '')
    }
  }
  if (first === READ_THREE_ASK) return { arm: 'read-three', step }
  if (first === SLEEP_TOOL_ASK) return { arm: 'sleep-tool', step }
  return null
}

function carriesWords(body: Record<string, unknown>, words: string[]): string[] {
  const raw = JSON.stringify(body)
  return words.filter(w => raw.includes(w))
}
export const QUEUED_WORDS_WATCH = ['first queued words', 'second queued words']

function toolStep(arm: 'read-three' | 'sleep-tool', step: number, cwd: string): { name: string; input: Record<string, unknown>; id: string } | null {
  if (arm === 'sleep-tool') {
    return step === 0 ? { name: 'Bash', input: { command: `sleep ${SLEEP_SECONDS}`, description: 'the long sleep' }, id: 'toolu_sleep_1' } : null
  }
  const files = ['a.md', 'b.md', 'c.md']
  const file = files[step]
  if (file === undefined) return null
  return { name: 'Read', input: { file_path: `${cwd}/${file}` }, id: `toolu_read_${step + 1}` }
}


const held = new Set<ServerResponse>()
let openaiCalls = 0
let anthropicCalls = 0

function finishBody(res: ServerResponse, wire: 'openai' | 'anthropic', n: number, arm: Arm, endFrames: string): void {
  if (arm === 'complete') {
    res.end(endFrames)
    return
  }
  if (arm === 'close-after-settle') {
    res.end()
    record({ kind: 'closed', wire, n, at: Date.now() })
    return
  }
  if (arm === 'hold-after-end') res.write(endFrames)
  held.add(res)
  record({ kind: 'held', wire, n, arm, at: Date.now() })
  res.socket?.on('close', () => {
    if (held.delete(res)) record({ kind: 'peer-closed', wire, n, at: Date.now() })
  })
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
    if (req.method === 'GET' && url.endsWith('/models')) {
      record({ kind: 'hit', method: req.method, url, at: Date.now() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'gpt-5.6-sol',
              display_name: 'GPT-5.6 Sol',
              supported_reasoning_levels: ['low', 'medium', 'high'],
              default_reasoning_level: 'medium',
              visibility: 'public',
              supported_in_api: true,
              priority: 1,
              context_window: 400_000,
              input_modalities: ['text', 'image'],
            },
          ],
        }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/responses')) {
      const n = ++openaiCalls
      const ask = lastAskOf(body)
      const tool = toolArmOf(body)
      const arm = tool?.arm ?? armOf(ask)
      const carries = carriesWords(body, QUEUED_WORDS_WATCH)
      record({ kind: 'openai', n, ask: ask.slice(0, 120), arm, ...(tool ? { step: tool.step } : {}), carries, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const rid = `resp_turnend_${n}`
      const itemId = `msg_turnend_${n}`
      if (tool !== null) {
        const call = toolStep(tool.arm, tool.step, fixtureCwd)
        const serve = (): void => {
          res.write(sse({ type: 'response.created', response: { id: rid } }))
          if (call !== null) {
            res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) } }))
          } else {
            res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: REPLY_TEXT }] } }))
          }
          res.end(sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 21, output_tokens: 9 } } }))
        }
        if (tool.arm === 'read-three' && tool.step === 1) setTimeout(serve, READ_HOLD_MS).unref()
        else serve()
        return
      }
      res.write(sse({ type: 'response.created', response: { id: rid } }))
      res.write(
        sse({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: itemId, role: 'assistant', content: [] },
        }),
      )
      for (const delta of DELTAS) {
        res.write(sse({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta }))
      }
      res.write(
        sse({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: REPLY_TEXT }] },
        }),
      )
      finishBody(
        res,
        'openai',
        n,
        arm,
        sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 21, output_tokens: 9 } } }),
      )
      return
    }
    if (req.method === 'POST' && url.endsWith('/v1/messages')) {
      const n = ++anthropicCalls
      const ask = lastAskOf(body)
      const tool = toolArmOf(body)
      const arm = tool?.arm ?? armOf(ask)
      const carries = carriesWords(body, QUEUED_WORDS_WATCH)
      record({ kind: 'anthropic', n, ask: ask.slice(0, 120), arm, ...(tool ? { step: tool.step } : {}), carries, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (tool !== null) {
        const call = toolStep(tool.arm, tool.step, fixtureCwd)
        const model = typeof body.model === 'string' ? body.model : 'fixture'
        const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
        const serve = (): void => {
          res.write(named('message_start', { type: 'message_start', message: { id: `msg_turnend_t${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
          if (call !== null) {
            res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
            res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }))
            res.write(named('content_block_stop', { type: 'content_block_stop', index: 0 }))
            res.write(named('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
          } else {
            res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
            res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY_TEXT } }))
            res.write(named('content_block_stop', { type: 'content_block_stop', index: 0 }))
            res.write(named('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
          }
          res.end(named('message_stop', { type: 'message_stop' }))
        }
        if (tool.arm === 'read-three' && tool.step === 1) setTimeout(serve, READ_HOLD_MS).unref()
        else serve()
        return
      }
      res.write(
        named('message_start', {
          type: 'message_start',
          message: {
            id: `msg_turnend_a${n}`,
            type: 'message',
            role: 'assistant',
            model: typeof body.model === 'string' ? body.model : 'fixture',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
          },
        }),
      )
      res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      for (const delta of arm === 'complete' && ask === '' ? ['svc'] : DELTAS) {
        res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }))
      }
      res.write(named('content_block_stop', { type: 'content_block_stop', index: 0 }))
      finishBody(
        res,
        'anthropic',
        n,
        arm,
        named('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 },
        }) + named('message_stop', { type: 'message_stop' }),
      )
      return
    }
    record({ kind: 'hit', method: req.method, url, at: Date.now() })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${url}` } }))
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  console.log(`PORT ${port}`)
})

const shutdown = (): void => {
  for (const res of held) res.destroy()
  held.clear()
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
