import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import { SAMPLE_MARKS_BODY_CAP_BYTES } from './contracts.js'
import { formatMarksMessage, parseMarksBody } from './marks.js'
import { renderSampleShell } from './shell.js'
import { appendMarks, getSample, readVersion, sessionOfSample, setSampleListenerAddress } from './store.js'

export interface SampleListenerAddress {
  port: number
  token: string
}

const ROUTE = /^\/s\/([a-z0-9]{6,32})(?:\/(versions|marks)|\/v\/(\d{1,6})\.html)?$/
const COMMON_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const

let attempt: Promise<SampleListenerAddress | null> | null = null
let live: { server: Server; address: SampleListenerAddress } | null = null
let cleanupRegistered = false

export function ensureSampleListener(): Promise<SampleListenerAddress | null> {
  if (attempt === null) attempt = start()
  return attempt
}

export function sampleListenerAddress(): SampleListenerAddress | null {
  return live?.address ?? null
}

export async function closeSampleListener(): Promise<void> {
  const current = live
  live = null
  attempt = null
  setSampleListenerAddress(null)
  if (current === null) return
  await new Promise<void>(resolve => {
    current.server.close(() => resolve())
    if (typeof current.server.closeAllConnections === 'function') current.server.closeAllConnections()
  })
}

function start(): Promise<SampleListenerAddress | null> {
  const token = randomBytes(16).toString('hex')
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      void handle(request, response, token)
    })
    server.on('clientError', (_err, socket) => {
      socket.destroy()
    })
    let bound = false
    server.on('error', (err: Error) => {
      if (bound) {
        logForDebugging(`samples: the listener failed after binding — ${err.message}`, { level: 'warn' })
        return
      }
      logForDebugging(
        `samples: no loopback port could be bound (${err.message}); samples are written as self-contained pages and marks travel by the clipboard`,
        { level: 'warn' },
      )
      resolve(null)
    })
    server.listen(0, '127.0.0.1', () => {
      bound = true
      const bind = server.address()
      const port = typeof bind === 'object' && bind !== null ? bind.port : 0
      const address = { port, token }
      live = { server, address }
      setSampleListenerAddress(address)
      server.unref()
      if (!cleanupRegistered) {
        cleanupRegistered = true
        registerCleanup(closeSampleListener)
      }
      resolve(address)
    })
  })
}

async function handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!tokenMatches(url.searchParams.get('t'), token)) return notFound(response)
    const match = ROUTE.exec(url.pathname)
    if (match === null) return notFound(response)
    const id = match[1]!
    const sub = match[2]
    const versionNumber = match[3] !== undefined ? Number(match[3]) : undefined
    const sessionId = sessionOfSample(id)
    if (sessionId === null) return notFound(response)
    const record = getSample(sessionId, id)
    if (record === null) return notFound(response)

    if (request.method === 'GET' && sub === undefined && versionNumber === undefined) {
      const page = renderSampleShell({ record, versions: record.versions, token })
      response.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }
    if (request.method === 'GET' && versionNumber !== undefined) {
      const html = readVersion(sessionId, id, versionNumber)
      if (html === null) return notFound(response)
      response.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (request.method === 'GET' && sub === 'versions') {
      response.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ latestVersion: record.latestVersion, versions: record.versions }))
      return
    }
    if (request.method === 'POST' && sub === 'marks') {
      const body = await readBody(request, SAMPLE_MARKS_BODY_CAP_BYTES)
      if (body === 'over') {
        response.writeHead(413, COMMON_HEADERS)
        response.end()
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(body)
      } catch {
        raw = undefined
      }
      const marks = parseMarksBody(raw, record.latestVersion)
      if (marks === null) {
        response.writeHead(400, COMMON_HEADERS)
        response.end()
        return
      }
      const appended = appendMarks(sessionId, id, marks)
      const delivered = deliverOperatorMessage(formatMarksMessage(appended.record, marks))
      response.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, delivered, state: appended.record.state, count: appended.count }))
      return
    }
    notFound(response)
  } catch (err) {
    logForDebugging(`samples: a request failed — ${err instanceof Error ? err.message : String(err)}`, { level: 'warn' })
    try {
      if (!response.headersSent) response.writeHead(500, COMMON_HEADERS)
      response.end()
    } catch {
    }
  }
}

function deliverOperatorMessage(text: string): boolean {
  try {
    enqueue({ value: text, mode: 'prompt', uuid: randomUUID() })
    return true
  } catch (err) {
    logForDebugging(`samples: the marks message could not be queued — ${err instanceof Error ? err.message : String(err)}`, { level: 'warn' })
    return false
  }
}

function tokenMatches(given: string | null, token: string): boolean {
  if (given === null || given.length !== token.length) return false
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(token, 'utf8'))
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, COMMON_HEADERS)
  response.end()
}

function readBody(request: IncomingMessage, cap: number): Promise<string | 'over'> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: string | 'over'): void => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > cap) {
        finish('over')
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => finish(''))
  })
}
