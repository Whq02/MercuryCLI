import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const STANDIN_MODEL = 'jev-1.13.0'
export const STANDIN_PATH = '/v1/systemone'
export const STANDIN_TOKEN_FLOOR = 300
export const STANDIN_OUTPUT_TOKENS = 20

export interface StandinScript {
  status: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
  delayMs?: number
}

export interface StandinRecord {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  rawBody: string
  body: unknown
  at: number
}

export interface JevStandin {
  port: number
  base: string
  received: StandinRecord[]
  next(script: StandinScript): void
  pending(): number
  reset(): void
  close(): Promise<void>
}

type Question = { type?: unknown; instructions?: unknown; criteria?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function concentration(probabilities: number[]): number {
  const n = probabilities.length
  if (n < 2) return 1
  const peak = Math.max(...probabilities)
  return round(Math.max(0, Math.min(1, (n * peak - 1) / (n - 1))))
}

export function defaultAnswerFor(question: unknown): unknown {
  const q = (isRecord(question) ? question : {}) as Question
  if (q.type === 'choice' && isRecord(q.criteria)) {
    const labels = Object.keys(q.criteria)
    const n = labels.length
    const probabilities: Record<string, number> = {}
    if (n === 1) probabilities[labels[0]!] = 1
    else {
      const first = 0.6
      const rest = round((1 - first) / (n - 1))
      let sum = 0
      labels.forEach((label, index) => {
        const p = index === 0 ? first : index === n - 1 ? round(1 - sum) : rest
        probabilities[label] = p
        sum = round(sum + p)
      })
    }
    return { type: 'choice', choice: labels[0] ?? '', probabilities, confidence: concentration(Object.values(probabilities)) }
  }
  if (q.type === 'score' && Array.isArray(q.criteria)) {
    const k = q.criteria.length
    const legend: Record<string, string> = {}
    const probabilities: Record<string, number> = {}
    const weights = k === 2 ? [0.32, 0.68] : [0.22, 0.68, ...Array.from({ length: Math.max(0, k - 2) }, () => round(0.1 / Math.max(1, k - 2)))]
    let sum = 0
    let score = 0
    for (let index = 0; index < k; index++) {
      const p = index === k - 1 ? round(1 - sum) : weights[index]!
      legend[String(index)] = String(q.criteria[index])
      probabilities[String(index)] = p
      sum = round(sum + p)
      score = round(score + index * p)
    }
    return { type: 'score', score, legend, probabilities, confidence: concentration(Object.values(probabilities)) }
  }
  return { type: 'noul', noul: 0.95 }
}

export function defaultResponseFor(body: unknown, rawBody: string): unknown {
  const answers: Record<string, unknown> = {}
  const questions = isRecord(body) && isRecord(body.questions) ? body.questions : {}
  for (const [id, question] of Object.entries(questions)) answers[id] = defaultAnswerFor(question)
  return {
    model: STANDIN_MODEL,
    answers,
    usage: { input_tokens: STANDIN_TOKEN_FLOOR + Math.ceil(Buffer.byteLength(rawBody, 'utf8') / 4), output_tokens: STANDIN_OUTPUT_TOKENS },
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, text: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text, 'utf8')), ...headers })
  response.end(text)
}

export async function startJevStandin(): Promise<JevStandin> {
  const queue: StandinScript[] = []
  const received: StandinRecord[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server: Server = createServer((request, response) => {
    let gone = false
    response.once('close', () => {
      gone = true
    })
    void (async () => {
      const rawBody = await readBody(request)
      let body: unknown
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        body = undefined
      }
      received.push({ method: request.method ?? '', path: request.url ?? '', headers: { ...request.headers }, rawBody, body, at: Date.now() })
      const script = queue.shift()
      const reply = (): void => {
        if (gone || response.destroyed) return
        try {
          if (script !== undefined) {
            const text = script.raw !== undefined ? script.raw : JSON.stringify(script.body ?? {})
            send(response, script.status, script.headers ?? {}, text)
            return
          }
          if (request.method !== 'POST') return send(response, 405, {}, JSON.stringify({ error: { message: 'method not allowed' } }))
          if (request.url !== STANDIN_PATH) return send(response, 404, {}, JSON.stringify({ error: { message: 'not found' } }))
          if (body === undefined) return send(response, 400, {}, JSON.stringify({ error: { message: 'the body is not JSON' } }))
          send(response, 200, {}, JSON.stringify(defaultResponseFor(body, rawBody)))
        } catch {
          gone = true
        }
      }
      const delay = script?.delayMs ?? 0
      if (delay <= 0) return reply()
      const timer = setTimeout(() => {
        timers.delete(timer)
        reply()
      }, delay)
      timers.add(timer)
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    received,
    next(script) {
      queue.push(script)
    },
    pending() {
      return queue.length
    },
    reset() {
      queue.length = 0
      received.length = 0
    },
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      return new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
