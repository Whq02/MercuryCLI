#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-turn-waits-for-a-working-engine')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'working-engine-')))
console.log(`build under proof: ${DIST}`)

const MODEL = 'slow-fixture-4b'
const WINDOW = 65_536
const ANSWER = 'The slow engine answered.'
const CAP_MS = 2 * 60 * 60_000
const UNATTENDED = /unattended turn: no progress/
const NO_ANSWER = /no answer from .+ while ingesting/

type Engine = { root: string; chatAt: number | null; firstByteAt: number | null; checksInTheWait: number; dropped: boolean; close(): Promise<void> }
async function startEngine(script: { answersItsCheck: boolean; firstByteMs: number | null }): Promise<Engine> {
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
        if (script.answersItsCheck) return json(200, { status: 'ok' })
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
      const left = (): void => {
        if (engine.firstByteAt === null) engine.dropped = true
      }
      res.on('close', left)
      req.socket.on('close', left)
      if (script.firstByteMs === null) return
      const timer = setTimeout(() => {
        if (engine.dropped) return
        engine.firstByteAt = Date.now()
        answer(ANSWER)
      }, script.firstByteMs)
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
function run(name: string, engine: Engine, limitMinutes: string, sampledPace?: number): Promise<Run> {
  const runHome = join(scratch, `${name}-home`)
  const userHome = join(scratch, `${name}-user`)
  const cwd = join(scratch, `${name}-project`)
  mkdirSync(userHome, { recursive: true })
  seedScratchHome(runHome, cwd)
  if (sampledPace !== undefined) {
    const sampled = { paceTokensPerSec: sampledPace, samples: 3, updatedAtMs: Date.now() }
    writeFileSync(join(runHome, 'local-ingest-pace.json'), JSON.stringify({ version: 2, models: { [MODEL]: sampled, [`local/${MODEL}`]: sampled } }))
  }
  const env: NodeJS.ProcessEnv = { ...childEnv(runHome, 1), HOME: userHome, USERPROFILE: userHome, MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${engine.root}`, MERCURY_HEADLESS_IDLE_MINUTES: limitMinutes }
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

const outcomesOf = (result: Run): Row[] => result.rows.filter(row => row.type === 'outcome')
const said = (result: Run): string => JSON.stringify(outcomesOf(result))
const answered = (result: Run): boolean => result.exit === 0 && outcomesOf(result).length === 1 && outcomesOf(result)[0]?.status === 'completed' && outcomesOf(result)[0]?.answer === ANSWER
const cutShort = (result: Run): boolean => result.exit !== null && result.exit !== 0 && outcomesOf(result).length >= 1 && outcomesOf(result).every(row => row.status !== 'completed')
const promiseOf = (result: Run): number => Number(result.rows.find(row => row.type === 'wait' && row.promise === true)?.budget_ms ?? 0)
const waited = (engine: Engine): number => (engine.chatAt !== null && engine.firstByteAt !== null ? engine.firstByteAt - engine.chatAt : 0)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const CHECKED_LIMIT_MS = 90_000
const CHECKED_FIRST_BYTE_MS = 110_000
const PROMISED_LIMIT_MS = 30_000
const PROMISED_FIRST_BYTE_MS = 50_000
const SAMPLED_PACE = 60

const working = await startEngine({ answersItsCheck: true, firstByteMs: CHECKED_FIRST_BYTE_MS })
const dead = await startEngine({ answersItsCheck: false, firstByteMs: null })
const promising = await startEngine({ answersItsCheck: true, firstByteMs: PROMISED_FIRST_BYTE_MS })
const promisedDead = await startEngine({ answersItsCheck: false, firstByteMs: null })

const deadline = (await import('../../src/utils/deadline.ts')) as unknown as {
  armInactivityDeadline(opts: { seam: string; limitMs: number }): { touch(): void; cancel(): void; readonly fired: boolean; readonly expiry: Promise<never> }
  declaredWaitEnd?: (sinceMs: number, declaredMs: number, capMs: number) => number
  holdDeadlineUntil?: (held: { touch(): void }, untilMs: number, stepMs: number) => { cancel(): void }
}
const [alive, cut, promised, promisedCut] = await Promise.all([
  run('working', working, '1.5'),
  run('dead', dead, '1.5'),
  run('promised', promising, '0.5', SAMPLED_PACE),
  run('promised-dead', promisedDead, '0.5', SAMPLED_PACE),
])
for (const engine of [working, dead, promising, promisedDead]) await engine.close()

const held = deadline.armInactivityDeadline({ seam: 'a held wait', limitMs: 1_000 })
deadline.holdDeadlineUntil?.(held, Date.now() + 2_500, 250)
const ended = deadline.armInactivityDeadline({ seam: 'an ended hold', limitMs: 1_000 })
const endedHold = deadline.holdDeadlineUntil?.(ended, Date.now() + 60_000, 250)
await pause(300)
endedHold?.cancel()
await pause(1_900)
const clock = { insideThePromise: held.fired, afterTheHoldEnded: ended.fired, afterThePromise: false }
await pause(1_900)
clock.afterThePromise = held.fired
held.cancel()
ended.cancel()

tally.section('a local engine that takes a prompt in for longer than the turn\'s limit and answers its check')
tally.check('the engine held its first byte for longer than the turn\'s whole limit', waited(working) > CHECKED_LIMIT_MS, `${waited(working)}ms against a limit of ${CHECKED_LIMIT_MS}ms · dropped=${working.dropped}`)
tally.check('the transport asked the engine whether it lives during that wait, and was answered', working.checksInTheWait >= 1, String(working.checksInTheWait))
tally.check('the wait row carried the transport\'s own checked-alive stamp', alive.rows.some(row => row.type === 'wait' && typeof row.checked_ms === 'number'), JSON.stringify(alive.rows.filter(row => row.type === 'wait')).slice(0, 400))
tally.check('the turn ended in the engine\'s answer and the run exits clean', answered(alive), `exit=${alive.exit} ${said(alive).slice(0, 400)} ${alive.stderr.slice(-200)}`)
tally.check('no outcome names the unattended-turn deadline', !UNATTENDED.test(said(alive)), said(alive).slice(0, 400))

tally.section('the same wait on an engine that stops answering its check')
tally.check('the transport asked and was not answered', dead.checksInTheWait >= 1 && dead.firstByteAt === null, String(dead.checksInTheWait))
tally.check('the turn is cut: a failed outcome, no answer, a run that exits non-zero', cutShort(cut), `exit=${cut.exit} ${said(cut).slice(0, 400)}`)
tally.check('the cut names the engine that gave no answer, or the turn\'s own limit', NO_ANSWER.test(said(cut)) || UNATTENDED.test(said(cut)), said(cut).slice(0, 500))
tally.check('it came no later than the turn\'s limit after the last answer the engine gave', cut.wallMs < CHECKED_LIMIT_MS + 60_000, `${cut.wallMs}ms`)

tally.section(`a wait the transport has promised: a sampled pace of ${SAMPLED_PACE} tokens a second, a turn's limit of ${PROMISED_LIMIT_MS / 1000} s`)
const promise = promiseOf(promised)
console.log(`  the promise the transport stated for this prompt: ${Math.round(promise / 1000)} s`)
tally.check('the transport stated its promise on the wait row: the prompt over the sampled pace, longer than the turn\'s limit', promise > 60_000 && promise > PROMISED_LIMIT_MS && promise < 180_000, `${promise}ms`)
tally.check('the engine held its first byte past the turn\'s limit and inside the promise, so no check had stamped the wait', waited(promising) > PROMISED_LIMIT_MS && waited(promising) < promise && !promised.rows.some(row => row.type === 'wait' && typeof row.checked_ms === 'number'), `${waited(promising)}ms · dropped=${promising.dropped}`)
tally.check('the turn ended in the engine\'s answer and the run exits clean', answered(promised), `exit=${promised.exit} ${said(promised).slice(0, 400)} ${promised.stderr.slice(-200)}`)
tally.check('no outcome names the unattended-turn deadline', !UNATTENDED.test(said(promised)), said(promised).slice(0, 400))

tally.section('the same promise on an engine dead from the start of the wait')
const deadPromise = promiseOf(promisedCut)
tally.check('the turn is cut: a failed outcome, no answer, a run that exits non-zero', cutShort(promisedCut), `exit=${promisedCut.exit} ${said(promisedCut).slice(0, 400)}`)
tally.check('it is cut by the transport\'s own words, when the promise is due and its check goes unanswered', NO_ANSWER.test(said(promisedCut)) && !UNATTENDED.test(said(promisedCut)) && promisedDead.checksInTheWait >= 1, said(promisedCut).slice(0, 500))
tally.check('that is at the promise\'s end, not at the turn\'s limit before it and not at the cap', deadPromise > PROMISED_LIMIT_MS && promisedCut.wallMs >= deadPromise && promisedCut.wallMs < deadPromise + 60_000 && promisedCut.wallMs < CAP_MS, `${promisedCut.wallMs}ms for a promise of ${deadPromise}ms`)

tally.section('the hold of a promise')
tally.check('a promise larger than the transport\'s two-hour cap is held to the cap', deadline.declaredWaitEnd?.(1_000, 3 * 60 * 60_000, CAP_MS) === 1_000 + CAP_MS, String(deadline.declaredWaitEnd?.(1_000, 3 * 60 * 60_000, CAP_MS)))
tally.check('a promise under the cap is held to its own end', deadline.declaredWaitEnd?.(1_000, 90_000, CAP_MS) === 91_000, String(deadline.declaredWaitEnd?.(1_000, 90_000, CAP_MS)))
tally.check('a deadline held through a promise does not fire inside it, and runs its own limit from the promise\'s end', clock.insideThePromise === false && clock.afterThePromise === true, JSON.stringify(clock))
tally.check('a hold that is ended lets the deadline run again at once', clock.afterTheHoldEnded === true, JSON.stringify(clock))
rmSync(scratch, { recursive: true, force: true })
tally.finish()
