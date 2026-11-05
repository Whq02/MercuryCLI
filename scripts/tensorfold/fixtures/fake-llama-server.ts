#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export const FAKE_LLAMA_VERSION_LINE = 'version: 0.7.0-dev (build 11829, commit 184f653)'
export const FAKE_LLAMA_REPLY = 'hello from llama.cpp'
export const FAKE_LLAMA_TIMINGS = { cache_n: 12, prompt_n: 40, prompt_ms: 210.5, prompt_per_token_ms: 5.26, prompt_per_second: 190.02, predicted_n: 4, predicted_ms: 48.2, predicted_per_token_ms: 12.05, predicted_per_second: 82.99 }

const args = process.argv.slice(2)
const env = process.env

function flagValue(name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function note(text: string): void {
  if (env.FAKE_LLAMA_LOG !== undefined) appendFileSync(env.FAKE_LLAMA_LOG, `${text}\n`)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let text = ''
    request.on('data', chunk => {
      text += String(chunk)
    })
    request.on('end', () => resolve(text))
  })
}

async function serve(): Promise<void> {
  const port = Number(flagValue('--port') ?? 8080)
  const host = flagValue('--host') ?? '127.0.0.1'
  const alias = flagValue('--alias') ?? 'model'
  const ctx = Number(flagValue('--ctx-size') ?? 4096)
  const loadMs = Number(env.FAKE_LLAMA_LOAD_MS ?? 300)
  const slowMs = Number(env.FAKE_LLAMA_SLOW_MS ?? 0)
  note(`args ${JSON.stringify(args)}`)
  note(`env ${JSON.stringify(Object.keys(env).filter(key => key.startsWith('LLAMA_')).sort())}`)
  const ready = Date.now() + loadMs
  const usage = { completion_tokens: 4, prompt_tokens: 40, total_tokens: 44, prompt_tokens_details: { cached_tokens: 12 } }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      if (Date.now() < ready) return json(response, 503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } })
      return json(response, 200, { status: 'ok' })
    }
    if (request.method === 'GET' && url.pathname === '/props') return json(response, 200, { default_generation_settings: { n_ctx: ctx, params: {} }, build_info: 'b11829-184f653' })
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(request)
      note(`request ${body}`)
      let parsed: { stream?: boolean } = {}
      try {
        parsed = JSON.parse(body) as { stream?: boolean }
      } catch {
        parsed = {}
      }
      const id = 'chatcmpl-fake-llama'
      const base = { created: 1_700_000_000, id, model: alias, system_fingerprint: 'b11829-184f653', object: 'chat.completion.chunk' }
      if (parsed.stream !== true) {
        return json(response, 200, { ...base, object: 'chat.completion', choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: FAKE_LLAMA_REPLY } }], usage, timings: FAKE_LLAMA_TIMINGS })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let closed = false
      const gone = (): void => {
        if (!closed && !response.writableEnded) {
          closed = true
          note('client closed before the end')
        }
      }
      response.on('close', gone)
      request.socket.on('close', gone)
      const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): string => `data: ${JSON.stringify({ choices, ...base, ...extra })}\n\n`
      response.write(chunk([{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }]))
      for (const word of FAKE_LLAMA_REPLY.split(' ')) {
        if (closed || response.destroyed || request.socket.destroyed) {
          gone()
          return
        }
        response.write(chunk([{ finish_reason: null, index: 0, delta: { content: `${word} ` } }]))
        if (slowMs > 0) await new Promise(resolve => setTimeout(resolve, slowMs))
      }
      if (closed) return
      response.write(chunk([{ finish_reason: 'stop', index: 0, delta: {} }]))
      response.write(chunk([], { usage, timings: FAKE_LLAMA_TIMINGS }))
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    json(response, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } })
  })
  server.listen(port, host, () => {
    process.stderr.write(`srv  main: server is listening on http://${host}:${port}\n`)
    process.stderr.write(`srv  load_model: loading model '${flagValue('--model') ?? ''}'\n`)
  })
  const stop = (): void => {
    note('stopped')
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (!import.meta.main) {
} else if (args[0] === '--version') {
  process.stderr.write(`${FAKE_LLAMA_VERSION_LINE}\nbuilt with fake for the proofs\n`)
} else if (args.includes('--model')) {
  if (env.FAKE_LLAMA_DIE === '1') {
    process.stderr.write('srv  load_model: failed to load model\nerror: failed to allocate the KV cache (fake)\n')
    process.exit(1)
  }
  await serve()
} else {
  process.stderr.write('usage: llama-server --version | --model FILE [flags]\n')
  process.exit(2)
}
