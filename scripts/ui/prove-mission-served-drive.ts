#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findRows, firstOutputTs, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { MISSION_MET_SENTINEL } from '../../src/guards/mission.ts'

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = argument('--dist')
const OUT = argument('--out')
const GOAL = 'the file hello.txt exists in the cwd and contains the word hello'
const GOAL_NEEDLE = 'hello.txt'
const WORKING = 'Working on it.'
const QUESTION = 'Which directory should hold hello.txt?'
const BARE_CLAIM = `all done.\n${MISSION_MET_SENTINEL}`
const HOLD_HEAD = `Mission not completed: ${GOAL}`
const STATUS_HEAD = 'Mission status —'
const PAUSE_NOTE = 'mission paused'
const BARE_CLAIM_REASON = 'no criterion lines'
const INDICATOR_PAUSED = '/mission paused'
const INDICATOR_ACTIVE = '/mission active'
const MISSION_WORDS = ['GOAL-MET', STATUS_HEAD, 'Mission not completed', '# Mission', GOAL_NEEDLE]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

type Card = { sessionId: string; goal: string; state: string; iterations: number; nextStep: string | null; setAt: string }
type Screen = { atMs: number; rows: string[] }
type Row = { type?: string; isMeta?: boolean; subtype?: string; level?: string; content?: unknown; origin?: { kind?: string; command?: string }; message?: { role?: string; content?: unknown }; attachment?: { type?: string } }
type Request = { body: unknown }

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

async function transcriptRows(configDir: string): Promise<Row[]> {
  const paths = walk(join(configDir, 'projects')).filter(p => p.endsWith('.jsonl') && !p.includes('receipts') && !p.includes('subagents'))
  const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
  const rows: Row[] = []
  for (const path of paths) {
    const chain = await reader.readTranscriptChainSince(path, null)
    rows.push(...(chain.rows as unknown as Row[]))
  }
  return rows
}

function textOf(row: Row): string {
  const content = row.message?.content ?? row.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>).map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

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
function lastUserText(body: unknown): string {
  const user = [...messagesOf(body)].reverse().find(m => m.role === 'user')
  return user === undefined ? '' : flat(user.content)
}
function userTexts(body: unknown): string[] {
  return messagesOf(body).filter(m => m.role === 'user').map(m => flat(m.content))
}
function wholeBody(body: unknown): string {
  return JSON.stringify(body)
}

const sentAt = (run: ArenaRun, prefix: string): number | undefined => {
  const send = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith(prefix))
  return send === undefined ? undefined : send.sent - firstOutputTs(run)
}
const sendsOf = (run: ArenaRun): string[] => run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('utf8').replace(/\r/g, '⏎'))

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

const missionTurns = [WORKING, WORKING, WORKING, QUESTION, WORKING, WORKING, WORKING, WORKING, BARE_CLAIM, ...Array.from({ length: 24 }, () => WORKING)]

async function missionDrive(): Promise<ArenaRun> {
  return runArtifactArena({
    turns: missionTurns.map(text => ({ kind: 'text' as const, text })),
    sends: [
      { awaitText: 'Type a prompt', settleMs: 1200, text: `/mission ${GOAL}\r` },
      { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
      { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
    ],
    seconds: 36,
    cols: 120,
    rows: 40,
    keep: true,
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })
}

async function plainDrive(): Promise<ArenaRun> {
  return runArtifactArena({
    turns: [{ kind: 'text', text: WORKING }, { kind: 'text', text: WORKING }],
    sends: [{ awaitText: 'Type a prompt', settleMs: 1200, text: 'hello\r' }],
    seconds: 12,
    cols: 120,
    rows: 40,
    keep: true,
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })
}

console.log('============================================================')
console.log(' /mission typed on the screen: the goal is served every turn, a bare continue included')
console.log('============================================================')
console.log(`build under proof: ${DIST !== undefined ? resolve(DIST) : 'this tree'}`)

const run = await missionDrive()
const configDir = join(run.paths.home, '.mercury')
const missionSentAt = sentAt(run, '/mission the file')
const continueSends = run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('utf8').startsWith('continue')).map(s => s.sent - firstOutputTs(run))
check('the capture ran to its end and all three sends fired (/mission, continue, continue)', run.outcome.exitCode !== null && missionSentAt !== undefined && continueSends.length === 2, `exit=${run.outcome.exitCode} sends=${JSON.stringify(sendsOf(run).map(s => s.slice(0, 30)))} unfired=${JSON.stringify(run.outcome.report?.unfired ?? [])} ${run.outcome.reason ?? ''}`)
if (missionSentAt === undefined) {
  console.log(`\nmission served: RED (${failures}/${checks}) — the command never fired`)
  process.exit(1)
}
const [atEnd] = screensAt(run, 120, 40, [-1])
const requests: Request[] = run.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const cards = missionCards(configDir)
const rows = await transcriptRows(configDir)
const assistantRows = rows.filter(r => r.type === 'assistant')
const holdRows = rows.filter(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
const pauseNotes = rows.filter(r => r.type === 'system' && textOf(r).includes(PAUSE_NOTE))
const card = cards.find(c => c.goal === GOAL)
console.log(`  requests=${requests.length} holds=${holdRows.length} pauseNotes=${pauseNotes.length} assistantRows=${assistantRows.length} card=${JSON.stringify(card === undefined ? null : { state: card.state, iterations: card.iterations, nextStep: (card.nextStep ?? '').slice(0, 80) })}`)
for (const [i, r] of requests.entries()) console.log(`    #${i + 1} system goal=${systemText(r.body).includes(GOAL_NEEDLE)} status=${userTexts(r.body).some(t => t.includes(STATUS_HEAD))} last=${JSON.stringify(lastUserText(r.body).slice(0, 90))}`)

const first = requests[0]
check('the arming send alone produces a model request: the first request carries the directive, and no continue has been typed yet', first !== undefined && lastUserText(first.body).includes(GOAL) && !userTexts(first.body).some(t => t.trim() === 'continue'), first === undefined ? 'no request' : lastUserText(first.body).slice(0, 200))
check('every request after the arming one carries the goal in the system prompt — the continue requests included', requests.length > 1 && requests.slice(1).every(r => systemText(r.body).includes(GOAL_NEEDLE)), requests.map((r, i) => `#${i + 1}:${systemText(r.body).includes(GOAL_NEEDLE)}`).join(' '))
const continuesCarried = (r: Request): number => userTexts(r.body).filter(t => /(^|\n)continue$/.test(t.trim())).length
const firstContinueIndex = requests.findIndex(r => continuesCarried(r) >= 1)
const secondContinueIndex = requests.findIndex(r => continuesCarried(r) >= 2)
const continueRequests = [firstContinueIndex, secondContinueIndex].filter(i => i !== -1).map(i => requests[i]!)
check('a bare continue reaches the model with the goal in the system prompt (both continues)', continueRequests.length === 2 && continueRequests.every(r => systemText(r.body).includes(GOAL_NEEDLE)), `continueRequests=${continueRequests.length} at #${firstContinueIndex + 1} and #${secondContinueIndex + 1}`)
check('a one-line mission status rides each turn as an attachment beside the other per-turn attachments', requests.length > 1 && requests.every(r => userTexts(r.body).some(t => t.includes(STATUS_HEAD))), requests.map((r, i) => `#${i + 1}:${userTexts(r.body).some(t => t.includes(STATUS_HEAD))}`).join(' '))
check('a turn that ends before the mission is met is held with "Mission not completed: <goal> — <what is open>. Continue."', holdRows.length >= 3 && holdRows.filter(r => !textOf(r).includes('one question to the operator')).every(r => new RegExp(`^Mission not completed: ${GOAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — .+\\. Continue\\.$`).test(textOf(r).split('\n')[0] ?? '')), holdRows.map(r => textOf(r).split('\n')[0]!.slice(0, 120)).join(' | '))
check('after three non-itemised replies the card is still armed or paused: never needs-operator, never stood-down', card !== undefined && (card.state === 'armed' || card.state === 'paused'), JSON.stringify(card))
const firstWithQuestion = requests.findIndex(r => messagesOf(r.body).some(m => m.role === 'assistant' && flat(m.content).includes(QUESTION)))
check('the question pauses the mission: a note names the pause and the question, and no request follows the question until the operator speaks', pauseNotes.length >= 1 && textOf(pauseNotes[0]!).includes(QUESTION) && firstWithQuestion !== -1 && firstWithQuestion === firstContinueIndex, `pauseNotes=${pauseNotes.map(r => textOf(r).slice(0, 100)).join(' | ')} firstWithQuestion=#${firstWithQuestion + 1} firstContinue=#${firstContinueIndex + 1}`)
const afterFirstContinue = firstContinueIndex === -1 ? undefined : requests[firstContinueIndex + 1]
check('the next continue resumes it: the request after it is held with words that name the goal', afterFirstContinue !== undefined && lastUserText(afterFirstContinue.body).startsWith(HOLD_HEAD), afterFirstContinue === undefined ? `no request after continue (index ${firstContinueIndex})` : lastUserText(afterFirstContinue.body).slice(0, 160))
const bareClaimIndex = rows.findIndex(r => r.type === 'assistant' && textOf(r).trim().endsWith(MISSION_MET_SENTINEL))
const holdAfterBareClaim = bareClaimIndex === -1 ? undefined : rows.slice(bareClaimIndex + 1).find(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
check('a reply that ends on the sentinel without the itemised criterion lines is held, not met', bareClaimIndex !== -1 && holdAfterBareClaim !== undefined && textOf(holdAfterBareClaim).includes(BARE_CLAIM_REASON) && card?.state !== 'met', `bareClaimIndex=${bareClaimIndex} hold=${holdAfterBareClaim === undefined ? 'none' : textOf(holdAfterBareClaim).slice(0, 160)} card=${card?.state}`)
check("the screen's status row reads the session's state: paused at the end, never 'active' on its own account", findRows(atEnd!.rows, INDICATOR_PAUSED).length > 0 && findRows(atEnd!.rows, INDICATOR_ACTIVE).length === 0, atEnd!.rows.filter(r => r.includes('/mission')).join(' | '))

console.log('\n── a session without a mission is untouched ──')
const plain = await plainDrive()
const plainRequests: Request[] = plain.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const plainWords = plainRequests.flatMap(r => MISSION_WORDS.filter(word => wholeBody(r.body).includes(word)))
check('a no-mission drive reached the model', plainRequests.length >= 1, `requests=${plainRequests.length} ${plain.outcome.reason ?? ''}`)
check('its request bodies carry no mission words and no status attachment', plainRequests.length >= 1 && plainWords.length === 0, `found=${JSON.stringify(plainWords)}`)
check('it writes no mission card', missionCards(join(plain.paths.home, '.mercury')).length === 0)

if (OUT !== undefined) {
  const dir = resolve(OUT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'screen-120x40-end.txt'), `${atEnd!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'cards.json'), `${JSON.stringify(cards, null, 1)}\n`)
  writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests.map((r, i) => ({ n: i + 1, goalInSystemPrompt: systemText(r.body).includes(GOAL_NEEDLE), statusAttachment: userTexts(r.body).some(t => t.includes(STATUS_HEAD)), lastUser: lastUserText(r.body).slice(0, 400) })), null, 1)}\n`)
  writeFileSync(join(dir, 'requests-full.json'), `${JSON.stringify(requests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
  writeFileSync(join(dir, 'transcript-rows.json'), `${JSON.stringify(rows.map(r => ({ type: r.type, isMeta: r.isMeta, subtype: r.subtype, level: r.level, origin: r.origin, attachment: r.attachment?.type, text: textOf(r).slice(0, 240) })), null, 1)}\n`)
  writeFileSync(join(dir, 'sends.json'), `${JSON.stringify(sendsOf(run), null, 1)}\n`)
  writeFileSync(join(dir, 'plain-requests-full.json'), `${JSON.stringify(plainRequests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
}
run.cleanup()
plain.cleanup()
console.log(`\nmission served: ${failures === 0 ? `green (${checks} checks)` : `RED (${failures}/${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
