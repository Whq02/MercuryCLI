#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-turn-waits-for-a-working-engine')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'working-engine-')))
console.log(`build under proof: ${DIST}`)

const MODEL = 'slow-fixture-4b'
const WINDOW = 65_536
const LIMIT_MINUTES = '1.5'
const LIMIT_MS = 90_000
const FIRST_BYTE_MS = 110_000
const ANSWER = 'The slow engine answered.'

type Engine = { root: string; chatAt: number | null; firstByteAt: number | null; checksInTheWait: number; dropped: boolean; close(): Promise<void> }
async function startEngine(answersItsCheck: boolean): Promise<Engine> {
  const engine: Engine = { root: '', chatAt: null, firstByteAt: null, checksInTheWait: 0, dropped: false, close: async () => {} }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      const waiting = engine.chatAt !== null && engine.firstByteAt === null && !engine.dropped
      if (req.method === 'GET' && path === '/health') {
        if (!waiting) return json(200, { status: 'ok' })
        engine.checksInTheWait++
        if (answersItsCheck) return json(200, { status: 'ok' })
        req.socket.destroy()
        return
      }
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'llamacpp', meta: { n_ctx: WINDOW, n_ctx_train: 262144, n_params: 4_000_000_000, size: 2_600_000_000 } }] })
      if (req.method === 'GET' && path === '/props') return json(200, { default_generation_settings: { n_ctx: WINDOW }, total_slots: 1, modalities: { vision: false }, chat_template_caps: { supports_tools: true, supports_tool_calls: true } })
      if (req.method === 'GET' && path === '/slots') return json(200, [{ id: 0, n_ctx: WINDOW, is_processing: waiting }])
      if (req.method !== 'POST' || path !== '/v1/chat/completions') return json(404, { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } })
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: unknown[] }
      const base = { created: 1_794_000_000, id: 'chatcmpl-slow', model: MODEL, system_fingerprint: 'b12359-fixture', object: 'chat.completion.chunk' }
      const answer = (text: string): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }], ...base })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: null, index: 0, delta: { content: text } }], ...base })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', index: 0, delta: {} }], ...base })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 6, prompt_tokens: 4000, total_tokens: 4006, prompt_tokens_details: { cached_tokens: 0 } }, ...base })}\n\n`)
        res.end('data: [DONE]\n\n')
      }
      if (!Array.isArray(body.tools) || body.tools.length === 0) return answer('side')
      engine.chatAt = Date.now()
      res.on('close', () => {
        if (engine.firstByteAt === null) engine.dropped = true
      })
      if (!answersItsCheck) return
      const timer = setTimeout(() => {
        if (engine.dropped) return
        engine.firstByteAt = Date.now()
        answer(ANSWER)
      }, FIRST_BYTE_MS)
      timer.unref?.()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  engine.root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  engine.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  return engine
}

type Row = Record<string, unknown>
type Run = { exit: number | null; rows: Row[]; stderr: string; wallMs: number }
function run(name: string, engine: Engine): Promise<Run> {
  const runHome = join(scratch, `${name}-home`)
  const userHome = join(scratch, `${name}-user`)
  const cwd = join(scratch, `${name}-project`)
  mkdirSync(userHome, { recursive: true })
  seedScratchHome(runHome, cwd)
  const env: NodeJS.ProcessEnv = { ...childEnv(runHome, 1), HOME: userHome, USERPROFILE: userHome, MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${engine.root}`, MERCURY_HEADLESS_IDLE_MINUTES: LIMIT_MINUTES }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', 'say one line', '--format', 'rows', '--model', `local/${MODEL}`, '--sovereign', '--max-time', '6m'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const rows: Row[] = []
    let out = ''
    let stderr = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const lines = out.split('\n')
      out = lines.pop() ?? ''
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line) as Row)
        } catch {
          continue
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, rows, stderr, wallMs: Date.now() - startedAt })
    })
  })
}

const working = await startEngine(true)
const dead = await startEngine(false)
const [alive, cut] = await Promise.all([run('working', working), run('dead', dead)])
await working.close()
await dead.close()

const outcomesOf = (result: Run): Row[] => result.rows.filter(row => row.type === 'outcome')
const said = (result: Run): string => JSON.stringify(outcomesOf(result))
const waitedMs = working.chatAt !== null && working.firstByteAt !== null ? working.firstByteAt - working.chatAt : 0

tally.section('a local engine that takes a prompt in for longer than the turn\'s limit and answers its check')
tally.check('the engine held its first byte for longer than the turn\'s whole limit', waitedMs > LIMIT_MS, `${waitedMs}ms against a limit of ${LIMIT_MS}ms · dropped=${working.dropped}`)
tally.check('the transport asked the engine whether it lives during that wait, and was answered', working.checksInTheWait >= 1, String(working.checksInTheWait))
tally.check('the wait row carried the transport\'s own checked-alive stamp', alive.rows.some(row => row.type === 'wait' && typeof row.checked_ms === 'number'), JSON.stringify(alive.rows.filter(row => row.type === 'wait')).slice(0, 400))
tally.check('the turn ended in the engine\'s answer and the run exits clean', alive.exit === 0 && outcomesOf(alive).length === 1 && outcomesOf(alive)[0]?.status === 'completed' && outcomesOf(alive)[0]?.answer === ANSWER, `exit=${alive.exit} ${said(alive).slice(0, 400)} ${alive.stderr.slice(-200)}`)
tally.check('no outcome names the unattended-turn deadline', !/unattended turn: no progress/.test(said(alive)), said(alive).slice(0, 400))

tally.section('the same wait on an engine that stops answering its check')
tally.check('the transport asked and was not answered', dead.checksInTheWait >= 1 && dead.firstByteAt === null, String(dead.checksInTheWait))
tally.check('the turn is cut: a failed outcome, no answer, a run that exits non-zero', cut.exit !== null && cut.exit !== 0 && outcomesOf(cut).length >= 1 && outcomesOf(cut).every(row => row.status !== 'completed'), `exit=${cut.exit} ${said(cut).slice(0, 400)}`)
tally.check('the cut names the engine that gave no answer, or the turn\'s own limit', /no answer from .+ while ingesting|unattended turn: no progress/.test(said(cut)), said(cut).slice(0, 500))
tally.check('it came no later than the turn\'s limit after the last answer the engine gave', cut.wallMs < LIMIT_MS + 60_000, `${cut.wallMs}ms`)
rmSync(scratch, { recursive: true, force: true })
tally.finish()
