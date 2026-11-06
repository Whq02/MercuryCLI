#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { findRows, firstOutputTs, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { MISSION_MET_SENTINEL } from '../../src/guards/mission.ts'
import { compileGoal } from '../../src/services/mission/goal.ts'
import { MISSION_JUDGE_MARK } from '../../src/services/mission/goalJudge.ts'
import { missionSection, missionSectionKey } from '../../src/services/mission/served.ts'
import { getMissionStatusAttachment } from '../../src/utils/attachments/missionStatus.ts'

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = argument('--dist')
const OUT = argument('--out')
const GOAL = 'the file hello.txt exists in the cwd and contains the word hello; without touching any other file'
const COMPILED = compileGoal(GOAL)
const CRITERIA = [COMPILED.endState, ...COMPILED.constraints]
const WORKING = 'Working on it.'
const QUESTION = 'Which directory should hold hello.txt?'
const CLOSE = `1. ${COMPILED.endState} — wrote hello.txt; cat shows hello\n2. ${COMPILED.constraints[0]} — only hello.txt changed\n${MISSION_MET_SENTINEL}`
const BARE_CLAIM = `all done.\n${MISSION_MET_SENTINEL}`
const JUDGE_NOT_YET_REASON = 'hello.txt is not there yet'
const JUDGE_MET_REASON = 'hello.txt holds the word hello and nothing else changed'
const JUDGE_UNREADABLE_REASON = 'the judge gave no readable verdict'
const JUDGE_UNREACHABLE_REASON = 'the judge could not be reached'
const MALFORMED_JUDGE_ANSWER = 'Looks done to me. {"verdict":"met"}'
const SEAT_EFFORT = 'max'
const HOLD_HEAD = `Mission not completed: ${GOAL} — `
const ASK_WORDS = 'one question to the operator'
const STATUS_HEAD = 'Mission status —'
const SECTION_HEADING = '# Mission'
const PAUSE_NOTE = 'mission paused'
const IDLE_NOTE = 'mission paused after 3 turns without a tool call — your next message resumes it'
const COMPLETED_HEAD = 'Mission completed:'
const BARE_CLAIM_REASON = 'no criterion lines'
const INDICATOR_WORDS = ['/mission active', '/mission paused']
const ENDED_STATES = new Set(['needs-operator', 'stood-down'])
const MISSION_VOCABULARY = ['GOAL-MET', STATUS_HEAD, 'Mission not completed', SECTION_HEADING, PAUSE_NOTE, '/mission clear', MISSION_JUDGE_MARK, 'hello.txt', 'without touching any other file']
const REMINDER_BLOCK = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
const CARD_SAMPLE_MS = 150
const IDLE_TURNS = 3
const WORKING_PLAN = [true, false, true, false, false, true]
const WORKING_ENDS = WORKING_PLAN.length
const WORKING_READS = WORKING_PLAN.filter(Boolean).length
const CLOSES = 2
const JUDGED_ENDS = IDLE_TURNS + 1 + WORKING_ENDS + CLOSES

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

type Card = { sessionId: string; goal: string; state: string; iterations: number; nextStep: string | null; setAt: string; updatedAt: string; outcome?: { reason: string; metAt: string; turns: number } }
type CardSample = { atMs: number; sessionId: string; state: string; iterations: number; nextStep: string | null }
type Screen = { atMs: number; rows: string[] }
type Row = { type?: string; isMeta?: boolean; subtype?: string; level?: string; timestamp?: string; content?: unknown; origin?: { kind?: string; command?: string }; message?: { role?: string; content?: unknown }; attachment?: { type?: string; text?: string; checks?: number; state?: string } }
type Request = { body: unknown }
type Transcript = { sessionId: string; rows: Row[] }

function walk(dir: string, out: string[] = []): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const p = join(dir, name)
    let directory: boolean
    try {
      directory = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (directory) walk(p, out)
    else out.push(p)
  }
  return out
}

function cardsUnder(configDir: string): Card[] {
  return walk(join(configDir, 'projects'))
    .filter(p => p.includes(`${join('missions', '')}`) && p.endsWith('.json'))
    .flatMap(p => {
      try {
        return [JSON.parse(readFileSync(p, 'utf8')) as Card]
      } catch {
        return []
      }
    })
}

function watchCards(sinceMs: number): { stop: () => CardSample[] } {
  const samples: CardSample[] = []
  const last = new Map<string, string>()
  const timer = setInterval(() => {
    let homes: string[] = []
    try {
      homes = readdirSync(tmpdir()).filter(name => name.startsWith('flux-arena-home-')).map(name => join(tmpdir(), name)).filter(dir => {
        try {
          return statSync(dir).mtimeMs >= sinceMs - 1000
        } catch {
          return false
        }
      })
    } catch {
      homes = []
    }
    for (const home of homes) {
      for (const card of cardsUnder(join(home, '.mercury'))) {
        const key = JSON.stringify([card.state, card.iterations, card.nextStep])
        if (last.get(card.sessionId) === key) continue
        last.set(card.sessionId, key)
        samples.push({ atMs: Date.now(), sessionId: card.sessionId, state: card.state, iterations: card.iterations, nextStep: card.nextStep })
      }
    }
  }, CARD_SAMPLE_MS)
  return {
    stop: () => {
      clearInterval(timer)
      return samples
    },
  }
}

async function transcriptsUnder(configDir: string): Promise<Transcript[]> {
  const paths = walk(join(configDir, 'projects')).filter(p => p.endsWith('.jsonl') && !p.includes('receipts') && !p.includes('subagents'))
  const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
  const out: Transcript[] = []
  for (const path of paths) {
    const chain = await reader.readTranscriptChainSince(path, null)
    out.push({ sessionId: basename(path, '.jsonl'), rows: chain.rows as unknown as Row[] })
  }
  return out
}

function textOf(row: Row): string {
  const content = row.message?.content ?? row.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}
const stampOf = (row: Row): number => Date.parse(row.timestamp ?? '')
const hasToolUse = (row: Row): boolean => row.type === 'assistant' && Array.isArray(row.message?.content) && (row.message!.content as Array<{ type?: string }>).some(block => block.type === 'tool_use')

function systemText(body: unknown): string {
  const s = (body as { system?: unknown }).system
  if (typeof s === 'string') return s
  if (Array.isArray(s)) return s.map(b => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
  return ''
}
function messagesOf(body: unknown): Array<{ role: string; content: unknown }> {
  return (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
}
function flat(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map(b => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n')
}
function userTexts(body: unknown): string[] {
  return messagesOf(body).filter(m => m.role === 'user').map(m => flat(m.content))
}
function lastUserText(body: unknown): string {
  const texts = userTexts(body)
  return texts[texts.length - 1] ?? ''
}
function reminderBlocks(text: string): string[] {
  return [...text.matchAll(REMINDER_BLOCK)].map(m => (m[1] ?? '').trim())
}
function operatorWords(text: string): string {
  return text.replace(REMINDER_BLOCK, '').trim()
}
function statusOf(text: string): { checks: number; verdict: string; state: string; line: string } | null {
  const block = reminderBlocks(text).find(b => b.startsWith(STATUS_HEAD))
  if (block === undefined) return null
  const count = /checks (\d+)/.exec(block)
  const verdict = /· last verdict (none yet|[a-z ]+ \(.+\)) ·/.exec(block)
  const state = /· (armed|paused)(?:\s|$|—)/.exec(block)
  return { checks: count === null ? -1 : Number(count[1]), verdict: verdict?.[1] ?? '?', state: state?.[1] ?? '?', line: block }
}
function goalServed(system: string): boolean {
  return system.includes(SECTION_HEADING) && system.includes(`Goal: ${COMPILED.endState}`) && CRITERIA.every((criterion, i) => system.includes(`${i + 1}. ${criterion}`))
}
const isJudge = (r: Request): boolean => systemText(r.body).includes(MISSION_JUDGE_MARK)
const continuesIn = (r: Request): number => userTexts(r.body).filter(t => operatorWords(t) === 'continue').length
const modelOf = (r: Request): string => String((r.body as { model?: unknown }).model ?? '')
const effortOf = (r: Request): string | undefined => (r.body as { output_config?: { effort?: string } }).output_config?.effort
const thinkingOff = (r: Request): boolean => {
  const thinking = (r.body as { thinking?: { type?: string } }).thinking
  return thinking === undefined || thinking.type === 'disabled'
}

const sendEpochs = (run: ArenaRun, prefix: string): number[] => run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith(prefix)).map(s => s.sent)
const sendsOf = (run: ArenaRun): string[] => run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('utf8').replace(/\r/g, '⏎'))
const complete = (run: ArenaRun, expectedSends: number): boolean => run.outcome.complete && (run.outcome.report?.unfired.length ?? 1) === 0 && run.sendLog.length === expectedSends
const runWords = (run: ArenaRun): string => `complete=${run.outcome.complete} exit=${run.outcome.exitCode} sends=${JSON.stringify(sendsOf(run).map(s => s.slice(0, 24)))} unfired=${JSON.stringify(run.outcome.report?.unfired ?? [])} ${run.outcome.reason ?? ''}`

function screensAt(run: ArenaRun, cols: number, rows: number, offsets: number[]): Screen[] {
  const asked = offsets.map(o => (o < 0 ? -1 : Math.max(0, Math.round(o))))
  const res = spawnSync(
    '/usr/bin/python3',
    [join(import.meta.dir, '..', 'streaming', 'screengrab.py'), run.paths.drive, String(cols), String(rows), ...asked.map(String)],
    { encoding: 'utf8', timeout: vshotBudgetMs(60_000), maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`screengrab failed: ${res.stderr}`)
  const screens = (JSON.parse(res.stdout) as { screens: Screen[] }).screens
  return asked.map(o => {
    const found = screens.find(sc => sc.atMs === o)
    if (found === undefined) throw new Error(`no screen at ${o}`)
    return found
  })
}

const judgeTurn = (verdict: 'met' | 'not yet' | 'impossible', reason: string): ScriptedTurn => ({ kind: 'text', text: JSON.stringify({ verdict, reason }), whenBody: MISSION_JUDGE_MARK })
const judgeRaw = (words: string): ScriptedTurn => ({ kind: 'text', text: words, whenBody: MISSION_JUDGE_MARK })
const judgeDown = (): ScriptedTurn => ({ kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'the judge fixture refuses this call', whenBody: MISSION_JUDGE_MARK })
const text = (words: string): ScriptedTurn => ({ kind: 'text', text: words })
const readTool = (cwd: string): ScriptedTurn => ({ kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'hello.txt') } })

const arena = (turns: ScriptedTurn[] | ((cwd: string) => ScriptedTurn[]), sends: Array<Record<string, unknown>>, seconds: number): Promise<ArenaRun> =>
  runArtifactArena({
    turns,
    sends: sends as never,
    seconds,
    cols: 120,
    rows: 40,
    keep: true,
    seedCwd: { 'hello.txt': 'hello\n' },
    seedHome: configDir => {
      writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify({ engine: { effort: SEAT_EFFORT } }, null, 2)}\n`)
    },
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })

const missionTurns = (cwd: string): ScriptedTurn[] => [
  judgeTurn('not yet', JUDGE_NOT_YET_REASON),
  judgeRaw(MALFORMED_JUDGE_ANSWER),
  ...Array.from({ length: IDLE_TURNS - 2 + 1 + WORKING_ENDS }, () => judgeTurn('not yet', JUDGE_NOT_YET_REASON)),
  judgeDown(),
  judgeTurn('met', JUDGE_MET_REASON),
  ...Array.from({ length: 6 }, () => judgeTurn('not yet', JUDGE_NOT_YET_REASON)),
  ...Array.from({ length: IDLE_TURNS }, () => text(WORKING)),
  text(QUESTION),
  ...WORKING_PLAN.map(reads => (reads ? [readTool(cwd), text(WORKING)] : [text(WORKING)])).flat(),
  ...Array.from({ length: CLOSES }, () => text(CLOSE)),
  ...Array.from({ length: 6 }, () => text(WORKING)),
]
const missionSends = [
  { awaitText: 'Type a prompt', settleMs: 1200, text: `/mission ${GOAL}\r` },
  { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
  { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
]
const bareTurns: ScriptedTurn[] = [...Array.from({ length: 6 }, () => judgeTurn('met', 'the claim says done')), text(BARE_CLAIM), ...Array.from({ length: 6 }, () => text(WORKING))]
const bareSends = [{ awaitText: 'Type a prompt', settleMs: 1200, text: `/mission ${GOAL}\r` }]
const plainSends = [{ awaitText: 'Type a prompt', settleMs: 1200, text: 'hello\r' }]

console.log('============================================================')
console.log(' /mission typed on the screen: the goal is served every turn, a bare continue included; the judge reads every turn end')
console.log('============================================================')
console.log(`build under proof: ${DIST !== undefined ? resolve(DIST) : 'this tree'}`)
console.log(`goal: ${GOAL}\ncriteria: ${JSON.stringify(CRITERIA)}`)

const watch = watchCards(Date.now())
const run = await arena(missionTurns, missionSends, 40)
const cardTimeline = watch.stop()
const configDir = join(run.paths.home, '.mercury')
const continueEpochs = sendEpochs(run, 'continue')
check('the capture ran to its end: complete, every step fired, three sends (/mission, continue, continue)', complete(run, 3) && continueEpochs.length === 2, runWords(run))
if (sendEpochs(run, '/mission the file').length === 0) {
  console.log(`\nmission served: RED (${failures}/${checks}) — the command never fired`)
  process.exit(1)
}
const firstContinueOffset = continueEpochs[0] === undefined ? -1 : Math.max(0, continueEpochs[0] - firstOutputTs(run) - 300)
const [atEnd, whilePaused] = screensAt(run, 120, 40, [-1, firstContinueOffset])
const allRequests: Request[] = run.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const requests = allRequests.filter(r => !isJudge(r))
const judgeRequests = allRequests.filter(isJudge)
const transcripts = await transcriptsUnder(configDir)
const hosted = transcripts.find(t => t.rows.some(r => r.type === 'user' && r.isMeta === true && textOf(r).includes('A standing goal is now active')))
const rows = hosted?.rows ?? []
const cards = cardsUnder(configDir)
const card = hosted === undefined ? undefined : cards.find(c => c.sessionId === hosted.sessionId)
const timeline = hosted === undefined ? [] : cardTimeline.filter(s => s.sessionId === hosted.sessionId)
const assistantRows = rows.filter(r => r.type === 'assistant')
const holdRows = rows.filter(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
const askHolds = holdRows.filter(r => textOf(r).includes(ASK_WORDS))
const pauseNotes = rows.filter(r => r.type === 'system' && textOf(r).includes(PAUSE_NOTE))
const completedRows = rows.filter(r => r.type === 'user' && r.origin?.kind === 'task-notification' && textOf(r).includes(COMPLETED_HEAD))
const firstContinueEpoch = continueEpochs[0] ?? Number.POSITIVE_INFINITY
const secondContinueEpoch = continueEpochs[1] ?? Number.POSITIVE_INFINITY
console.log(`  hosted=${hosted?.sessionId.slice(0, 8) ?? 'none'} requests=${requests.length} judge=${judgeRequests.length} holds=${holdRows.length} (asks ${askHolds.length}) pauseNotes=${pauseNotes.length} completedRows=${completedRows.length} assistantRows=${assistantRows.length} card=${JSON.stringify(card === undefined ? null : { state: card.state, iterations: card.iterations, nextStep: (card.nextStep ?? '').slice(0, 80), outcome: card.outcome })}`)
console.log(`  card timeline: ${timeline.map(s => `${s.state}@${s.iterations}`).join(' → ') || '(no samples)'}`)
for (const [i, r] of requests.entries()) {
  const status = statusOf(lastUserText(r.body))
  console.log(`    #${i + 1} goalServed=${goalServed(systemText(r.body))} continues=${continuesIn(r)} status=${status === null ? 'none' : `${status.checks}/${status.verdict.slice(0, 24)}/${status.state}`} last=${JSON.stringify(operatorWords(lastUserText(r.body)).slice(0, 80))}`)
}

const first = requests[0]
const firstReply = assistantRows[0]
check("the arming send alone produces a model request: the first request's operator words are the directive, and its reply was recorded before the first continue was typed", first !== undefined && operatorWords(lastUserText(first.body)).includes('A standing goal is now active') && continuesIn(first) === 0 && firstReply !== undefined && stampOf(firstReply) < firstContinueEpoch, `first=${first === undefined ? 'none' : operatorWords(lastUserText(first.body)).slice(0, 80)} reply=${firstReply?.timestamp ?? 'none'} continue=${new Date(firstContinueEpoch).toISOString()}`)
check('every armed request, the first included, carries the compiled goal in the system prompt: the Mission section, the end state and each criterion', requests.length >= 3 && requests.every(r => goalServed(systemText(r.body))), requests.map((r, i) => `#${i + 1}:${goalServed(systemText(r.body))}`).join(' '))
const firstContinueIndex = requests.findIndex(r => continuesIn(r) >= 1)
const secondContinueIndex = requests.findIndex(r => continuesIn(r) >= 2)
const continueRequests = [firstContinueIndex, secondContinueIndex].filter(i => i !== -1).map(i => requests[i]!)
check("each continue typed starts its own request whose operator words are exactly 'continue', with the goal in the system prompt (both continues)", continueRequests.length === 2 && continueRequests.every(r => operatorWords(lastUserText(r.body)) === 'continue' && goalServed(systemText(r.body))), `continueRequests=${continueRequests.length} at #${firstContinueIndex + 1} and #${secondContinueIndex + 1}`)
const turnStarts = [first, ...continueRequests].filter((r): r is Request => r !== undefined)
const statuses = turnStarts.map(r => statusOf(lastUserText(r.body)))
const statusRecords = rows.filter(r => r.type === 'attachment' && r.attachment?.type === 'mission_status')
const notYetVerdict = new RegExp(`^not yet \\(${JUDGE_NOT_YET_REASON}\\)$`)
check(`a one-line mission status rides each turn's opening message with the current fields, one counter of judged ends: checks 0 · none yet · armed at arming, checks ${IDLE_TURNS} · the judge's not-yet · armed on the first continue, checks ${IDLE_TURNS + 1} on the second`, statuses.length === 3 && statuses.every(s => s !== null && !s.line.includes('\n')) && statuses[0]?.checks === 0 && statuses[0]?.verdict === 'none yet' && statuses[0]?.state === 'armed' && statuses[1]?.checks === IDLE_TURNS && notYetVerdict.test(statuses[1]?.verdict ?? '') && statuses[1]?.state === 'armed' && statuses[2]?.checks === IDLE_TURNS + 1 && notYetVerdict.test(statuses[2]?.verdict ?? '') && statuses[2]?.state === 'armed', JSON.stringify(statuses.map(s => (s === null ? null : `${s.checks}/${s.verdict.slice(0, 40)}/${s.state}: ${s.line.slice(0, 100)}`))))
const statusShape = /^Mission status — checks \d+ · last verdict .+ · (armed|paused)/
check('each turn-opening status line is bound to a mission_status attachment record in the hosted transcript with the same text, checks and state, and every record is one current status line (a fresh one after each hold, none without a mission)', statusRecords.length >= 3 && statuses.every(s => s !== null && statusRecords.some(r => r.attachment?.text === s.line && r.attachment?.checks === s.checks && r.attachment?.state === s.state)) && statusRecords.every(r => statusShape.test(r.attachment?.text ?? '') && !(r.attachment?.text ?? '').includes('\n')), `records=${JSON.stringify(statusRecords.map(r => ({ text: r.attachment?.text?.slice(0, 80), checks: r.attachment?.checks, state: r.attachment?.state })))}`)
const holdForm = new RegExp(`^${HOLD_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${JUDGE_NOT_YET_REASON}|${JUDGE_UNREADABLE_REASON}|${JUDGE_UNREACHABLE_REASON})\\. Continue\\.$`)
const unreadableHolds = holdRows.filter(r => textOf(r).includes(JUDGE_UNREADABLE_REASON))
const unreachableHolds = holdRows.filter(r => textOf(r).includes(JUDGE_UNREACHABLE_REASON))
const closeRows = assistantRows.filter(r => textOf(r).trim().endsWith(MISSION_MET_SENTINEL))
const assistantBefore = (row: Row): Row | undefined => rows.slice(0, rows.indexOf(row)).reverse().find(r => r.type === 'assistant')
check(`a turn that ends before the mission is met is held with one line "Mission not completed: <goal> — <the judge's reason>. Continue." — ${IDLE_TURNS - 1} in the idle turn, ${WORKING_ENDS} in the working turn, one at the first close, and no ask-hold anywhere`, holdRows.length === IDLE_TURNS - 1 + WORKING_ENDS + 1 && holdRows.every(r => holdForm.test(textOf(r).trim())) && askHolds.length === 0, `holds=${holdRows.length} ${holdRows.map(r => textOf(r).split('\n')[0]!.slice(0, 120)).join(' | ')}`)
check("a judge that cannot be reached never ends the mission: the first itemised close is answered with an API error, and that end is held with 'the judge could not be reached' though the close is itemised — the claim is not the verification while the judge can be called", closeRows.length === CLOSES && unreachableHolds.length === 1 && assistantBefore(unreachableHolds[0]!) === closeRows[0] && !askHolds.includes(unreachableHolds[0]!), `closes=${closeRows.length} unreachable=${unreachableHolds.length} before=${unreachableHolds[0] === undefined ? 'none' : textOf(assistantBefore(unreachableHolds[0]!) ?? {}).slice(-80)}`)
check("a malformed judge answer (prose around the object, no reason) reads as not yet: the second idle end is held with 'the judge gave no readable verdict', never met", unreadableHolds.length === 1 && holdRows[1] !== undefined && textOf(holdRows[1]).includes(JUDGE_UNREADABLE_REASON), `unreadable=${unreadableHolds.length} second=${holdRows[1] === undefined ? 'none' : textOf(holdRows[1]).slice(0, 160)}`)
const modelOfSeat = first === undefined ? '' : modelOf(first)
check(`the judge is called once at every turn end (${JUDGED_ENDS} ends, ${JUDGED_ENDS} calls), on the seat's model with thinking off, with one user message that carries the goal, the criteria, the closing words and a bounded tool tally — never the conversation`, judgeRequests.length === JUDGED_ENDS && judgeRequests.every(r => modelOf(r) === modelOfSeat && thinkingOff(r) && messagesOf(r.body).length === 1 && lastUserText(r.body).includes(`Goal: ${COMPILED.endState}`) && CRITERIA.every((c, i) => lastUserText(r.body).includes(`${i + 1}. ${c}`)) && lastUserText(r.body).includes('Closing words of the turn') && /Tools: (no tool call this turn|\d+ tool call\(s\) this turn: Read)/.test(lastUserText(r.body)) && !lastUserText(r.body).includes('A standing goal is now active') && !lastUserText(r.body).includes(HOLD_HEAD)), `judge=${judgeRequests.length} ${JSON.stringify(judgeRequests.slice(0, 3).map(r => ({ model: modelOf(r), effort: effortOf(r), thinking: (r.body as { thinking?: unknown }).thinking, messages: messagesOf(r.body).length })))} seat=${modelOfSeat}`)
check(`the judge's input counts the judged ends: the last call says ${JUDGED_ENDS - 1} turn ends judged so far`, lastUserText(judgeRequests[judgeRequests.length - 1]?.body ?? {}).includes(`Turn ends judged so far: ${JUDGED_ENDS - 1}`), lastUserText(judgeRequests[judgeRequests.length - 1]?.body ?? {}).split('\n').filter(line => line.startsWith('Turn ends')).join(' | '))
check(`the drive sets the seat's dial itself (settings.json engine.effort '${SEAT_EFFORT}', the saved default the admit request carries to the seat): every seat request carries '${SEAT_EFFORT}' on the wire and every judge request 'low' — the pinned floor outranks the dial`, requests.length > 0 && requests.every(r => effortOf(r) === SEAT_EFFORT) && judgeRequests.length > 0 && judgeRequests.every(r => effortOf(r) === 'low'), `seat=${JSON.stringify(requests.slice(0, 2).map(effortOf))} judge=${JSON.stringify(judgeRequests.slice(0, 2).map(effortOf))}`)
const beforeContinue = timeline.filter(s => s.atMs < firstContinueEpoch)
const idlePause = beforeContinue.find(s => s.state === 'paused' && (s.nextStep ?? '').includes(`${IDLE_TURNS} turns without a tool call`))
const idleNotes = rows.filter(r => r.type === 'system' && textOf(r).includes(IDLE_NOTE))
check(`The only brake on the loop: ${IDLE_TURNS} consecutive turn ends without a tool call pause the goal — the persisted card reads paused at ${IDLE_TURNS} judged ends before the first continue, the note says what happened and what resumes it, and no sample ever reads an ended state`, idlePause !== undefined && idlePause.iterations === IDLE_TURNS && idleNotes.length === 1 && stampOf(idleNotes[0]!) < firstContinueEpoch && timeline.every(s => s.state === 'armed' || s.state === 'paused' || s.state === 'met') && !timeline.some(s => ENDED_STATES.has(s.state)), `idlePause=${JSON.stringify(idlePause ?? null)} notes=${idleNotes.map(r => textOf(r)).join(' | ')} timeline=${JSON.stringify(timeline.map(s => `${s.state}@${s.iterations}`))}`)
check("while the mission is paused the screen says so: the footer reads /mission paused and the rail keeps the goal's ◆ row", whilePaused !== undefined && findRows(whilePaused.rows, '/mission paused').length > 0 && findRows(whilePaused.rows, '◆ the file hello').length > 0, `at ${firstContinueOffset}ms: ${whilePaused?.rows.filter(r => r.includes('/mission') || r.includes('◆')).join(' | ') ?? 'no screen'}`)
const betweenContinues = timeline.filter(s => s.atMs >= firstContinueEpoch && s.atMs < secondContinueEpoch)
const pausedOnQuestion = betweenContinues.find(s => s.state === 'paused' && (s.nextStep ?? '').includes(QUESTION))
const questionNote = pauseNotes.find(r => textOf(r).includes(QUESTION))
check('the first continue resumes it (its opening status reads armed) and a turn ending on a question pauses it again: the card reads paused with the question before the second continue, the note names it', statuses[1]?.state === 'armed' && pausedOnQuestion !== undefined && questionNote !== undefined && stampOf(questionNote) < secondContinueEpoch && stampOf(questionNote) > firstContinueEpoch, `opening=${statuses[1]?.state} between=${JSON.stringify(betweenContinues.map(s => `${s.state}@${s.iterations}:${(s.nextStep ?? '').slice(0, 40)}`))} note=${questionNote === undefined ? 'none' : textOf(questionNote).slice(0, 100)}`)
const afterSecond = timeline.filter(s => s.atMs >= secondContinueEpoch)
const firstCloseIndex = closeRows[0] === undefined ? rows.length : rows.indexOf(closeRows[0])
const workingHolds = holdRows.filter(r => stampOf(r) >= secondContinueEpoch && rows.indexOf(r) < firstCloseIndex)
const toolRowsAfterSecond = rows.filter(r => hasToolUse(r) && stampOf(r) >= secondContinueEpoch)
check(`a working sequence is never paused: after the second continue ${WORKING_ENDS} turn ends alternate reads and tool-less replies (${WORKING_PLAN.map(reads => (reads ? 'Read' : 'none')).join(', ')}) — each end is held, a Read resets the count so no run of tool-less ends reaches ${IDLE_TURNS}, none pauses, and the mission runs on to its close`, workingHolds.length === WORKING_ENDS && toolRowsAfterSecond.length >= WORKING_READS && !afterSecond.some(s => s.state === 'paused') && !pauseNotes.some(r => stampOf(r) >= secondContinueEpoch), `workingHolds=${workingHolds.length} toolRows=${toolRowsAfterSecond.length} after=${JSON.stringify(afterSecond.map(s => `${s.state}@${s.iterations}`))}`)
const completed = completedRows[0]
check(`met is announced like a finished monitor once the judge answers met at the second close: one completed row in the chat — 'Mission completed: <goal> — <the judge's reason> · ${JUDGED_ENDS} turns · <elapsed>', the same count the card and the judge carry — recorded, painted, and the card reads met with that outcome`, card?.state === 'met' && card.iterations === JUDGED_ENDS && card.outcome?.reason === JUDGE_MET_REASON && card.outcome.turns === JUDGED_ENDS && completedRows.length === 1 && completed !== undefined && textOf(completed).includes(`${COMPLETED_HEAD} ${GOAL} — ${JUDGE_MET_REASON} · ${JUDGED_ENDS} turns · `) && rows.indexOf(completed) > rows.indexOf(closeRows[CLOSES - 1]!) && findRows(atEnd!.rows, COMPLETED_HEAD).length > 0, `card=${JSON.stringify(card ?? null)} rows=${completedRows.map(r => textOf(r).slice(0, 200)).join(' | ')} screen=${atEnd!.rows.filter(r => r.includes('Mission')).join(' | ')}`)
check('after met the footer indicator clears and the rail drops the goal: no /mission words in the footer, no ◆ goal row', INDICATOR_WORDS.every(word => findRows(atEnd!.rows, word).length === 0) && findRows(atEnd!.rows, `◆ ${COMPILED.endState}`).length === 0 && findRows(atEnd!.rows, '◆ the file hello').length === 0, atEnd!.rows.filter(r => r.includes('/mission') || r.includes('◆')).join(' | '))

console.log('\n── a bare completion line as the first reply ──')
const bare = await arena(bareTurns, bareSends, 14)
const bareConfig = join(bare.paths.home, '.mercury')
const bareTranscript = (await transcriptsUnder(bareConfig)).find(t => t.rows.some(r => r.type === 'assistant'))
const bareRows = bareTranscript?.rows ?? []
const bareCard = bareTranscript === undefined ? undefined : cardsUnder(bareConfig).find(c => c.sessionId === bareTranscript.sessionId)
const bareClaimIndex = bareRows.findIndex(r => r.type === 'assistant' && textOf(r).trim().endsWith(MISSION_MET_SENTINEL))
const holdAfterBareClaim = bareClaimIndex === -1 ? undefined : bareRows.slice(bareClaimIndex + 1).find(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
check('the bare-sentinel leg ran to its end and the bare completion line was delivered as the first reply', complete(bare, 1) && bareClaimIndex !== -1 && bareRows.slice(0, bareClaimIndex).every(r => r.type !== 'assistant'), `${runWords(bare)} bareClaimIndex=${bareClaimIndex}`)
check("a reply that ends on the sentinel without the itemised criterion lines is held, not met, though the judge said met: the hold names the missing lines first, the judge's met after, and the card never reads met", holdAfterBareClaim !== undefined && textOf(holdAfterBareClaim).includes(BARE_CLAIM_REASON) && textOf(holdAfterBareClaim).includes('the judge read the goal as met, but the itemised close is the prerequisite') && bareCard !== undefined && bareCard.state !== 'met', `hold=${holdAfterBareClaim === undefined ? 'none' : textOf(holdAfterBareClaim).slice(0, 200)} card=${JSON.stringify(bareCard ?? null)}`)

console.log('\n── a session without a mission is untouched ──')
check('without a mission the section is null, its key is off, and the status producer yields nothing', missionSection(undefined) === null && missionSectionKey(undefined) === 'off' && getMissionStatusAttachment([]).length === 0)
const plain = await arena([text(WORKING), text(WORKING)], plainSends, 12)
const plainRequests: Request[] = plain.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const plainRows = (await transcriptsUnder(join(plain.paths.home, '.mercury'))).flatMap(t => t.rows)
const plainSections = plainRequests.filter(r => systemText(r.body).includes(SECTION_HEADING))
const plainStatuses = plainRequests.filter(r => userTexts(r.body).some(t => reminderBlocks(t).some(b => b.startsWith(STATUS_HEAD))))
const plainStatusRecords = plainRows.filter(r => r.type === 'attachment' && r.attachment?.type === 'mission_status')
const plainJudge = plainRequests.filter(isJudge)
const plainWords = plainRequests.flatMap(r => MISSION_VOCABULARY.filter(word => JSON.stringify(r.body).includes(word)))
check('the no-mission drive ran to its end and reached the model', complete(plain, 1) && plainRequests.length >= 1, `${runWords(plain)} requests=${plainRequests.length}`)
check('its system prompt carries no Mission section, its messages no status reminder, its transcript no mission_status record, and no judge call was made', plainRequests.length >= 1 && plainRows.length > 0 && plainSections.length === 0 && plainStatuses.length === 0 && plainStatusRecords.length === 0 && plainJudge.length === 0, `rows=${plainRows.length} sections=${plainSections.length} statuses=${plainStatuses.length} records=${plainStatusRecords.length} judge=${plainJudge.length}`)
check('its request bodies carry none of the mission vocabulary', plainRequests.length >= 1 && plainWords.length === 0, `found=${JSON.stringify(plainWords)}`)
check('it writes no mission card', cardsUnder(join(plain.paths.home, '.mercury')).length === 0)

if (OUT !== undefined) {
  const dir = resolve(OUT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'screen-120x40-end.txt'), `${atEnd!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'screen-120x40-paused.txt'), `${(whilePaused?.rows ?? []).join('\n')}\n`)
  writeFileSync(join(dir, 'cards.json'), `${JSON.stringify(cards, null, 1)}\n`)
  writeFileSync(join(dir, 'card-timeline.json'), `${JSON.stringify(cardTimeline.map(s => ({ ...s, at: new Date(s.atMs).toISOString() })), null, 1)}\n`)
  writeFileSync(join(dir, 'sends.json'), `${JSON.stringify(run.sendLog.map(s => ({ at: new Date(s.sent).toISOString(), text: Buffer.from(s.b64, 'base64').toString('utf8').replace(/\r/g, '⏎') })), null, 1)}\n`)
  writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests.map((r, i) => ({ n: i + 1, model: modelOf(r), effort: effortOf(r), goalServed: goalServed(systemText(r.body)), status: statusOf(lastUserText(r.body)), operatorWords: operatorWords(lastUserText(r.body)).slice(0, 400) })), null, 1)}\n`)
  writeFileSync(join(dir, 'judge-requests.json'), `${JSON.stringify(judgeRequests.map((r, i) => ({ n: i + 1, model: modelOf(r), effort: effortOf(r), thinking: (r.body as { thinking?: unknown }).thinking ?? null, system: systemText(r.body), user: lastUserText(r.body) })), null, 1)}\n`)
  writeFileSync(join(dir, 'requests-full.json'), `${JSON.stringify(requests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
  writeFileSync(join(dir, 'transcript-rows.json'), `${JSON.stringify(rows.map(r => ({ at: r.timestamp, type: r.type, isMeta: r.isMeta, subtype: r.subtype, level: r.level, origin: r.origin, attachment: r.attachment?.type, toolUse: hasToolUse(r), text: textOf(r).slice(0, 240) })), null, 1)}\n`)
  writeFileSync(join(dir, 'bare-transcript-rows.json'), `${JSON.stringify(bareRows.map(r => ({ at: r.timestamp, type: r.type, isMeta: r.isMeta, text: textOf(r).slice(0, 240) })), null, 1)}\n`)
  writeFileSync(join(dir, 'bare-card.json'), `${JSON.stringify(bareCard ?? null, null, 1)}\n`)
  writeFileSync(join(dir, 'plain-requests-full.json'), `${JSON.stringify(plainRequests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
}
run.cleanup()
bare.cleanup()
plain.cleanup()
console.log(`\nmission served: ${failures === 0 ? `green (${checks} checks)` : `RED (${failures}/${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
