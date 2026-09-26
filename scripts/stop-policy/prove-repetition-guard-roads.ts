#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
import {
  answerText,
  answerTool,
  REPEAT_NUDGE_PATTERN,
  REREAD_ASK,
  REREAD_END,
  REREAD_ROUNDS,
  startRereadFixture,
  userTextItems,
  type Hit,
} from './prove-no-stagnation-governor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { check, section, finish, failed } = makeTally('prove-repetition-guard-roads')

const BREAKER_NAMES =
  /identicalFailureGuard|repetition_breaker|error_repetition_breaker|IDENTICAL_FAILURES_TO|IDENTICAL_RESULTS_TO|IDENTICAL_RETRY_NUDGE|IDENTICAL_RESULT_NUDGE|takeRepetitionStop|repetitionStopNotice|consultRepetitionGuard|consultRoundRepetitionGuard|REPETITION_STOP_WORDS|repetition-stop|Stopped this turn/
const RELEASE_NOTES = ['src/constants/changelog.ts']
const THIS = 'scripts/stop-policy/prove-repetition-guard-roads.ts'

export const CYCLE_ASK = 'run the two checks over and over'
export const CYCLE_END = 'done: the two checks ran'
export const CYCLE_PAIRS = 12

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
    if (except.includes(rel) || rel === THIS) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${rel}:${index + 1}`)
    })
  }
  return hits
}
const src = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

type Item = { role?: string; content?: unknown }
type ResultBlock = { type?: string; content?: unknown; is_error?: boolean }
type CycleHit = { n: number; step: number; arm: string; tools: number; opening: string; answer: string; nudged: boolean; stopped: boolean }
type CycleFixture = { port: number; hits: CycleHit[]; close: () => Promise<void> }

const toolResultsOf = (item: Item): ResultBlock[] => (Array.isArray(item.content) ? (item.content as ResultBlock[]).filter(b => b.type === 'tool_result') : [])
function countToolResultItems(items: Item[]): number {
  return items.filter(item => toolResultsOf(item).length > 0).length
}
function lastAnswer(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const results = toolResultsOf(items[i]!)
    if (results.length === 0) continue
    const last = results[results.length - 1]!
    const body = typeof last.content === 'string' ? last.content : j(last.content)
    return `${last.is_error === true ? 'error:' : ''}${body.replace(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>\s*$/, '')}`
  }
  return ''
}

export async function startCycleFixture(cwd: string, pairs = CYCLE_PAIRS): Promise<CycleFixture> {
  const hits: CycleHit[] = []
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
      const opening = (userTextItems(items)[0] ?? '').trim()
      const step = countToolResultItems(items)
      const raw = JSON.stringify(body)
      const nudged = REPEAT_NUDGE_PATTERN.test(raw)
      const stopped = raw.includes('The loop guard ended the turn')
      const arm = tools === 0 || opening !== CYCLE_ASK ? 'svc' : step < pairs * 2 ? (step % 2 === 0 ? 'bash' : 'grep') : 'end'
      hits.push({ n, step, arm, tools, opening: opening.slice(0, 48), answer: lastAnswer(items), nudged, stopped })
      if (arm === 'svc') return answerText(res, n, model, 'svc')
      if (arm === 'bash') return answerTool(res, n, model, `toolu_bash_${n}`, 'Bash', { command: 'echo the first check', description: 'The first check', inherit_session_env: true })
      if (arm === 'grep') return answerTool(res, n, model, `toolu_grep_${n}`, 'Grep', { pattern: 'fixture', path: cwd, output_mode: 'content' })
      return answerText(res, n, model, CYCLE_END)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
function distinctAnswers(wire: CycleHit[]): { bash: string[]; grep: string[] } {
  const distinct = (parity: number): string[] => [...new Set(wire.filter(h => h.step > 0 && h.step % 2 === parity).map(h => h.answer))]
  return { bash: distinct(1), grep: distinct(0) }
}
const sameAnswers = (answers: { bash: string[]; grep: string[] }): boolean =>
  answers.bash.length === 1 && answers.grep.length === 1 && !answers.bash[0]!.startsWith('error:') && !answers.grep[0]!.startsWith('error:')

if (import.meta.main) {
  section('§1 the refusing repetition breaker is gone from the tree; what stands is a guard that reminds and, only by the key, ends')
  check('the old guard module is gone', !existsSync(join(REPO, 'src/services/tools/identicalFailureGuard.ts')))
  const named = offenders(join(REPO, 'src'), BREAKER_NAMES, RELEASE_NOTES)
  check('nothing under src names the breaker, its bounds, its nudges, its stop or its result subtype', named.length === 0, named.slice(0, 12).join(' · '))
  const orchestration = src('src/services/tools/toolOrchestration.ts')
  const closeAt = orchestration.indexOf('closeRound(')
  const lastRunAt = orchestration.lastIndexOf('runToolUse(')
  check('the tool orchestration refuses no call for repeating: it closes the loop guard\'s round only after every call of the response has run', !/refus/i.test(orchestration) && closeAt > -1 && lastRunAt > -1 && closeAt > lastRunAt, `close=${closeAt} lastRun=${lastRunAt}`)
  const execution = src('src/services/tools/toolExecution.ts')
  const observeAt = execution.indexOf('recordToolCall(')
  const settleAt = execution.indexOf('await body')
  check('the tool transaction records every settled call for the loop guard after the result, never before the call', observeAt > -1 && settleAt > -1 && observeAt > settleAt, `observe=${observeAt} settle=${settleAt}`)
  const guard = src('src/services/tools/loopGuard.ts')
  check('the guard ends a turn only behind the settings key, and only for a cycle longer than one call', guard.includes('loopGuardStopEnabled === true') && guard.includes('cycle.length > 1 && cycle.detection >= 2 && stopEnabled'))
  const schema = src('src/entrypoints/sdk/coreSchemas.ts')
  check('the SDK result schema carries no repetition-breaker subtype and does carry the loop-stopped one', !schema.includes('repetition') && schema.includes("'error_loop_stopped'"))
  const agent = src('src/tools/AgentTool/agentToolUtils.ts')
  check('a sub-agent outcome has no repetition-stop reason', !agent.includes('repetition'))
  const scriptsNamed = offenders(join(REPO, 'scripts'), BREAKER_NAMES)
  check('no proof pins the breaker', scriptsNamed.length === 0, scriptsNamed.slice(0, 12).join(' · '))
  const durability = src('docs/DURABILITY.md').replace(/\s+/g, ' ')
  check('the durability page says no call is refused for repeating, the guard reminds by default, and the key ends the second detection of one cycle', durability.includes('A repeated tool call is never refused, and by default no turn is ended for repeating itself: the loop guard only reminds') && durability.includes('With `loopGuardStopEnabled: true` in settings, the second detection of the same cycle of two to five calls ends the turn'))

  section('§2 DEFAULT ROAD on the built product: twenty identical reads of an unchanged file are reminded, never refused, and run to the model’s own end')
  {
    const home = join(SCRATCH_ROOT, `mercury-guard-default-${process.pid}`)
    const cwd = join(home, 'repo')
    seedHome(home, cwd)
    const notes = join(cwd, 'notes.md')
    const fixture = await startRereadFixture(notes, REREAD_ROUNDS, false)
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
    check('the file never changed: one line written, nothing appended', existsSync(notes) && readFileSync(notes, 'utf8') === 'line 0\n')
    check(`the model read the unchanged file ${REREAD_ROUNDS} times and every read ran`, arms('read').length === REREAD_ROUNDS && arms('write').length === 1, j(hits.map(h => [h.n, h.arm, h.step, h.refused])))
    check('no read was refused: every tool result the model saw was the file (or the unchanged-file answer), never an error', hits.filter(h => h.arm !== 'svc').every(h => !h.refused), j(hits.filter(h => h.refused).map(h => h.n)))
    const wire = hits.filter(h => h.arm !== 'svc')
    const firstNudged = wire.find(h => h.nudged)
    check('the first loop reminder rode the wire in the request after the third identical read (the write, then reads one to three), and not before', firstNudged !== undefined && firstNudged.step === 4 && wire.filter(h => h.step < 4).every(h => !h.nudged), j(wire.map(h => [h.n, h.step, h.nudged])))
    check('the turn ended only when the model ended it: the result is the model’s own last words, not a stop', result?.subtype === 'success' && resultText === REREAD_END, `${String(result?.subtype)}: ${resultText.slice(0, 160)}`)
    if (failed() === failedAtOpen) await removeWorld(home)
    else console.log(`  [forensics] the world stays at ${home}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)
  }

  section('§3 DEFAULT ROAD on the built product, the discriminating case: the same two-call cycle repeated twelve times is nudged at the fifth repeat and again at the tenth, and the turn ends only when the model ends it')
  {
    const home = join(SCRATCH_ROOT, `mercury-guard-default-cycle-${process.pid}`)
    const cwd = join(home, 'repo')
    seedHome(home, cwd)
    const fixture = await startCycleFixture(cwd)
    const failedAtOpen = failed()
    const runner = bootRunner({ cwd, env: childEnv(home, fixture.port), extraArgv: ['--allowed-tools', 'Bash,Grep'] })
    runner.send(user(CYCLE_ASK, '00000000-0000-4000-8000-000000000002'))
    const init = await runner.waitFor('the init frame', isInit, bound(90_000))
    const result = await runner.waitFor('the turn result', isResult, bound(240_000))
    await runner.stop(bound(8_000))
    await fixture.close()
    const hits = fixture.hits
    const arms = (arm: string): CycleHit[] => hits.filter(h => h.arm === arm)
    const wire = hits.filter(h => h.arm !== 'svc')
    const resultText = String(result?.result ?? '')
    check('the runner booted and the turn settled', init !== null && result !== null, runner.stderr().split('\n').slice(-6).join(' | '))
    check(`the model was answered ${CYCLE_PAIRS} Bash and ${CYCLE_PAIRS} Grep calls and then its own end`, arms('bash').length === CYCLE_PAIRS && arms('grep').length === CYCLE_PAIRS && arms('end').length === 1, j(hits.map(h => [h.n, h.arm, h.step, h.tools, h.opening])))
    const answers = distinctAnswers(wire)
    check('every Bash result and every Grep result the model saw was the same bytes, never an error: the cycle is identical from its first pair', sameAnswers(answers), j(answers))
    const firstNudged = wire.find(h => h.nudged)
    check('the loop reminder rode the wire after the fifth repeat of the pair (ten tool results), and not before', firstNudged !== undefined && firstNudged.step === 10 && wire.filter(h => h.step < 10).every(h => !h.nudged), j(wire.map(h => [h.n, h.step, h.nudged])))
    check('the turn ended only when the model ended it: the result is the model\u2019s own last words, not a stop', result?.subtype === 'success' && resultText === CYCLE_END, `${String(result?.subtype)}: ${resultText.slice(0, 160)}`)
    check('no request carried a stop note: the default road never ends a cycle', wire.every(h => !h.stopped), j(wire.filter(h => h.stopped).map(h => h.n)))
    if (failed() === failedAtOpen) await removeWorld(home)
    else console.log(`  [forensics] the world stays at ${home}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)
  }

  section('§4 KEY ROAD on the built product (loopGuardStopEnabled: true): a two-call cycle repeated ten times ends the turn with error_loop_stopped naming the cycle')
  {
    const home = join(SCRATCH_ROOT, `mercury-guard-key-${process.pid}`)
    const cwd = join(home, 'repo')
    seedHome(home, cwd)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ loopGuardStopEnabled: true }))
    const fixture = await startCycleFixture(cwd)
    const failedAtOpen = failed()
    const runner = bootRunner({ cwd, env: childEnv(home, fixture.port), extraArgv: ['--allowed-tools', 'Bash,Grep'] })
    runner.send(user(CYCLE_ASK, '00000000-0000-4000-8000-000000000001'))
    const init = await runner.waitFor('the init frame', isInit, bound(90_000))
    const result = await runner.waitFor('the turn result', isResult, bound(240_000))
    await runner.stop(bound(8_000))
    await fixture.close()
    const hits = fixture.hits
    const arms = (arm: string): CycleHit[] => hits.filter(h => h.arm === arm)
    const errors = Array.isArray(result?.errors) ? (result.errors as string[]) : []
    check('the runner booted and the turn settled', init !== null && result !== null, runner.stderr().split('\n').slice(-6).join(' | '))
    check('the model was answered ten Bash and ten Grep calls and never reached its own end: the fixture’s end arm was never asked', arms('bash').length === 10 && arms('grep').length === 10 && arms('end').length === 0, j(hits.map(h => [h.n, h.arm, h.step, h.tools, h.opening])))
    const wire = hits.filter(h => h.arm !== 'svc')
    const answers = distinctAnswers(wire)
    check('every Bash result and every Grep result the model saw was the same bytes, never an error: the cycle is identical from its first pair', sameAnswers(answers), j(answers))
    const firstNudged = wire.find(h => h.nudged)
    check('the loop reminder rode the wire after the fifth repeat of the pair (ten tool results), and not before', firstNudged !== undefined && firstNudged.step === 10 && wire.filter(h => h.step < 10).every(h => !h.nudged), j(wire.map(h => [h.n, h.step, h.nudged])))
    check('the turn ended typed: the result is error_loop_stopped, is_error, and its error names the cycle', result?.subtype === 'error_loop_stopped' && result?.is_error === true && /the same cycle of tool calls \(Bash -> Grep\)/.test(errors[0] ?? ''), `${String(result?.subtype)}: ${j(errors)}`)
    check('no request carried the stop note before the end (the note is the next turn’s context, not this one’s)', wire.every(h => !h.stopped), j(wire.filter(h => h.stopped).map(h => h.n)))
    if (failed() === failedAtOpen) await removeWorld(home)
    else console.log(`  [forensics] the world stays at ${home}\n${runner.stderr().split('\n').slice(-12).join('\n')}`)
  }

  finish()
}
