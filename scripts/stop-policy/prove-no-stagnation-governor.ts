#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootRunner,
  bound,
  childEnv,
  isInit,
  isResult,
  j,
  makeTally,
  removeWorld,
  REPO,
  SCRATCH_ROOT,
  seedHome,
  user,
} from '../daemon/dupline-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-no-stagnation-governor')

export const REREAD_ASK = 'reread the notes file twenty times'
export const REREAD_END = 'done: the notes file was read twenty times'
export const REREAD_ROUNDS = 20
export const HIDDEN_DIRECTIVE = 'Cycle re-plan'
const GOVERNOR_NAMES =
  /cycleLease|evaluateCycleLease|cycle_handoff|cycleReplanInjected|replan-required|handoff-required|STAGNANT_AFTER_BARREN|REPLAN_AFTER_BARREN|HANDOFF_AFTER_REPLANS|deriveProgressPhase|attemptsSinceProgress|repeatAttemptsSinceProgress|replansUsed|barrenRepeats|buildHandoffReport|renderHandoffReport|Cycle re-plan/
const RELEASE_NOTES = ['src/constants/changelog.ts']

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.(tsx?|md|txt|sh|json)$/.test(entry)) yield path
  }
}
function offenders(dir: string, pattern: RegExp, except: string[] = []): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(dir)) {
    const rel = file.slice(REPO.length + 1)
    if (except.includes(rel) || rel === 'scripts/stop-policy/prove-no-stagnation-governor.ts') continue
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${rel}:${index + 1}`)
    })
  }
  return hits
}
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

type Block = { type?: string; text?: string }
type Item = { role?: string; content?: unknown }
export type Hit = { n: number; step: number; arm: string; userTexts: number; directive: boolean; refused: boolean; nudged: boolean; at: number }
export const REPEAT_NUDGE_PATTERN = /Loop (check|notice)/

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text as string)
}
function hasToolResult(item: Item): boolean {
  return item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(b => b.type === 'tool_result')
}
function lastToolResultIsError(items: Item[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (!hasToolResult(item)) continue
    const results = (item.content as Array<Block & { is_error?: boolean }>).filter(b => b.type === 'tool_result')
    return results[results.length - 1]?.is_error === true
  }
  return false
}
export function userTextItems(items: Item[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.role !== 'user' || hasToolResult(item)) continue
    const texts = textParts(item.content).filter(t => !t.trimStart().startsWith('<system-reminder>'))
    if (texts.length > 0) out.push(texts.join('\n'))
  }
  return out
}

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
function openMessage(res: ServerResponse, n: number, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { type: 'message_start', message: { id: `msg_reread_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
}
const closeMessage = (stop: 'end_turn' | 'tool_use', index: number): string =>
  sse('content_block_stop', { type: 'content_block_stop', index }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }) +
  sse('message_stop', { type: 'message_stop' })
export function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  res.end(closeMessage('end_turn', 0))
}
export function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  openMessage(res, n, model)
  res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  res.end(closeMessage('tool_use', 0))
}

export type RereadFixture = { port: number; hits: Hit[]; close: () => Promise<void> }

export async function startRereadFixture(notesPath: string, rounds = REREAD_ROUNDS, grow = true): Promise<RereadFixture> {
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
      const texts = userTextItems(items)
      const opening = (texts[0] ?? '').trim()
      const step = items.filter(hasToolResult).length
      const raw = JSON.stringify(body)
      const directive = raw.includes(HIDDEN_DIRECTIVE)
      const refused = lastToolResultIsError(items)
      const nudged = REPEAT_NUDGE_PATTERN.test(raw)
      const arm = tools === 0 || opening !== REREAD_ASK ? 'svc' : step === 0 ? 'write' : step <= rounds ? 'read' : 'end'
      hits.push({ n, step, arm, userTexts: texts.length, directive, refused, nudged, at: Date.now() })
      if (arm === 'svc') return answerText(res, n, model, 'svc')
      if (arm === 'write') return answerTool(res, n, model, `toolu_write_${n}`, 'Write', { file_path: notesPath, content: 'line 0\n' })
      if (arm === 'read') {
        if (grow) appendFileSync(notesPath, `line ${step}\n`)
        return answerTool(res, n, model, `toolu_read_${n}`, 'Read', { file_path: notesPath })
      }
      return answerText(res, n, model, REREAD_END)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

type RunRecord = { lifecycle?: string; lastStopDecision?: { decision?: string; detail?: string } | null; recentEvents?: Array<{ type?: string; decision?: string; detail?: string }> }
function runRecords(projectsDir: string): Array<{ file: string; run: RunRecord }> {
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

if (import.meta.main) {
  section('§1 the governor is gone from the tree')
  check('the cycle-lease module is gone', !existsSync(join(REPO, 'src/services/run/cycleLease.ts')))
  const named = offenders(join(REPO, 'src'), GOVERNOR_NAMES, RELEASE_NOTES)
  check('nothing under src names the governor, its phases, its counters, its attachment or its hidden directive', named.length === 0, named.slice(0, 12).join(' · '))
  const evaluator = src('src/services/run/completionEvaluator.ts')
  check('the stop evaluator has no handoff decision and no re-plan directive', !evaluator.includes("kind: 'handoff'") && !evaluator.includes('REPLAN'))
  const adapter = src('src/utils/hooks/runStopAdapter.ts')
  check('the stop adapter records no handoff and no admission tuple', !adapter.includes("decision.kind === 'handoff'") && !adapter.includes('priorAdmission'))
  const turnMachine = src('src/run-core/turn-machine.ts')
  check('the turn machine consults no snapshot before the next provider call', !turnMachine.includes('getRunSnapshot(') && !turnMachine.includes('cycleDirectiveMessages'))
  const kernel = src('src/services/run/runKernel.ts')
  check('the run kernel keeps no attempt ledger', !kernel.includes("type: 'attempt'") && !kernel.includes('foldAttempt'))
  const scriptsNamed = offenders(join(REPO, 'scripts'), GOVERNOR_NAMES)
  check('no proof pins the governor', scriptsNamed.length === 0, scriptsNamed.slice(0, 12).join(' · '))
  const docsNamed = offenders(join(REPO, 'docs'), /stagnation governor|cycle lease|cycle_handoff|re-plan directive/i, ['docs/releases'])
  check('no product page describes it', docsNamed.filter(h => !h.startsWith('docs/releases/')).length === 0, docsNamed.join(' · '))
  const durability = src('docs/DURABILITY.md')
  check('the durability page says a repeated tool call is never refused and that by default the loop guard only reminds', durability.replace(/\s+/g, ' ').includes('A repeated tool call is never refused, and by default no turn is ended for repeating itself: the loop guard only reminds'))

  section('§2 on the built product, a turn that re-reads a changing file twenty times runs to the model’s own end')
  const home = join(SCRATCH_ROOT, `mercury-no-governor-${process.pid}`)
  const cwd = join(home, 'repo')
  seedHome(home, cwd)
  const notes = join(cwd, 'notes.md')
  const fixture = await startRereadFixture(notes)
  const failedAtOpen = failed()
  const runner = bootRunner({ cwd, env: childEnv(home, fixture.port), extraArgv: ['--allowed-tools', 'Write,Read'] })
  runner.send(user(REREAD_ASK, '00000000-0000-4000-8000-000000000000'))
  const init = await runner.waitFor('the init frame', isInit, bound(90_000))
  const result = await runner.waitFor('the turn result', isResult, bound(240_000))
  await runner.stop(bound(8_000))
  await fixture.close()
  const hits = fixture.hits
  const arms = (arm: string): Hit[] => hits.filter(h => h.arm === arm)
  const resultText = String(result?.result ?? '')
  check('the runner booted and the turn settled', init !== null && result !== null, runner.stderr().split('\n').slice(-6).join(' | '))
  check(`the model read the file ${REREAD_ROUNDS} times and was answered every time`, arms('read').length === REREAD_ROUNDS && arms('write').length === 1, j(hits.map(h => [h.n, h.arm, h.step])))
  check('every read saw a file the second writer had grown since the last read', existsSync(notes) && readFileSync(notes, 'utf8').split('\n').filter(l => l !== '').length === REREAD_ROUNDS + 1)
  check('the turn ended only when the model ended it: the result is the model’s own last words', result?.subtype === 'success' && resultText === REREAD_END, `${String(result?.subtype)}: ${resultText.slice(0, 160)}`)
  check('no request on the wire carried the hidden re-plan directive', hits.every(h => !h.directive), j(hits.filter(h => h.directive).map(h => h.n)))
  check('no loop reminder rode the wire: every read answered with a file that had grown, so no call repeated an earlier one with an identical result', hits.every(h => !h.nudged), j(hits.filter(h => h.nudged).map(h => [h.n, h.step])))
  const records = runRecords(join(home, 'projects'))
  const decisions = records.map(r => r.run.lastStopDecision?.decision ?? 'none')
  check('the run record holds no handoff stop decision', records.length > 0 && records.every(r => r.run.lastStopDecision?.decision !== 'handoff' && !(r.run.recentEvents ?? []).some(e => e.type === 'stop-decision' && e.decision === 'handoff')), `${records.length} record(s): ${j(decisions)} ${j(records.map(r => r.run.lastStopDecision?.detail?.slice(0, 120) ?? ''))}`)
  if (failed() === failedAtOpen) await removeWorld(home)
  else console.log(`  [forensics] the world stays at ${home}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)

  finish()
}
