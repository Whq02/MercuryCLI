#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'

const captureFile = process.argv[2]
const catalogueFile = process.argv[3]
if (!captureFile || !catalogueFile) {
  console.error('usage: model-refresh-families-fixture-server.ts <captureFile> <catalogueFile>')
  process.exit(2)
}

type Family = 'openrouter' | 'gemini' | 'huggingface' | 'local'
type OllamaLists = { tags: unknown; ps: unknown; show: Record<string, unknown> }
type FamilyLists = { before: unknown; after: unknown; delayMs?: number; reply?: string }
type Catalogue = { families: Partial<Record<Family, FamilyLists>>; switchOn?: 'turn' | 'never' }

const REPLY = 'alpha answers from the fixture'
let turned = false

function catalogue(): Catalogue {
  return JSON.parse(readFileSync(catalogueFile, 'utf8')) as Catalogue
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(captureFile, `${JSON.stringify({ ...entry, at: Date.now() })}\n`)
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function chatCompletionsSse(text: string): string {
  const id = `chatcmpl_fx_${Date.now()}`
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    sse({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  return [chunk({ role: 'assistant', content: '' }, null), chunk({ content: text }, null), chunk({}, 'stop'), 'data: [DONE]\n\n'].join('')
}

function geminiSse(text: string): string {
  return [
    sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] }),
    sse({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 } }),
  ].join('')
}

function anthropicSse(text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

function familyOf(path: string): Family | undefined {
  if (path.startsWith('/or/')) return 'openrouter'
  if (path.startsWith('/gemini/')) return 'gemini'
  if (path.startsWith('/hf/')) return 'huggingface'
  if (path.startsWith('/ollama/')) return 'local'
  return undefined
}

function listsFor(family: Family): { lists: unknown; delayMs: number; phase: 'before' | 'after' } | undefined {
  const spec = catalogue().families[family]
  if (!spec) return undefined
  const phase = turned ? 'after' : 'before'
  return { lists: phase === 'after' ? spec.after : spec.before, delayMs: phase === 'after' ? (spec.delayMs ?? 0) : 0, phase }
}

function answerJson(res: ServerResponse, body: unknown, delayMs: number, landed?: Record<string, unknown>): void {
  const send = (): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    if (landed) record({ ...landed, kind: 'landed' })
  }
  if (delayMs > 0) setTimeout(send, delayMs)
  else send()
}

function turn(family: Family | 'anthropic', res: ServerResponse, body: string): void {
  const spec = family === 'anthropic' ? undefined : catalogue().families[family]
  const text = spec?.reply ?? REPLY
  record({ kind: 'turn', family })
  if (catalogue().switchOn !== 'never') turned = true
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(body === 'gemini' ? geminiSse(text) : body === 'anthropic' ? anthropicSse(text) : chatCompletionsSse(text))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = req.url ?? ''
    const path = url.split('?')[0] ?? ''
    const family = familyOf(path)
    const method = req.method ?? 'GET'
    if (family !== undefined) {
      const served = listsFor(family)
      if (served === undefined) {
        record({ kind: 'hit', family, method, path })
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const { lists, delayMs, phase } = served
      if (family === 'openrouter' && method === 'GET' && path === '/or/v1/models') {
        record({ kind: 'models', family, method, path, phase })
        answerJson(res, { data: lists, total_count: (lists as unknown[]).length, links: { next: null } }, delayMs, { family })
        return
      }
      if (family === 'openrouter' && method === 'GET' && path === '/or/v1/key') {
        record({ kind: 'hit', family, method, path })
        answerJson(res, { data: { label: 'fixture', usage: 0, limit: null, limit_remaining: null, is_free_tier: false } }, 0)
        return
      }
      if (family === 'gemini' && method === 'GET' && path === '/gemini/v1beta/models') {
        record({ kind: 'models', family, method, path, phase })
        answerJson(res, { models: lists }, delayMs, { family })
        return
      }
      if (family === 'huggingface' && method === 'GET' && path === '/hf/v1/models') {
        record({ kind: 'models', family, method, path, phase })
        answerJson(res, { object: 'list', data: lists }, delayMs, { family })
        return
      }
      if (family === 'local' && method === 'GET' && path === '/ollama/api/tags') {
        record({ kind: 'models', family, method, path, phase })
        answerJson(res, (lists as OllamaLists).tags, delayMs, { family })
        return
      }
      if (family === 'local' && method === 'GET' && path === '/ollama/api/version') {
        record({ kind: 'hit', family, method, path })
        answerJson(res, { version: '0.11.4' }, delayMs)
        return
      }
      if (family === 'local' && method === 'GET' && path === '/ollama/api/ps') {
        record({ kind: 'hit', family, method, path })
        answerJson(res, (lists as OllamaLists).ps, delayMs)
        return
      }
      if (family === 'local' && method === 'POST' && path === '/ollama/api/show') {
        record({ kind: 'hit', family, method, path })
        let model = ''
        try {
          model = String((JSON.parse(raw) as { model?: string }).model ?? '')
        } catch {
          model = ''
        }
        const shows = (lists as OllamaLists).show
        if (Object.hasOwn(shows, model)) answerJson(res, shows[model], delayMs, { family, path })
        else {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'model not found' }))
        }
        return
      }
      if (method === 'POST' && path.endsWith('/chat/completions')) {
        turn(family, res, 'chat')
        return
      }
      if (family === 'gemini' && method === 'POST' && /:streamGenerateContent$/.test(path)) {
        turn(family, res, 'gemini')
        return
      }
      record({ kind: 'hit', family, method, path })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (method === 'POST' && path.endsWith('/v1/messages')) {
      turn('anthropic', res, 'anthropic')
      return
    }
    record({ kind: 'hit', method, path })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  console.log(`PORT ${port}`)
})
