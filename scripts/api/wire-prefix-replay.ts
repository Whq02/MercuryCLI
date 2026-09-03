#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'


export interface CaptureResponse {
  usage?: Record<string, number | undefined>
  input_transformations?: Array<{ type?: string; path?: string; reason?: string }>
  model?: string
  text?: string
  status?: number
  error?: string
  ms?: number
  stop_reason?: string | null
}

export interface CaptureRow {
  kind: string
  seq?: number
  at?: number
  url?: string
  path?: string
  model?: string
  source?: string
  headers?: Record<string, string>
  body?: WireBody
  response?: CaptureResponse
}

export interface WireBody {
  model?: string
  system?: unknown
  tools?: unknown
  messages?: unknown[]
  thinking?: unknown
  [key: string]: unknown
}

export function readCapture(file: string): CaptureRow[] {
  const rows: CaptureRow[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as CaptureRow
      if (row && typeof row === 'object' && row.body && typeof row.body === 'object') rows.push(row)
    } catch {
    }
  }
  return rows
}

export function messageRows(rows: CaptureRow[]): CaptureRow[] {
  return rows.filter(row => {
    const url = row.url ?? row.path ?? ''
    const body = row.body
    return url.includes('/messages') || (body !== undefined && Array.isArray(body.messages))
  })
}


export function withoutCacheControl(value: unknown): unknown {
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

const j = (v: unknown): string => JSON.stringify(v)

export interface ByteDiff {
  path: string
  before: string
  after: string
}

const EXCERPT = 120

function excerptAt(text: string, at: number): string {
  const start = Math.max(0, at - 40)
  const slice = text.slice(start, start + EXCERPT)
  return `${start > 0 ? '…' : ''}${j(slice).slice(1, -1)}${start + EXCERPT < text.length ? '…' : ''}`
}

function stringDiff(path: string, a: string, b: string): ByteDiff {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return { path: `${path}@char ${at}`, before: excerptAt(a, at), after: excerptAt(b, at) }
}

export function jsonDiff(path: string, a: unknown, b: unknown): ByteDiff | null {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return null
    return stringDiff(path, a, b)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const d = jsonDiff(`${path}[${i}]`, a[i], b[i])
      if (d !== null) return d
    }
    if (a.length !== b.length) {
      return {
        path: `${path}.length (${a.length} → ${b.length})`,
        before: excerptAt(j(a.slice(n)), 0),
        after: excerptAt(j(b.slice(n)), 0),
      }
    }
    return null
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = [...Object.keys(ao), ...Object.keys(bo).filter(k => !(k in ao))]
    for (const k of keys) {
      if (!(k in ao)) return { path: `${path}.${k} (added)`, before: '', after: excerptAt(j(bo[k]), 0) }
      if (!(k in bo)) return { path: `${path}.${k} (removed)`, before: excerptAt(j(ao[k]), 0), after: '' }
      const d = jsonDiff(`${path}.${k}`, ao[k], bo[k])
      if (d !== null) return d
    }
    if (j(ao) !== j(bo)) {
      return stringDiff(`${path} (key order)`, j(ao), j(bo))
    }
    return null
  }
  if (j(a) === j(b)) return null
  return { path, before: excerptAt(j(a), 0), after: excerptAt(j(b), 0) }
}

export interface PairVerdict {
  held: boolean
  appended: number
  diff: ByteDiff | null
  term: 'system' | 'tools' | 'messages' | 'none'
}

const toolNames = (tools: unknown): string[] =>
  Array.isArray(tools) ? tools.map(t => String((t as { name?: unknown })?.name ?? '?')) : []

export function comparePrefix(prev: WireBody, cur: WireBody): PairVerdict {
  const ps = withoutCacheControl(prev.system)
  const cs = withoutCacheControl(cur.system)
  const systemDiff = jsonDiff('system', ps, cs)
  if (systemDiff !== null) return { held: false, appended: 0, diff: systemDiff, term: 'system' }

  const pt = withoutCacheControl(prev.tools ?? []) as unknown[]
  const ct = withoutCacheControl(cur.tools ?? []) as unknown[]
  const toolsDiff = jsonDiff('tools', pt, ct)
  if (toolsDiff !== null) {
    const pn = toolNames(pt)
    const cn = toolNames(ct)
    if (pn.length !== cn.length) {
      const added = cn.filter(n => !pn.includes(n))
      const removed = pn.filter(n => !cn.includes(n))
      toolsDiff.path = `tools.length (${pn.length} → ${cn.length})${added.length ? ` added [${added.join(', ')}]` : ''}${removed.length ? ` removed [${removed.join(', ')}]` : ''}`
    }
    return { held: false, appended: 0, diff: toolsDiff, term: 'tools' }
  }

  const pm = (withoutCacheControl(prev.messages ?? []) as unknown[])
  const cm = (withoutCacheControl(cur.messages ?? []) as unknown[])
  for (let k = 0; k < pm.length; k++) {
    if (k >= cm.length) {
      return {
        held: false,
        appended: 0,
        diff: { path: `messages.length shrank (${pm.length} → ${cm.length})`, before: excerptAt(j(pm[k]), 0), after: '' },
        term: 'messages',
      }
    }
    const d = jsonDiff(`messages[${k}]`, pm[k], cm[k])
    if (d !== null) return { held: false, appended: 0, diff: d, term: 'messages' }
  }
  return { held: true, appended: cm.length - pm.length, diff: null, term: 'none' }
}


const textOfContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: string; text?: string; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'tool_result') return textOfContent(b.content)
      return ''
    })
    .join('\n')
}

const lastUserText = (body: WireBody): string => {
  const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k]?.role === 'user') return textOfContent(messages[k]!.content)
  }
  return ''
}

const firstUserText = (body: WireBody): string => {
  const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>
  const first = messages.find(m => m.role === 'user')
  return first ? textOfContent(first.content) : ''
}

export function isSummariserRequest(body: WireBody): boolean {
  return lastUserText(body).includes('Reply with prose only') || lastUserText(body).includes('summary of the conversation')
}

export function isPostCompactionRequest(body: WireBody): boolean {
  const head = firstUserText(body)
  return head.includes('continued from a previous conversation') || head.includes('Summary of the session so far') || head.includes('summarized below')
}

export function isSideCall(body: WireBody): boolean {
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  const messages = Array.isArray(body.messages) ? body.messages.length : 0
  return tools === 0 && messages <= 1 && !isSummariserRequest(body)
}

export function thinkingBlockCount(body: WireBody): number {
  let n = 0
  for (const m of (body.messages ?? []) as Array<{ content?: unknown }>) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content as Array<{ type?: string }>) if (block.type === 'thinking') n++
  }
  return n
}

export interface PairReport {
  index: number
  prevSeq: number
  curSeq: number
  model: string
  verdict: PairVerdict
  lawful: 'compaction' | 'model-switch' | null
  cacheRead: number | null
  drops: number | null
  firstDropPath: string | null
  replayedThinking: number
  retry: boolean
  refused: string | null
}

export function refusalOf(row: CaptureRow): string | null {
  const status = row.response?.status
  if (status === undefined || status === 200) return null
  return `${status}${row.response?.error ? ` ${row.response.error}` : ''}`
}

export function conversationRows(rows: CaptureRow[], all = false): CaptureRow[] {
  return messageRows(rows).filter(row => all || !isSideCall(row.body as WireBody))
}

export function reportPairs(rows: CaptureRow[]): PairReport[] {
  const out: PairReport[] = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!
    const cur = rows[i]!
    const pb = prev.body as WireBody
    const cb = cur.body as WireBody
    const verdict = comparePrefix(pb, cb)
    const prevModel = String(pb.model ?? prev.model ?? '')
    const curModel = String(cb.model ?? cur.model ?? '')
    let lawful: PairReport['lawful'] = null
    if (prevModel !== curModel) lawful = 'model-switch'
    else if (isSummariserRequest(cb) || isSummariserRequest(pb) || isPostCompactionRequest(cb)) lawful = 'compaction'
    const usage = cur.response?.usage
    const drops = cur.response?.input_transformations
    const dropped = Array.isArray(drops) ? drops.filter(d => d.type === 'thinking_dropped') : null
    const retry = verdict.held && verdict.appended === 0 && j(withoutCacheControl(pb)) === j(withoutCacheControl(cb))
    out.push({
      index: i,
      prevSeq: prev.seq ?? i,
      curSeq: cur.seq ?? i + 1,
      model: curModel,
      verdict,
      lawful,
      cacheRead: typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null,
      drops: dropped === null ? null : dropped.length,
      firstDropPath: dropped !== null && dropped.length > 0 ? String(dropped[0]!.path ?? '') : null,
      replayedThinking: thinkingBlockCount(cb),
      retry,
      refused: refusalOf(cur),
    })
  }
  return out
}

export function formatPairLine(pair: PairReport): string {
  const v = pair.verdict
  const where = pair.retry ? 'RETRY (byte-identical to the previous request)' : v.held ? `HELD (+${v.appended} row${v.appended === 1 ? '' : 's'})` : `BROKE at ${v.diff?.path ?? '?'}`
  const lawful = pair.lawful === null ? '' : ` [${pair.lawful}]`
  const refused = pair.refused === null ? '' : ` REFUSED ${pair.refused}`
  const cache = pair.cacheRead === null ? '' : ` cache_read=${pair.cacheRead}`
  const drops = pair.drops === null ? '' : ` drops=${pair.drops}${pair.firstDropPath ? ` first=${pair.firstDropPath}` : ''}`
  return `#${pair.prevSeq}→#${pair.curSeq}  ${where}${lawful}${refused}${cache}${drops} thinking_replayed=${pair.replayedThinking}`
}

export function printReport(rows: CaptureRow[], opts: { all?: boolean; quiet?: boolean } = {}): PairReport[] {
  const stream = conversationRows(rows, opts.all)
  const side = messageRows(rows).length - stream.length
  console.log(`${messageRows(rows).length} message request(s) in the capture; ${stream.length} in the conversation stream${side > 0 && !opts.all ? ` (${side} side call(s) skipped — --all keeps them)` : ''}`)
  for (const row of stream) {
    const body = row.body as WireBody
    const tools = toolNames(body.tools)
    const kind = isSummariserRequest(body) ? 'summariser' : isPostCompactionRequest(body) ? 'post-compaction' : 'conversation'
    const refused = refusalOf(row)
    console.log(`  #${row.seq ?? '?'}  ${String(body.model ?? row.model ?? '?')}  ${kind}${row.source ? ` [${row.source}]` : ''}  system=${systemBytes(body)}B tools=${tools.length} messages=${Array.isArray(body.messages) ? body.messages.length : 0} thinking=${thinkingBlockCount(body)}${row.response?.usage ? ` cache_read=${row.response.usage.cache_read_input_tokens ?? 0}` : ''}${row.response?.input_transformations?.length ? ` drops=${row.response.input_transformations.length}` : ''}${refused !== null ? ` REFUSED ${refused}` : ''}${typeof row.response?.ms === 'number' ? ` ${row.response.ms}ms` : ''}`)
  }
  const pairs = reportPairs(stream)
  console.log('')
  for (const pair of pairs) {
    console.log(formatPairLine(pair))
    if (!pair.verdict.held && pair.verdict.diff && !opts.quiet) {
      console.log(`      before: ${pair.verdict.diff.before}`)
      console.log(`      after:  ${pair.verdict.diff.after}`)
    }
  }
  return pairs
}

function systemBytes(body: WireBody): number {
  const s = withoutCacheControl(body.system)
  if (typeof s === 'string') return Buffer.byteLength(s)
  if (Array.isArray(s)) return s.reduce((n, b) => n + Buffer.byteLength(String((b as { text?: string }).text ?? '')), 0)
  return 0
}


export function debugLogWord(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.includes('preserved thinking:') || line.includes('[PROMPT CACHE BREAK]') || line.includes('tool roster frozen'))
  } catch {
    return []
  }
}

export function doctorLedgerWord(home: string): string | null {
  const path = join(home, 'preserved-thinking.json')
  if (!existsSync(path)) return null
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as { last?: Record<string, unknown>; longestRun?: number }
    return `last drop: ${j(ledger.last ?? null)} · longest run: ${ledger.longestRun ?? 0}`
  } catch {
    return null
  }
}

export function transcriptNotices(file: string): string[] {
  const notices: string[] = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('Preserved thinking')) continue
      try {
        const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
        if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
      } catch {
      }
    }
  } catch {
  }
  return notices
}


const KEPT_HEADERS = ['anthropic-beta', 'anthropic-version', 'user-agent', 'x-app', 'content-type']

export function keptHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string') out[name] = value
  }
  return out
}

export function sseResponseSummary(): { feed(chunk: string): void; summary(): CaptureResponse } {
  let buffer = ''
  const summary: CaptureResponse = {}
  const take = (data: string): void => {
    try {
      const event = JSON.parse(data) as { type?: string; message?: { usage?: Record<string, number>; input_transformations?: unknown[]; model?: string }; usage?: Record<string, number>; delta?: { type?: string; text?: string } }
      if (event.type === 'message_start' && event.message) {
        summary.usage = { ...(summary.usage ?? {}), ...(event.message.usage ?? {}) }
        if (Array.isArray(event.message.input_transformations)) summary.input_transformations = event.message.input_transformations as CaptureResponse['input_transformations']
        if (typeof event.message.model === 'string') summary.model = event.message.model
      } else if (event.type === 'message_delta' && event.usage) {
        summary.usage = { ...(summary.usage ?? {}), ...event.usage }
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        summary.text = (summary.text ?? '') + event.delta.text
      }
    } catch {
    }
  }
  return {
    feed(chunk: string): void {
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (line.startsWith('data: ')) take(line.slice(6))
      }
    },
    summary: () => summary,
  }
}

export async function startTap(opts: { out: string; upstream: string; port?: number }): Promise<{ port: number; close(): void }> {
  let seq = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks)
      const url = req.url ?? '/'
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value !== 'string') continue
        if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name)) continue
        headers[name] = value
      }
      let body: unknown = null
      try {
        body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null
      } catch {
        body = null
      }
      const isMessages = req.method === 'POST' && url.includes('/messages')
      const at = Date.now()
      const reader = sseResponseSummary()
      let status = 0
      try {
        const upstream = await fetch(`${opts.upstream.replace(/\/$/, '')}${url}`, {
          method: req.method,
          headers,
          body: raw.length > 0 ? raw : undefined,
        })
        status = upstream.status
        const responseHeaders: Record<string, string> = {}
        upstream.headers.forEach((value, name) => {
          if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) return
          responseHeaders[name] = value
        })
        res.writeHead(upstream.status, responseHeaders)
        if (upstream.body) {
          const decoder = new TextDecoder()
          for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
            res.write(Buffer.from(chunk))
            if (isMessages) reader.feed(decoder.decode(chunk, { stream: true }))
          }
        }
        res.end()
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'tap_error', message: String(error) } }))
      }
      if (isMessages && body !== null) {
        seq++
        const row: CaptureRow = {
          kind: 'request',
          seq,
          at,
          url,
          model: String((body as WireBody).model ?? ''),
          headers: keptHeaders(req.headers as Record<string, string | string[] | undefined>),
          body: body as WireBody,
          response: { ...reader.summary(), status },
        }
        appendFileSync(opts.out, `${JSON.stringify(row)}\n`)
      }
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { port, close: () => server.close() }
}


function usage(): never {
  console.log(`usage:
  wire-prefix-replay.ts <capture.jsonl> [--all] [--quiet] [--expect-held] [--debug-file <file>] [--home <config-home>] [--transcript <session.jsonl>]
  wire-prefix-replay.ts tap --out <capture.jsonl> [--upstream https://api.anthropic.com] [--port N]`)
  process.exit(2)
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage()
  if (argv[0] === 'tap') {
    const out = arg(argv, '--out')
    if (!out) usage()
    const upstream = arg(argv, '--upstream') ?? 'https://api.anthropic.com'
    const portArg = arg(argv, '--port')
    const tap = await startTap({ out, upstream, port: portArg ? Number(portArg) : 0 })
    console.log(`TAP http://127.0.0.1:${tap.port} → ${upstream}; rows append to ${out}`)
    console.log(`run: ANTHROPIC_BASE_URL=http://127.0.0.1:${tap.port} MERCURY_THINKING_BINDING=drop_block MERCURY_TOOL_SEARCH=on mercury`)
    return
  }
  const file = argv[0]!
  if (!existsSync(file)) {
    console.log(`no such capture: ${file}`)
    process.exit(2)
  }
  const rows = readCapture(file)
  const pairs = printReport(rows, { all: argv.includes('--all'), quiet: argv.includes('--quiet') })
  const debugFile = arg(argv, '--debug-file')
  if (debugFile) {
    const word = debugLogWord(debugFile)
    console.log(`\nthe product's own word (${debugFile}): ${word.length} line(s)`)
    for (const line of word) console.log(`  ${line.slice(0, 400)}`)
  }
  const transcript = arg(argv, '--transcript')
  if (transcript) {
    const notices = transcriptNotices(transcript)
    console.log(`\ntranscript notices (${transcript}): ${notices.length}`)
    for (const notice of notices) console.log(`  ${notice.slice(0, 400)}`)
  }
  const home = arg(argv, '--home')
  if (home) console.log(`\ndoctor ledger (${home}): ${doctorLedgerWord(home) ?? 'none written'}`)
  const broken = pairs.filter(p => !p.verdict.held && p.lawful === null)
  const lawfulBreaks = pairs.filter(p => !p.verdict.held && p.lawful !== null)
  console.log(`\n${pairs.length} pair(s): ${pairs.filter(p => p.verdict.held).length} held · ${lawfulBreaks.length} moved on a lawful change · ${broken.length} rewrote sent history`)
  if (argv.includes('--expect-held') && broken.length > 0) process.exit(1)
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  main(process.argv.slice(2)).catch(error => {
    console.log(`wire-prefix-replay: ${String(error)}`)
    process.exit(2)
  })
}
