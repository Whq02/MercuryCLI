#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'
import { resultRoomBudget, type ResultRoomFacts } from '../../src/services/run/resultRoom.ts'

const tally = makeTally('prove-small-window-fits-a-round')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'small-window-')))
console.log(`build under proof: ${DIST}`)

const MODEL = 'small-window-fixture-4b'
const ENGINE_CHARS_PER_TOKEN = 2.49
const ROOM_WORDS = 'the context is near its fold'
const LOOPING = 'Auto-compaction is looping'
const ANSWER = 'Soft rain taps the roof.'
const ASKED = 650
const NEXT = /Read\(offset: (\d+), limit: (\d+)\) continues from there/
const row = (file: string, n: number): string => `${file} row ${n}: the station keeps its notes tidy and its checks green all year round`
const SUMMARY = ['<summary>', '1. Operator Intent: read the notes and say five words about rain.', '2. Technical Ground: a folder of notes.', '3. Files and Code Touched: the notes were read.', '4. Errors and Corrections: none.', '5. Problems Worked: none.', '6. Operator Messages: the one ask.', '7. Open Work: the five words.', '8. Where Work Stands: the notes were read; the answer is owed.', '9. Next Move (optional): answer.', '10. Agents in flight: none.', '</summary>'].join('\n')

type Call = { name: string; args: Record<string, unknown> }
type Step = { reads: number; fresh: string[]; all: string[]; project: string }
type Plan = (step: Step) => Call[]
type Seen = { route: 'read' | 'answer' | 'summary' | 'side'; fresh: string[]; all: string[] }
type Run = { exit: number | null; rows: Array<Record<string, unknown>>; seen: Seen[]; stderr: string }
type Wire = { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] }

const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => String((part as { text?: unknown }).text ?? '')).join('') : '')
const linesOf = (text: string): number[] => [...text.matchAll(/^\s*(\d+)\t/gm)].map(match => Number(match[1]))
const nextOf = (text: string): { offset: number; limit: number } | null => {
  const match = NEXT.exec(text)
  return match === null ? null : { offset: Number(match[1]), limit: Number(match[2]) }
}
const fitted = (text: string): boolean => text.includes('exceeds the room left in the context (') && text.includes(`${ROOM_WORDS}; read in pieces`)
const read = (project: string, file: string, offset?: number, limit?: number): Call => ({ name: 'Read', args: { file_path: join(project, file), ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) } })

async function runLocal(name: string, window: number, plan: Plan, engineCharsPerToken = ENGINE_CHARS_PER_TOKEN): Promise<Run> {
  const project = join(scratch, `${name}-project`)
  const runHome = join(scratch, `${name}-home`)
  const userHome = join(scratch, `${name}-user`)
  mkdirSync(project, { recursive: true })
  mkdirSync(userHome, { recursive: true })
  writeFileSync(join(project, 'notes.txt'), Array.from({ length: 800 }, (_, i) => row('notes', i + 1)).join('\n') + '\n')
  writeFileSync(join(project, 'second.txt'), Array.from({ length: 400 }, (_, i) => row('second', i + 1)).join('\n') + '\n')
  writeFileSync(join(project, 'rows.txt'), Array.from({ length: 330 }, (_, i) => row('shell', i + 1)).join('\n') + '\n')
  writeFileSync(join(project, 'haystack.txt'), Array.from({ length: 170 }, (_, i) => row('needle', i + 1)).join('\n') + '\n')
  const seen: Seen[] = []
  let reads = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' })
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'llamacpp', meta: { n_ctx: window, n_ctx_train: 262144, n_params: 4_000_000_000, size: 2_600_000_000 } }] })
      if (req.method === 'GET' && path === '/props') return json(200, { default_generation_settings: { n_ctx: window }, total_slots: 1, modalities: { vision: false }, chat_template_caps: { supports_tools: true, supports_tool_calls: true } })
      if (req.method === 'GET' && path === '/slots') return json(200, [{ id: 0, n_ctx: window, is_processing: false }])
      if (req.method !== 'POST' || path !== '/v1/chat/completions') return json(404, { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } })
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as Wire
      const messages = body.messages ?? []
      const all = messages.filter(message => message.role === 'tool').map(message => textOf(message.content))
      const lastReply = messages.map(message => message.role).lastIndexOf('assistant')
      const fresh = lastReply < 0 ? [] : messages.slice(lastReply + 1).filter(message => message.role === 'tool').map(message => textOf(message.content))
      const lastAsk = textOf([...messages].reverse().find(message => message.role === 'user')?.content)
      const main = Array.isArray(body.tools) && body.tools.length > 0
      const calls = lastAsk.includes('Produce the summary now.') || !main ? [] : plan({ reads, fresh, all, project })
      const route: Seen['route'] = lastAsk.includes('Produce the summary now.') ? 'summary' : !main ? 'side' : calls.length > 0 ? 'read' : 'answer'
      if (route === 'read') reads++
      seen.push({ route, fresh, all })
      const base = { created: 1_794_000_000, id: `chatcmpl-small-${seen.length}`, model: MODEL, system_fingerprint: 'b12359-fixture', object: 'chat.completion.chunk' }
      const event = (value: Record<string, unknown>): void => void res.write(`data: ${JSON.stringify({ ...value, ...base })}\n\n`)
      const promptTokens = Math.ceil(raw.length / engineCharsPerToken)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      event({ choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }] })
      if (route === 'read') calls.forEach((call, index) => event({ choices: [{ finish_reason: null, index: 0, delta: { tool_calls: [{ index, id: `call_small_${seen.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }))
      else event({ choices: [{ finish_reason: null, index: 0, delta: { content: route === 'summary' ? SUMMARY : route === 'answer' ? ANSWER : 'side' } }] })
      event({ choices: [{ finish_reason: route === 'read' ? 'tool_calls' : 'stop', index: 0, delta: {} }] })
      event({ choices: [], usage: { completion_tokens: 60, prompt_tokens: promptTokens, total_tokens: promptTokens + 60, prompt_tokens_details: { cached_tokens: 0 } } })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  seedScratchHome(runHome, project)
  const env: NodeJS.ProcessEnv = { ...childEnv(runHome, 1), HOME: userHome, USERPROFILE: userHome, MERCURY_LOCAL_PROBE_TARGETS: `llamacpp=${root}` }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_BASE_URL
  const result = await new Promise<Run>(resolve => {
    const child = spawn(NODE, [DIST, 'run', 'Read the notes and reply with five words about rain.', '--format', 'rows', '--model', `local/${MODEL}`, '--sovereign', '--max-time', '3m'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const rows: Array<Record<string, unknown>> = []
    let out = ''
    let stderr = ''
    const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const lines = out.split('\n')
      out = lines.pop() ?? ''
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line) as Record<string, unknown>)
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
      resolve({ exit, rows, seen, stderr })
    })
  })
  await new Promise<void>(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
  return result
}

const routesOf = (run: Run): string => run.seen.filter(entry => entry.route !== 'side').map(entry => entry.route).join(' ')
const foldsOf = (run: Run): number => run.rows.filter(entry => entry.type === 'compaction' && entry.state === 'ended').length
const loopingSaid = (run: Run): boolean => run.rows.some(entry => entry.type === 'notice' && String(entry.text ?? '').includes(LOOPING))
const answered = (run: Run): boolean => run.exit === 0 && run.rows.some(entry => entry.type === 'outcome' && entry.status === 'completed' && entry.answer === ANSWER)
const answerOf = (run: Run): Seen | undefined => run.seen.find(entry => entry.route === 'answer')
const shape = (run: Run): string => `exit=${run.exit} · ${routesOf(run)} · folds ${foldsOf(run)} · ${run.seen.filter(entry => entry.route !== 'side').map(entry => entry.fresh.map(text => `${text.length}c ${linesOf(text)[0] ?? '-'}..${linesOf(text).at(-1) ?? '-'}${fitted(text) ? ' fitted' : ''}`).join(' | ')).join(' ; ')} ${run.stderr.slice(-200)}`
const untilHeld: Plan = step => (step.fresh.length > 0 ? [] : [read(step.project, 'notes.txt', 1, ASKED)])

tally.section('the room of a window that holds no whole result under its fold line')
const facts: ResultRoomFacts = { window: 32_768, blockingLimit: 21_576, foldLine: 17_480, gauge: 6_540 }
const marked = resultRoomBudget({ ...facts, small: true } as ResultRoomFacts)
tally.check('under the line the room is the line less what the context reads, less a result\'s wrapper: 10,690 of 17,480 at 6,540', marked.awake === true && marked.room === 10_690 && marked.floor === 2_697, JSON.stringify(marked))
tally.check('a first result takes that room less one floor, kept for a second result of the round: 7,993', marked.awake === true && marked.ceiling === 7_993, JSON.stringify(marked))
const dense = resultRoomBudget({ ...facts, small: true, density: 1.25 } as ResultRoomFacts)
tally.check('a density the request gauge has measured above one shrinks the room by it: 8,502', dense.awake === true && dense.room === 8_502, JSON.stringify(dense))
tally.check('a window without that mark sleeps under its line, as before', resultRoomBudget(facts).awake === false && resultRoomBudget({ ...facts, small: false } as ResultRoomFacts).awake === false)
const past = resultRoomBudget({ ...facts, gauge: 19_812, small: true } as ResultRoomFacts)
tally.check('past the line the room is the one to the blocking limit with or without the mark: 1,764, a ceiling of one floor', past.awake === true && past.room === 1_764 && past.ceiling === 2_697 && JSON.stringify(past) === JSON.stringify(resultRoomBudget({ ...facts, gauge: 19_812 })), JSON.stringify(past))

tally.section('at 32,768 a model that reads a file larger than the room under the fold line, and reads it again whenever it holds no result')
const one = await runLocal('one', 32_768, untilHeld)
const part = answerOf(one)?.fresh[0] ?? ''
const partLines = linesOf(part)
tally.check('the engine was asked twice, for the read and for the answer, and never for a summary', routesOf(one) === 'read answer', shape(one))
tally.check('no fold ran and the looping notice was not said', foldsOf(one) === 0 && !loopingSaid(one), shape(one))
tally.check('the Read gave the part that fits, from line 1, with the note it already writes for the room', fitted(part) && partLines[0] === 1 && (partLines.at(-1) ?? 0) < ASKED && partLines.length === (partLines.at(-1) ?? 0), part.slice(0, 260))
tally.check('the note names the next offset, the line after the last one given', nextOf(part)?.offset === (partLines.at(-1) ?? 0) + 1, part.slice(0, 260))
tally.check('the turn ended in the answer and the run exits clean', answered(one), shape(one))

tally.section('a second Read at the offset the note names')
const two = await runLocal('next', 32_768, step => {
  if (step.reads === 0) return [read(step.project, 'notes.txt', 1, ASKED)]
  const named = nextOf(step.fresh[0] ?? '')
  return step.reads === 1 && named !== null ? [read(step.project, 'notes.txt', named.offset, named.limit)] : []
})
const firstPart = two.seen.find(entry => entry.fresh.length === 1 && linesOf(entry.fresh[0] as string)[0] === 1)?.fresh[0] ?? ''
const secondPart = two.seen.flatMap(entry => entry.all).find(text => (linesOf(text)[0] ?? 0) > 1) ?? ''
tally.check('it brings the next part: its first line is the line the note named', linesOf(secondPart).length > 0 && linesOf(secondPart)[0] === (linesOf(firstPart).at(-1) ?? 0) + 1 && nextOf(firstPart)?.offset === linesOf(secondPart)[0], `${linesOf(firstPart).at(-1)} then ${linesOf(secondPart)[0]}..${linesOf(secondPart).at(-1)}`)
tally.check('the run ends in the answer with no more than one fold and no looping notice', answered(two) && foldsOf(two) <= 1 && !loopingSaid(two), shape(two))

tally.section('a round of two reads')
const pair = await runLocal('pair', 32_768, step => (step.reads === 0 ? [read(step.project, 'notes.txt', 1, ASKED), read(step.project, 'second.txt')] : []))
const pairResults = answerOf(pair)?.fresh ?? []
tally.check('both came back fitted, each from its line 1 with the room\'s words and its own next offset', pairResults.length === 2 && pairResults.every(text => fitted(text) && linesOf(text)[0] === 1 && nextOf(text)?.offset === (linesOf(text).at(-1) ?? 0) + 1), shape(pair))
const pairLines = pairResults.map(text => linesOf(text).length).sort((a, b) => a - b)
tally.check('the read that came first took the room less one floor and the other the floor kept for it', pairLines.length === 2 && (pairLines[0] as number) > 0 && (pairLines[1] as number) > 2 * (pairLines[0] as number), shape(pair))
tally.check('no fold: one request after the round, the answer', routesOf(pair) === 'read answer' && foldsOf(pair) === 0 && answered(pair), shape(pair))

tally.section('a round with a long shell output, then a round with a long search, after a read took its share')
const rounds = await runLocal('rounds', 32_768, step => {
  if (step.reads === 0) return [read(step.project, 'notes.txt', 1, ASKED)]
  if (step.reads === 1) return [{ name: 'Bash', args: { command: 'cat rows.txt', description: 'print the rows' } }]
  if (step.reads === 2) return [{ name: 'Grep', args: { pattern: 'needle row', path: join(step.project, 'haystack.txt'), output_mode: 'content' } }]
  return []
}, 4)
const roundResults = answerOf(rounds)?.all ?? []
const saved = (text: string | undefined): boolean => text !== undefined && text.startsWith('<persisted-output>') && text.includes(`(${ROOM_WORDS})`)
tally.check('the read was fitted with its note', roundResults.length === 3 && fitted(roundResults[0] as string), shape(rounds))
tally.check('the shell output, under its own cap and over its share, was saved whole to a file and carried as a preview with the room\'s words', saved(roundResults[1]) && (roundResults[1] as string).includes('shell row 1:'), String(roundResults[1]).slice(0, 200))
tally.check('the search, under its own cap and over its share, was carried the same way', saved(roundResults[2]) && (roundResults[2] as string).includes('needle row 1:'), String(roundResults[2]).slice(0, 200))
tally.check('no fold in the three rounds, then the answer', routesOf(rounds) === 'read read read answer' && foldsOf(rounds) === 0 && answered(rounds), shape(rounds))

tally.section('a window that holds one whole result under its fold line reads as it did')
for (const window of [65_536, 131_072]) {
  const wide = await runLocal(`wide-${window}`, window, untilHeld)
  const whole = answerOf(wide)?.fresh[0] ?? ''
  tally.check(`a local window of ${window.toLocaleString('en-US')}: the Read lands whole, lines 1 to ${ASKED}, with no word of the room, two requests, no fold`, routesOf(wide) === 'read answer' && foldsOf(wide) === 0 && answered(wide) && linesOf(whole)[0] === 1 && linesOf(whole).at(-1) === ASKED && !whole.includes(ROOM_WORDS), shape(wide))
}
const longer: Plan = step => (step.reads === 0 ? [read(step.project, 'notes.txt', 1, 800)] : [])
const under = await runLocal('edge-under', 44_797, longer)
const over = await runLocal('edge-over', 44_798, longer)
tally.check('the edge is the window whose own fold line reaches one result\'s cap: at 44,797 a read larger than the room is fitted', fitted(answerOf(under)?.fresh[0] ?? '') && foldsOf(under) === 0 && answered(under), shape(under))
tally.check('…and at 44,798, one token wider, the same read lands whole with no word of the room', linesOf(answerOf(over)?.fresh[0] ?? '').at(-1) === 800 && !(answerOf(over)?.fresh[0] ?? '').includes(ROOM_WORDS) && answered(over), shape(over))

tally.section('the hosted windows')
for (const [label, extraEnv] of [['200,000', { MERCURY_DISABLE_1M_CONTEXT: '1' }], ['1,000,000', {}]] as Array<[string, Record<string, string>]>) {
  const project = join(scratch, `hosted-${label.length}-project`)
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'notes.txt'), Array.from({ length: 800 }, (_, i) => row('notes', i + 1)).join('\n') + '\n')
  let landed = ''
  let asks = 0
  const fixture = await startScriptedFixture(req => {
    if (req.toolNames.length === 0) return [{ type: 'text', text: 'side' }]
    asks++
    if (req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: join(project, 'notes.txt'), offset: 1, limit: ASKED } }]
    landed = req.results[0]?.text ?? ''
    return [{ type: 'text', text: ANSWER }]
  })
  const userHome = join(scratch, `hosted-${label.length}-user`)
  mkdirSync(userHome, { recursive: true })
  const turn = await runScriptedTurn({ runHome: join(scratch, `hosted-${label.length}-home`), cwd: project, base: fixture.base, ask: 'Read the notes and reply with five words about rain.', timeoutMs: 120_000, extraEnv: { HOME: userHome, USERPROFILE: userHome, ...extraEnv } })
  await fixture.close()
  tally.check(`a hosted window of ${label}: the Read lands whole, lines 1 to ${ASKED}, with no word of the room, two requests, the answer`, turn.exitCode === 0 && asks === 2 && linesOf(landed)[0] === 1 && linesOf(landed).at(-1) === ASKED && !landed.includes(ROOM_WORDS) && String((turn.result as { answer?: unknown } | null)?.answer ?? '') === ANSWER, `exit ${turn.exitCode} · ${asks} asks · ${landed.length}c ${linesOf(landed)[0]}..${linesOf(landed).at(-1)} · ${turn.stderr.slice(-200)}`)
}
rmSync(scratch, { recursive: true, force: true })
tally.finish()
