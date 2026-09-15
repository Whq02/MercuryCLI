#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  argAfter,
  bootRunner,
  bound,
  childEnv,
  isInit,
  isResult,
  j,
  makeTally,
  removeWorld,
  SCRATCH_ROOT,
  seedHome,
  user,
} from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-one-shot-open-deliverables')
const KEEP = argAfter('--keep')

export const FILE_ASK = 'file the parser task and end the turn'
export const TASK_SUBJECT = 'write the parser'
export const FILED_END = 'done: the parser task is filed'
export const CLOSED_END = 'done: the parser task is closed'
export const REPROMPT_WORDS = 'work the open deliverable'

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
export type Hit = { n: number; step: number; arm: string; reprompted: boolean; reprompts: number; tools: number; at: number }

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string)
}
function hasToolResult(item: Item): boolean {
  return item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(b => b.type === 'tool_result')
}
function toolResultTexts(items: Item[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (!hasToolResult(item)) continue
    for (const b of item.content as Block[]) {
      if (b.type !== 'tool_result') continue
      if (typeof b.content === 'string') out.push(b.content)
      else out.push(textParts(b.content).join('\n'))
    }
  }
  return out
}
function lastItemIsReprompt(items: Item[]): boolean {
  const last = items[items.length - 1]
  if (last === undefined || last.role !== 'user' || hasToolResult(last)) return false
  return textParts(last.content).join('\n').includes(REPROMPT_WORDS)
}
function repromptCount(items: Item[]): number {
  return items.filter(i => i.role === 'user' && !hasToolResult(i) && textParts(i.content).join('\n').includes(REPROMPT_WORDS)).length
}

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function openMessage(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_task_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use', index: number): string =>
  sse('content_block_stop', { type: 'content_block_stop', index }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) +
  sse('message_stop', { type: 'message_stop' })
function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(closeMessage('end_turn', 0))
}
function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  res.end(closeMessage('tool_use', 0))
}

export type TaskFixture = { port: number; hits: Hit[]; close: () => Promise<void> }

export async function startTaskFixture(): Promise<TaskFixture> {
  const hits: Hit[] = []
  let calls = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${url}` } }))
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
      }
      const n = ++calls
      const model = typeof body.model === 'string' ? body.model : 'fixture'
      const tools = Array.isArray(body.tools) ? body.tools.length : 0
      const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
      const firstUser = items.find(i => i.role === 'user' && !hasToolResult(i))
      const opening = textParts(firstUser?.content).filter(t => !t.trimStart().startsWith('<system-reminder>')).join('\n').trim()
      const step = items.filter(hasToolResult).length
      const reprompted = lastItemIsReprompt(items)
      const reprompts = repromptCount(items)
      const results = toolResultTexts(items)
      const filed = results.map(t => /Task #(\S+) created/.exec(t)?.[1]).find(id => id !== undefined)
      const arm =
        tools === 0 || opening !== FILE_ASK ? 'svc'
        : step === 0 ? 'create'
        : reprompted && step === 1 && filed !== undefined ? 'close'
        : step >= 2 ? 'closed-end'
        : 'filed-end'
      hits.push({ n, step, arm, reprompted, reprompts, tools, at: Date.now() })
      if (arm === 'svc') return answerText(res, n, model, 'svc')
      if (arm === 'create') return answerTool(res, n, model, `toolu_create_${n}`, 'TaskCreate', { subject: TASK_SUBJECT, description: 'the parser is the one deliverable of this ask' })
      if (arm === 'close') return answerTool(res, n, model, `toolu_close_${n}`, 'TaskUpdate', { taskId: filed, status: 'completed' })
      if (arm === 'closed-end') return answerText(res, n, model, CLOSED_END)
      return answerText(res, n, model, FILED_END)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

export type RunRecord = {
  runId?: string
  lifecycle?: string
  phase?: string
  phaseReason?: string
  deliverables?: Array<{ id?: string; title?: string; state?: string }>
  lastStopDecision?: { decision?: string; detail?: string } | null
  recentEvents?: Array<{ type?: string; decision?: string; detail?: string }>
}
export function runRecords(projectsDir: string): Array<{ file: string; run: RunRecord }> {
  const out: Array<{ file: string; run: RunRecord }> = []
  if (!existsSync(projectsDir)) return out
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.run.json')) {
        try {
          const parsed = JSON.parse(readFileSync(p, 'utf8')) as { snapshot?: RunRecord }
          out.push({ file: p, run: parsed.snapshot ?? (parsed as RunRecord) })
        } catch {
        }
      }
    }
  }
  walk(projectsDir)
  return out
}
const openOf = (run: RunRecord): Array<{ id?: string; title?: string; state?: string }> =>
  (run.deliverables ?? []).filter(d => d.state === 'open' || d.state === 'in-progress')
const brief = (run: RunRecord): string =>
  `${String(run.lifecycle)}/${String(run.phase)} deliverables=${j((run.deliverables ?? []).map(d => `${String(d.state)}:${String(d.title)}`))} stop=${String(run.lastStopDecision?.decision)}: ${String(run.lastStopDecision?.detail).slice(0, 160)}`

async function runWorld(label: string, extraEnv: Record<string, string>): Promise<{ record: RunRecord | null; records: number; hits: Hit[]; resultText: string; subtype: string; stderrTail: string; home: string }> {
  const home = join(SCRATCH_ROOT, `mercury-one-shot-${label}-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const fixture = await startTaskFixture()
  const runner = bootRunner({ cwd, env: { ...childEnv(home, fixture.port), MERCURY_TASKS: '1', ...extraEnv }, extraArgv: ['--allowed-tools', 'TaskCreate,TaskUpdate'] })
  runner.send(user(FILE_ASK, '00000000-0000-4000-8000-000000000000'))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const result = init === null ? null : await runner.waitFor('the turn result', isResult, bound(180_000))
  await runner.stop(bound(8_000))
  await fixture.close()
  const records = runRecords(join(home, 'projects'))
  const kept = records.find(r => (r.run.deliverables ?? []).length > 0) ?? records[0]
  const record = kept?.run ?? null
  if (KEEP !== undefined && kept !== undefined) {
    mkdirSync(KEEP, { recursive: true })
    copyFileSync(kept.file, join(KEEP, `record-${label}.run.json`))
  }
  return {
    record,
    records: records.length,
    hits: fixture.hits,
    resultText: String(result?.result ?? ''),
    subtype: String(result?.subtype ?? 'none'),
    stderrTail: runner.stderr().split('\n').slice(-8).join(' | '),
    home,
  }
}

if (import.meta.main) {
  section('§1 a print run that files a task and stops: the record never reads complete while the task is open')
  {
    const failedAtOpen = failed()
    const world = await runWorld('record', { MERCURY_SUPERVISOR: '0' })
    const arms = world.hits.map(h => h.arm)
    check('the runner booted and the turn settled on the model’s own last words', world.subtype === 'success' && world.resultText === FILED_END, `${world.subtype}: ${world.resultText.slice(0, 120)} | ${world.stderrTail}`)
    check('the fixture answered one TaskCreate and one end of turn, nothing more, and no re-prompt reached the wire', j(arms.filter(a => a !== 'svc')) === j(['create', 'filed-end']) && world.hits.every(h => h.reprompts === 0), j(world.hits))
    const run = world.record
    check('the run record holds the filed task as an open deliverable', run !== null && openOf(run).length === 1 && openOf(run)[0]!.title === TASK_SUBJECT, run ? brief(run) : `${world.records} record(s)`)
    check('the record does not read completed while a deliverable is open', run !== null && run.lifecycle !== 'completed' && run.phase !== 'done', run ? brief(run) : 'no record')
    check('the last stop decision is a continue that names the open deliverable count', run?.lastStopDecision?.decision === 'continue' && /1 deliverable\(s\) still open/.test(run.lastStopDecision.detail ?? ''), run ? brief(run) : 'no record')
    check('no stop decision on the record claims completion beside an unsatisfied count', run !== null && !(run.recentEvents ?? []).some(e => e.type === 'stop-decision' && e.decision === 'complete' && /UNSATISFIED/.test(e.detail ?? '')), run ? j((run.recentEvents ?? []).filter(e => e.type === 'stop-decision')) : 'no record')
    if (failed() === failedAtOpen) await removeWorld(world.home)
    else console.log(`  [forensics] the world stays at ${world.home}`)
  }

  section('§2 with the supervisor on, the print run is asked to work the open deliverable, closes it, and only then completes')
  {
    const failedAtOpen = failed()
    const world = await runWorld('supervised', { MERCURY_SUPERVISOR: '1' })
    const arms = world.hits.filter(h => h.arm !== 'svc').map(h => h.arm)
    check('the runner booted and the turn settled on the model’s own last words', world.subtype === 'success' && world.resultText === CLOSED_END, `${world.subtype}: ${world.resultText.slice(0, 120)} | ${world.stderrTail}`)
    check('a re-prompt on the wire named the open deliverable, once', world.hits.filter(h => h.reprompted).length === 1 && (world.hits[world.hits.length - 1]?.reprompts ?? 0) === 1, j(world.hits))
    check('the model closed the task on the re-prompt and ended', j(arms) === j(['create', 'filed-end', 'close', 'closed-end']), j(arms))
    const run = world.record
    check('the record reads completed with every deliverable closed', run?.lifecycle === 'completed' && (run.deliverables ?? []).length === 1 && openOf(run).length === 0, run ? brief(run) : 'no record')
    check('the completion names all deliverables closed, not an unsatisfied count', run?.lastStopDecision?.decision === 'complete' && /all 1 deliverable\(s\) closed/.test(run.lastStopDecision.detail ?? '') && !/UNSATISFIED/.test(run.lastStopDecision.detail ?? ''), run ? brief(run) : 'no record')
    if (failed() === failedAtOpen) await removeWorld(world.home)
    else console.log(`  [forensics] the world stays at ${world.home}`)
  }

  finish()
}
