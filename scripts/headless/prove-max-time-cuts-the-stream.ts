#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { OUTCOME_SENTENCES } from '../../src/rows/vocabulary.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`)
  if (!ok) failures++
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const j = (value: unknown): string => JSON.stringify(value)?.slice(0, 400) ?? ''

const MODEL = 'plain:8b'
const DETAILS = { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '8B', quantization_level: 'Q4_K_M' }
const events: Array<{ at: number; what: string }> = []
const bodies: Array<Record<string, unknown>> = []
const encoder = new TextEncoder()
const ollamaServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req: Request) {
    const url = new URL(req.url).pathname
    let body: Record<string, unknown> = {}
    try {
      const raw = await req.text()
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      body = {}
    }
    events.push({ at: Date.now(), what: url })
    if (url === '/api/tags') return Response.json({ models: [{ name: MODEL, model: MODEL, modified_at: '2026-01-01T00:00:00Z', size: 4_600_000_000, digest: 'bb22', details: DETAILS, capabilities: ['completion', 'tools'] }] })
    if (url === '/api/version') return Response.json({ version: '0.34.4' })
    if (url === '/api/ps') return Response.json({ models: [] })
    if (url === '/api/show') return Response.json({ modelfile: '', parameters: '', template: '{{ .Prompt }}', details: DETAILS, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools'] })
    if (url === '/api/generate') return Response.json({ model: body.model, response: '', done: true, done_reason: 'load' })
    if (url === '/api/chat') {
      bodies.push(body)
      let tick: ReturnType<typeof setInterval> | null = null
      const closed = (): void => {
        if (tick !== null) clearInterval(tick)
        tick = null
        if (!events.some(event => event.what === 'socket closed')) events.push({ at: Date.now(), what: 'socket closed' })
      }
      req.signal.addEventListener('abort', closed)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          tick = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify({ model: MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'more ' }, done: false })}\n`))
            } catch {
              closed()
            }
          }, 50)
        },
        cancel: closed,
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
const ollama = { root: `http://127.0.0.1:${ollamaServer.port}` }

type Run = { code: number | null; out: string; err: string; rows: Array<Record<string, unknown>>; outcomeAt: number; spawnedAt: number }
function mercuryRun(args: string[], home: string, cwd: string, budgetMs: number): Promise<Run> {
  const spawnedAt = Date.now()
  const child = spawn('node', [dist, 'run', ...args], {
    cwd,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      MERCURY_CONFIG_DIR: home,
      MERCURY_HOME: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: `ollama=${ollama.root}`,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  let outcomeAt = 0
  child.stdout.on('data', d => {
    out += String(d)
    if (outcomeAt === 0 && out.includes('"type":"outcome"')) outcomeAt = Date.now()
  })
  child.stderr.on('data', d => {
    err += String(d)
  })
  const guard = setTimeout(() => child.kill('SIGKILL'), budgetMs)
  return new Promise<Run>(done =>
    child.on('close', code => {
      clearTimeout(guard)
      const rows = out
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((row): row is Record<string, unknown> => row !== null)
      done({ code, out, err, rows, outcomeAt, spawnedAt })
    }),
  )
}

const home = realpathSync(mkdtempSync(join(tmpdir(), 'max-time-stream-')))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, 'note.txt'), 'hello\n')
seedFirstRun(home, [cwd])
const LIMIT_MS = 3_000
try {
  console.log('§1 a local model that streams forever is cut at --max-time: the request is aborted, the server sees its socket close, the outcome is time_limit and the run exits 1')
  const debugLog = join(home, 'd.log')
  const run = await mercuryRun(['talk forever', '--format', 'rows', '--model', `local/${MODEL}`, '--max-time', '3s', '--log-file', debugLog], home, cwd, 60_000)
  for (let i = 0; i < 100 && !events.some(event => event.what === 'socket closed'); i++) await new Promise(resolveWait => setTimeout(resolveWait, 10))
  const wireLine = existsSync(debugLog) ? readFileSync(debugLog, 'utf8').split('\n').find(line => line.includes(`/api/chat stream from ${MODEL}:`) && line.includes('ended cancelled')) : undefined
  const outcome = run.rows.filter(row => row.type === 'outcome').at(-1) as { status?: string; error?: { message?: string; class?: string }; wall_ms?: number } | undefined
  const chatAt = events.find(event => event.what === '/api/chat')?.at
  const closedAt = events.find(event => event.what === 'socket closed')?.at
  const firstHit = events[0]?.at
  record(`spawn → first probe ${firstHit !== undefined ? firstHit - run.spawnedAt : '?'}ms · → /api/chat ${chatAt !== undefined ? chatAt - run.spawnedAt : '?'}ms · → socket closed ${closedAt !== undefined ? closedAt - run.spawnedAt : '?'}ms · → outcome ${run.outcomeAt !== 0 ? run.outcomeAt - run.spawnedAt : '?'}ms · exit ${run.code}`)
  record(`the outcome: ${j(outcome)}`)
  check('the request reached the server and streamed for at least a second before the cut', chatAt !== undefined && closedAt !== undefined && closedAt - chatAt >= 1_000, j({ chatAt, closedAt }))
  check('the request body carried the output ceiling (options.num_predict)', typeof (bodies[0]?.options as { num_predict?: unknown } | undefined)?.num_predict === 'number', j(bodies[0]?.options))
  check('the outcome is time_limit with the existing sentence and class', outcome?.status === 'time_limit' && outcome.error?.class === 'time_limit' && outcome.error.message === OUTCOME_SENTENCES.time_limit({ maxTimeMs: LIMIT_MS }), j(outcome))
  check('the server saw the request socket close within a second of the outcome', closedAt !== undefined && run.outcomeAt !== 0 && Math.abs(closedAt - run.outcomeAt) < 1_000, j({ closedAt, outcomeAt: run.outcomeAt }))
  check('the abort reached the transport: its wire record says the stream ended cancelled', wireLine !== undefined, wireLine ?? 'no wire record')
  check('the outcome landed within a second of the deadline (the limit counts from the run\'s start; the first probe bounds the start)', firstHit !== undefined && run.outcomeAt - run.spawnedAt >= LIMIT_MS && run.outcomeAt - firstHit < LIMIT_MS + 1_000, j({ sinceSpawn: run.outcomeAt - run.spawnedAt, sinceFirstHit: firstHit !== undefined ? run.outcomeAt - firstHit : null }))
  check('the run exits 1', run.code === 1, String(run.code))
  check('no second request was made after the cut', bodies.length === 1, String(bodies.length))
} finally {
  ollamaServer.stop(true)
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
