#!/usr/bin/env bun
// gate-watch: src/screens/Chat.tsx src/services/engine-connector/** src/daemon/controlServer.ts src/daemon/concourseDispatch.ts
// gate-watch: src/cli/run.ts src/guards/** src/query/stopHooks.ts src/services/mission/** src/components/messages/AssistantTextMessage.tsx
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findRows, firstOutputTs, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { MISSION_DIRECTIVE_HEADER, MISSION_MET_SENTINEL } from '../../src/guards/mission.ts'
import { MISSION_JUDGE_MARK } from '../../src/services/mission/goalJudge.ts'

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = argument('--dist')
const FRAMES = argument('--frames')
const FIRST = 'the file hello.txt exists in the cwd and contains the word hello'
const SECOND = 'the file bye.txt exists in the cwd'
const FIRST_ANSWER = 'wrote hello.txt with the word hello.'
const SECOND_ANSWER = 'wrote bye.txt as asked.'
const MET_NEEDLE = 'Mission completed'
const JUDGE_MET = (reason: string): string => JSON.stringify({ verdict: 'met', reason })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

type Card = { sessionId: string; goal: string; state: string; iterations: number; nextStep: string | null; setAt: string; outcome?: { reason: string; metAt: string; turns: number } }
type Screen = { atMs: number; rows: string[] }
type Row = { type?: string; isMeta?: boolean; subtype?: string; level?: string; content?: unknown; origin?: { kind?: string; command?: string }; message?: { role?: string; content?: unknown } }

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function missionCards(configDir: string): Card[] {
  return walk(join(configDir, 'projects'))
    .filter(p => p.includes(`${join('missions', '')}`) && p.endsWith('.json'))
    .map(p => JSON.parse(readFileSync(p, 'utf8')) as Card)
}

async function transcriptRows(configDir: string, sessionId: string): Promise<Row[]> {
  const path = walk(join(configDir, 'projects')).find(p => p.endsWith(`${sessionId}.jsonl`))
  if (path === undefined) return []
  const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
  const chain = await reader.readTranscriptChainSince(path, null)
  return chain.rows as unknown as Row[]
}

function textOf(row: Row): string {
  const content = row.message?.content ?? row.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
  const user = [...messages].reverse().find(m => m.role === 'user')
  return user === undefined ? '' : JSON.stringify(user.content)
}
function systemText(body: unknown): string {
  const s = (body as { system?: unknown }).system
  if (typeof s === 'string') return s
  if (Array.isArray(s)) return s.map(b => (typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
  return ''
}
const isJudgeRequest = (body: unknown): boolean => systemText(body).includes(MISSION_JUDGE_MARK)

const sentAt = (run: ArenaRun, prefix: string): number | undefined => {
  const send = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith(prefix))
  return send === undefined ? undefined : send.sent - firstOutputTs(run)
}

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

async function drive(cols: number, rows: number): Promise<ArenaRun> {
  return runArtifactArena({
    turns: [
      { kind: 'text', text: JUDGE_MET('hello.txt exists with the word hello'), whenBody: MISSION_JUDGE_MARK },
      { kind: 'text', text: JUDGE_MET('bye.txt exists in the cwd'), whenBody: MISSION_JUDGE_MARK },
      { kind: 'text', text: `1. ${FIRST} — ${FIRST_ANSWER}\n${MISSION_MET_SENTINEL}` },
      { kind: 'text', text: `1. ${SECOND} — ${SECOND_ANSWER}\n${MISSION_MET_SENTINEL}` },
    ],
    sends: [
      { awaitText: 'no prompts sent yet', text: `/goal ${FIRST}\r` },
      { awaitText: MET_NEEDLE, afterPrevMs: 1500, text: `/goal ${SECOND}\r` },
    ],
    seconds: 45,
    cols,
    rows,
    keep: true,
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })
}

console.log('============================================================')
console.log(' /goal typed on the screen starts the turn with its directive')
console.log('============================================================')
console.log(`build under proof: ${DIST !== undefined ? resolve(DIST) : 'this tree'}`)

const run = await drive(120, 40)
const configDir = join(run.paths.home, '.mercury')
const firstSentAt = sentAt(run, '/goal the file hello')
const secondSentAt = sentAt(run, '/goal the file bye')
check('the capture ran to its end and the first /goal fired', run.outcome.exitCode !== null && firstSentAt !== undefined, `exit=${run.outcome.exitCode} sends=${run.sendLog.length} ${run.outcome.reason ?? ''} ${run.driverOut.slice(-200)}`)
if (firstSentAt === undefined) {
  console.log(`\ngoal interactive: RED (${failures}/${checks}) — the command never fired`)
  process.exit(1)
}
const [atEnd] = screensAt(run, 120, 40, [-1])
const allRequests = run.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const requests = allRequests.filter(r => !isJudgeRequest(r.body))
const judgeRequests = allRequests.filter(r => isJudgeRequest(r.body))
const cards = missionCards(configDir)
const rowsByCard = new Map<string, Row[]>()
for (const c of cards) rowsByCard.set(c.sessionId, await transcriptRows(configDir, c.sessionId))
const hosted = cards.find(c => (rowsByCard.get(c.sessionId) ?? []).length > 0)
const rows = hosted === undefined ? [] : (rowsByCard.get(hosted.sessionId) ?? [])
const metaRows = rows.filter(r => r.type === 'user' && r.isMeta === true && textOf(r).includes(MISSION_DIRECTIVE_HEADER))
const assistantRows = rows.filter(r => r.type === 'assistant')
const metNotices = rows.filter(r => r.type === 'user' && r.origin?.kind === 'task-notification' && textOf(r).includes(MET_NEEDLE))
const firstSetAt = hosted === undefined ? NaN : Date.parse(hosted.setAt)
const firstRequest = requests[0]
console.log(`  requests=${requests.length} judgeRequests=${judgeRequests.length} cards=${JSON.stringify(cards.map(c => ({ goal: c.goal.slice(0, 24), state: c.state, iterations: c.iterations })))} metaRows=${metaRows.length} assistantRows=${assistantRows.length} metNotices=${metNotices.length}`)

check('/goal alone starts a model turn: a request reached the model with no further words typed', firstRequest !== undefined, `requests=${requests.length}`)
check("the arming turn's user message is the directive: the goal statement reaches the model on that turn", firstRequest !== undefined && lastUserText(firstRequest.body).includes(MISSION_DIRECTIVE_HEADER) && lastUserText(firstRequest.body).includes(FIRST), firstRequest === undefined ? 'no request' : lastUserText(firstRequest.body).slice(0, 300))
check('the directive is recorded in the transcript as a meta user row born of the screen command', metaRows.length >= 1 && metaRows[0]!.origin?.kind === 'screen-command' && metaRows[0]!.origin?.command === 'mission', JSON.stringify(metaRows[0] ?? rows.filter(r => r.type === 'user').map(r => textOf(r).slice(0, 60))))
check('the directive never paints in the feed', findRows(atEnd!.rows, 'A standing goal is now active').length === 0 && findRows(atEnd!.rows, 'Goal: the file hello.txt').length === 0, atEnd!.rows.filter(r => r.includes('standing goal') || r.includes('Goal:')).join(' | '))
check("the transcript keeps the completion line in the assistant's words (the judge reads it there)", assistantRows.some(r => textOf(r).includes(MISSION_MET_SENTINEL)), assistantRows.map(r => textOf(r).slice(-40)).join(' | '))
check('the painted text carries no <<>> and no marker: the completion line is elided at paint', findRows(atEnd!.rows, '<<>>').length === 0 && findRows(atEnd!.rows, 'GOAL-MET').length === 0 && findRows(atEnd!.rows, FIRST_ANSWER).length > 0, atEnd!.rows.filter(r => r.includes('<<') || r.includes(FIRST_ANSWER)).join(' | '))
check('met is announced like a finished monitor: one completed row the operator can read — the goal, the judge\'s reason, the turns and the elapsed time — painted on screen', findRows(atEnd!.rows, MET_NEEDLE).length > 0 && metNotices.length >= 1 && textOf(metNotices[0]!).includes(`${MET_NEEDLE}: ${FIRST} — hello.txt exists with the word hello · 1 turn ·`), `${metNotices.map(r => textOf(r).slice(0, 200)).join(' | ')} :: ${atEnd!.rows.filter(r => r.includes('Mission')).join(' | ')}`)
check('every turn end asked the judge once, on the seat\'s model at low with thinking off, with the goal and the closing words but never the conversation', judgeRequests.length === 2 && judgeRequests.every(r => (r.body as { model?: string }).model === (requests[0]?.body as { model?: string }).model && (r.body as { output_config?: { effort?: string } }).output_config?.effort === 'low' && ((r.body as { thinking?: { type?: string } }).thinking === undefined || (r.body as { thinking?: { type?: string } }).thinking?.type === 'disabled') && ((r.body as { messages?: unknown[] }).messages?.length ?? 0) === 1 && lastUserText(r.body).includes('Closing words of the turn') && !lastUserText(r.body).includes(MISSION_DIRECTIVE_HEADER)), JSON.stringify(judgeRequests.map(r => ({ model: (r.body as { model?: string }).model, effort: (r.body as { output_config?: { effort?: string } }).output_config?.effort, thinking: (r.body as { thinking?: unknown }).thinking, messages: (r.body as { messages?: unknown[] }).messages?.length }))))
check('the first goal met at its first judged end on its itemised close: the first completed row in the transcript names it met with one turn and no hold anywhere', metNotices.length >= 1 && textOf(metNotices[0]!).includes(MET_NEEDLE) && textOf(metNotices[0]!).includes(' · 1 turn · ') && rows.filter(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith('Mission not completed:')).length === 0, rows.filter(r => r.type === 'user' && r.isMeta === true).map(r => textOf(r).slice(0, 50)).join(' | '))
const sendMs = (prefix: string): number => run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith(prefix))?.sent ?? 0
check("the card's setAt is the arming moment: within five seconds of its /goal send, never a later input", hosted !== undefined && Number.isFinite(firstSetAt) && Math.abs(firstSetAt - sendMs(hosted.goal === SECOND ? '/goal the file bye' : '/goal the file hello')) < 5_000, hosted === undefined ? 'no hosted card' : `setAt=${hosted.setAt} first=${new Date(sendMs('/goal the file hello')).toISOString()} second=${new Date(sendMs('/goal the file bye')).toISOString()}`)

const secondRequest = requests[1]
check('a second /goal mid-session fired after the first went met', secondSentAt !== undefined, `sends=${run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('utf8').slice(0, 24)).join(' | ')} · driver: ${run.driverOut.slice(-300).replace(/\s+/g, ' ')}`)
check('the second /goal starts its own turn with the NEW directive', secondRequest !== undefined && lastUserText(secondRequest.body).includes(MISSION_DIRECTIVE_HEADER) && lastUserText(secondRequest.body).includes(SECOND) && !lastUserText(secondRequest.body).includes(FIRST), secondRequest === undefined ? `requests=${requests.length}` : lastUserText(secondRequest.body).slice(0, 300))
check("the judge ran against the new goal: the card reads met for it after one judged end (iterations 1, the outcome's turns 1), the first goal's settled state cleared on re-arm", hosted !== undefined && hosted.goal === SECOND && hosted.state === 'met' && hosted.iterations === 1 && hosted.outcome?.turns === 1, JSON.stringify(hosted))
check('a second completed row painted for the second goal', metNotices.length >= 2 && textOf(metNotices[1]!).includes(`${MET_NEEDLE}: ${SECOND} — bye.txt exists in the cwd`) && findRows(atEnd!.rows, SECOND_ANSWER).length > 0 && findRows(atEnd!.rows, '<<>>').length === 0, `notices=${metNotices.length} · ${atEnd!.rows.filter(r => r.includes('bye.txt')).join(' | ')}`)
check('after met the footer and the rail drop the mission: no ◎ /mission in the footer, no ◆ goal row in the rail', findRows(atEnd!.rows, '/mission active').length === 0 && findRows(atEnd!.rows, '/mission paused').length === 0 && findRows(atEnd!.rows, `◆ ${SECOND}`).length === 0 && findRows(atEnd!.rows, `◆ ${FIRST}`).length === 0, atEnd!.rows.filter(r => r.includes('/mission') || r.includes('◆')).join(' | '))

if (FRAMES !== undefined) {
  const dir = resolve(FRAMES)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'screen-120x40-end.txt'), `${atEnd!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'cards.json'), `${JSON.stringify(cards, null, 1)}\n`)
  writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests.map(r => lastUserText(r.body)), null, 1)}\n`)
  writeFileSync(join(dir, 'transcript-rows.json'), `${JSON.stringify(rows.map(r => ({ type: r.type, isMeta: r.isMeta, subtype: r.subtype, level: r.level, origin: r.origin, text: textOf(r).slice(0, 160) })), null, 1)}\n`)
}
run.cleanup()
console.log(`\ngoal interactive: ${failures === 0 ? `green (${checks} checks)` : `RED (${failures}/${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
