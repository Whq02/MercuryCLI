#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { findRows, firstOutputTs, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { MISSION_MET_SENTINEL } from '../../src/guards/mission.ts'
import { compileGoal } from '../../src/services/mission/goal.ts'
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
const BARE_CLAIM = `all done.\n${MISSION_MET_SENTINEL}`
const HOLD_HEAD = `Mission not completed: ${GOAL} — `
const ASK_WORDS = 'one question to the operator'
const STATUS_HEAD = 'Mission status —'
const SECTION_HEADING = '# Mission'
const PAUSE_NOTE = 'mission paused'
const BARE_CLAIM_REASON = 'no criterion lines'
const INDICATOR_PAUSED = '/mission paused'
const INDICATOR_ACTIVE = '/mission active'
const ENDED_STATES = new Set(['needs-operator', 'stood-down'])
const MISSION_VOCABULARY = ['GOAL-MET', STATUS_HEAD, 'Mission not completed', SECTION_HEADING, PAUSE_NOTE, '/mission clear', 'hello.txt', 'without touching any other file']
const REMINDER_BLOCK = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
const CARD_SAMPLE_MS = 150

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

type Card = { sessionId: string; goal: string; state: string; iterations: number; nextStep: string | null; setAt: string; updatedAt: string }
type CardSample = { atMs: number; sessionId: string; state: string; iterations: number; nextStep: string | null }
type Screen = { atMs: number; rows: string[] }
type Row = { type?: string; isMeta?: boolean; subtype?: string; level?: string; timestamp?: string; content?: unknown; origin?: { kind?: string; command?: string }; message?: { role?: string; content?: unknown }; attachment?: { type?: string; text?: string; checks?: number; state?: string } }
type Request = { body: unknown }
type Transcript = { sessionId: string; rows: Row[] }

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
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
  const verdict = /· last verdict (none yet|[a-z]+ \(.+\)) ·/.exec(block)
  const state = /· (armed|paused)(?:\s|$|—)/.exec(block)
  return { checks: count === null ? -1 : Number(count[1]), verdict: verdict?.[1] ?? '?', state: state?.[1] ?? '?', line: block }
}
const STALL_VERDICT = /^unattainable \(3 checks in a row changed nothing/
function goalServed(system: string): boolean {
  return system.includes(SECTION_HEADING) && system.includes(`Goal: ${COMPILED.endState}`) && CRITERIA.every((criterion, i) => system.includes(`${i + 1}. ${criterion}`))
}
const continuesIn = (r: Request): number => userTexts(r.body).filter(t => operatorWords(t) === 'continue').length

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

const arena = (turns: string[], sends: Array<Record<string, unknown>>, seconds: number): Promise<ArenaRun> =>
  runArtifactArena({
    turns: turns.map(text => ({ kind: 'text' as const, text })),
    sends: sends as never,
    seconds,
    cols: 120,
    rows: 40,
    keep: true,
    ...(DIST !== undefined ? { distPath: resolve(DIST) } : {}),
  })

const missionTurns = [WORKING, WORKING, WORKING, QUESTION, WORKING, WORKING, WORKING, WORKING, ...Array.from({ length: 24 }, () => WORKING)]
const missionSends = [
  { awaitText: 'Type a prompt', settleMs: 1200, text: `/mission ${GOAL}\r` },
  { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
  { awaitText: ' ready · ', afterPrevMs: 4000, settleMs: 400, text: 'continue\r' },
]
const bareTurns = [BARE_CLAIM, ...Array.from({ length: 12 }, () => WORKING)]
const bareSends = [{ awaitText: 'Type a prompt', settleMs: 1200, text: `/mission ${GOAL}\r` }]
const plainSends = [{ awaitText: 'Type a prompt', settleMs: 1200, text: 'hello\r' }]

console.log('============================================================')
console.log(' /mission typed on the screen: the goal is served every turn, a bare continue included')
console.log('============================================================')
console.log(`build under proof: ${DIST !== undefined ? resolve(DIST) : 'this tree'}`)
console.log(`goal: ${GOAL}\ncriteria: ${JSON.stringify(CRITERIA)}`)

const watch = watchCards(Date.now())
const run = await arena(missionTurns, missionSends, 36)
const cardTimeline = watch.stop()
const configDir = join(run.paths.home, '.mercury')
const continueEpochs = sendEpochs(run, 'continue')
check('the capture ran to its end: complete, every step fired, three sends (/mission, continue, continue)', complete(run, 3) && continueEpochs.length === 2, runWords(run))
if (sendEpochs(run, '/mission the file').length === 0) {
  console.log(`\nmission served: RED (${failures}/${checks}) — the command never fired`)
  process.exit(1)
}
const [atEnd] = screensAt(run, 120, 40, [-1])
const requests: Request[] = run.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const transcripts = await transcriptsUnder(configDir)
const hosted = transcripts.find(t => t.rows.some(r => r.type === 'user' && r.isMeta === true && textOf(r).includes('A standing goal is now active')))
const rows = hosted?.rows ?? []
const cards = cardsUnder(configDir)
const card = hosted === undefined ? undefined : cards.find(c => c.sessionId === hosted.sessionId)
const timeline = hosted === undefined ? [] : cardTimeline.filter(s => s.sessionId === hosted.sessionId)
const assistantRows = rows.filter(r => r.type === 'assistant')
const holdRows = rows.filter(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
const ordinaryHolds = holdRows.filter(r => !textOf(r).includes(ASK_WORDS))
const askHolds = holdRows.filter(r => textOf(r).includes(ASK_WORDS))
const pauseNotes = rows.filter(r => r.type === 'system' && textOf(r).includes(PAUSE_NOTE))
const firstContinueEpoch = continueEpochs[0] ?? Number.POSITIVE_INFINITY
const secondContinueEpoch = continueEpochs[1] ?? Number.POSITIVE_INFINITY
console.log(`  hosted=${hosted?.sessionId.slice(0, 8) ?? 'none'} requests=${requests.length} holds=${holdRows.length} (ordinary ${ordinaryHolds.length}, asks ${askHolds.length}) pauseNotes=${pauseNotes.length} assistantRows=${assistantRows.length} card=${JSON.stringify(card === undefined ? null : { state: card.state, iterations: card.iterations, nextStep: (card.nextStep ?? '').slice(0, 80) })}`)
console.log(`  card timeline: ${timeline.map(s => `${s.state}@${s.iterations}`).join(' → ') || '(no samples)'}`)
for (const [i, r] of requests.entries()) {
  const status = statusOf(lastUserText(r.body))
  console.log(`    #${i + 1} goalServed=${goalServed(systemText(r.body))} continues=${continuesIn(r)} status=${status === null ? 'none' : `${status.checks}/${status.state}`} last=${JSON.stringify(operatorWords(lastUserText(r.body)).slice(0, 80))}`)
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
check("a one-line mission status rides each turn's opening message as a system-reminder attachment with the current fields: checks 0 · none yet · armed at arming, checks 3 · the stall verdict · armed on the first continue, checks 6 · the stall verdict · armed on the second", statuses.length === 3 && statuses.every(s => s !== null && !s.line.includes('\n')) && statuses[0]?.checks === 0 && statuses[0]?.verdict === 'none yet' && statuses[0]?.state === 'armed' && statuses[1]?.checks === 3 && STALL_VERDICT.test(statuses[1]?.verdict ?? '') && statuses[1]?.state === 'armed' && statuses[2]?.checks === 6 && STALL_VERDICT.test(statuses[2]?.verdict ?? '') && statuses[2]?.state === 'armed', JSON.stringify(statuses.map(s => (s === null ? null : `${s.checks}/${s.verdict.slice(0, 40)}/${s.state}: ${s.line.slice(0, 100)}`))))
check('each status line is bound to a mission_status attachment record in the hosted transcript with the same text, checks and state (one per turn, none other)', statusRecords.length === 3 && statuses.every(s => s !== null && statusRecords.some(r => r.attachment?.text === s.line && r.attachment?.checks === s.checks && r.attachment?.state === s.state)), `records=${JSON.stringify(statusRecords.map(r => ({ text: r.attachment?.text?.slice(0, 80), checks: r.attachment?.checks, state: r.attachment?.state })))}`)
const holdForm = new RegExp(`^${HOLD_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.+\\. Continue\\.$`)
check('a turn that ends before the mission is met is held with one line of the form "Mission not completed: <goal> — <what is open>. Continue." (two per turn here, six in all)', ordinaryHolds.length === 6 && ordinaryHolds.every(r => holdForm.test(textOf(r).trim())), `ordinary=${ordinaryHolds.length} ${ordinaryHolds.map(r => textOf(r).split('\n')[0]!.slice(0, 120)).join(' | ')}`)
check('the third check of each turn is the ask: the hold names the goal and the stall, and asks for one question to the operator (three in all)', askHolds.length === 3 && askHolds.every(r => textOf(r).startsWith(`${HOLD_HEAD}3 checks in a row changed nothing`)), askHolds.map(r => textOf(r).split('\n')[0]!.slice(0, 120)).join(' | '))
const beforeContinue = timeline.filter(s => s.atMs < firstContinueEpoch)
const afterThirdCheck = beforeContinue.filter(s => s.iterations >= 3)
check("after three non-itemised replies the hosted session's card is still standing: every sample before the first continue reads armed or paused, none needs-operator or stood-down, and the card is bound to the hosted session", hosted !== undefined && card !== undefined && afterThirdCheck.length >= 1 && timeline.every(s => s.state === 'armed' || s.state === 'paused') && !timeline.some(s => ENDED_STATES.has(s.state)), `timeline=${JSON.stringify(timeline.map(s => `${s.state}@${s.iterations}`))}`)
const pausedOnQuestion = beforeContinue.find(s => s.state === 'paused' && (s.nextStep ?? '').includes(QUESTION))
const firstWithQuestion = requests.findIndex(r => messagesOf(r.body).some(m => m.role === 'assistant' && flat(m.content).includes(QUESTION)))
check('the question pauses the mission: the persisted card reads paused with the question before the first continue, the note on screen names it, and no request follows the question until the operator speaks', pausedOnQuestion !== undefined && pauseNotes.length >= 1 && textOf(pauseNotes[0]!).includes(QUESTION) && stampOf(pauseNotes[0]!) < firstContinueEpoch && firstWithQuestion !== -1 && firstWithQuestion === firstContinueIndex, `paused=${JSON.stringify(pausedOnQuestion ?? null)} notes=${pauseNotes.map(r => textOf(r).slice(0, 90)).join(' | ')} firstWithQuestion=#${firstWithQuestion + 1} firstContinue=#${firstContinueIndex + 1}`)
const resumed = timeline.find(s => s.atMs >= firstContinueEpoch && s.atMs < secondContinueEpoch && s.state === 'armed')
const afterFirstContinue = firstContinueIndex === -1 ? undefined : requests[firstContinueIndex + 1]
check('the next continue resumes it: the card returns to armed (resumed) and the request after the continue is held with words that name the goal', resumed !== undefined && afterFirstContinue !== undefined && operatorWords(lastUserText(afterFirstContinue.body)).startsWith(HOLD_HEAD), `resumed=${JSON.stringify(resumed ?? null)} after=${afterFirstContinue === undefined ? 'none' : operatorWords(lastUserText(afterFirstContinue.body)).slice(0, 120)}`)
check("the screen's status row reads the session's state: paused at the end, never 'active' on its own account", findRows(atEnd!.rows, INDICATOR_PAUSED).length > 0 && findRows(atEnd!.rows, INDICATOR_ACTIVE).length === 0, atEnd!.rows.filter(r => r.includes('/mission')).join(' | '))

console.log('\n── a bare completion line as the first reply ──')
const bare = await arena(bareTurns, bareSends, 14)
const bareConfig = join(bare.paths.home, '.mercury')
const bareTranscript = (await transcriptsUnder(bareConfig)).find(t => t.rows.some(r => r.type === 'assistant'))
const bareRows = bareTranscript?.rows ?? []
const bareCard = bareTranscript === undefined ? undefined : cardsUnder(bareConfig).find(c => c.sessionId === bareTranscript.sessionId)
const bareClaimIndex = bareRows.findIndex(r => r.type === 'assistant' && textOf(r).trim().endsWith(MISSION_MET_SENTINEL))
const holdAfterBareClaim = bareClaimIndex === -1 ? undefined : bareRows.slice(bareClaimIndex + 1).find(r => r.type === 'user' && r.isMeta === true && textOf(r).startsWith(HOLD_HEAD))
check('the bare-sentinel leg ran to its end and the bare completion line was delivered as the first reply', complete(bare, 1) && bareClaimIndex !== -1 && bareRows.slice(0, bareClaimIndex).every(r => r.type !== 'assistant'), `${runWords(bare)} bareClaimIndex=${bareClaimIndex}`)
check('a reply that ends on the sentinel without the itemised criterion lines is held, not met: the hold names the missing lines and the card never reads met', holdAfterBareClaim !== undefined && textOf(holdAfterBareClaim).includes(BARE_CLAIM_REASON) && bareCard !== undefined && bareCard.state !== 'met', `hold=${holdAfterBareClaim === undefined ? 'none' : textOf(holdAfterBareClaim).slice(0, 160)} card=${JSON.stringify(bareCard ?? null)}`)

console.log('\n── a session without a mission is untouched ──')
check('without a mission the section is null, its key is off, and the status producer yields nothing', missionSection(undefined) === null && missionSectionKey(undefined) === 'off' && getMissionStatusAttachment([]).length === 0)
const plain = await arena([WORKING, WORKING], plainSends, 12)
const plainRequests: Request[] = plain.fixture.messageRequests().filter(r => !r.path.includes('count_tokens'))
const plainRows = (await transcriptsUnder(join(plain.paths.home, '.mercury'))).flatMap(t => t.rows)
const plainSections = plainRequests.filter(r => systemText(r.body).includes(SECTION_HEADING))
const plainStatuses = plainRequests.filter(r => userTexts(r.body).some(t => reminderBlocks(t).some(b => b.startsWith(STATUS_HEAD))))
const plainStatusRecords = plainRows.filter(r => r.type === 'attachment' && r.attachment?.type === 'mission_status')
const plainWords = plainRequests.flatMap(r => MISSION_VOCABULARY.filter(word => JSON.stringify(r.body).includes(word)))
check('the no-mission drive ran to its end and reached the model', complete(plain, 1) && plainRequests.length >= 1, `${runWords(plain)} requests=${plainRequests.length}`)
check('its system prompt carries no Mission section, its messages no status reminder, and its transcript no mission_status record', plainRequests.length >= 1 && plainRows.length > 0 && plainSections.length === 0 && plainStatuses.length === 0 && plainStatusRecords.length === 0, `rows=${plainRows.length} sections=${plainSections.length} statuses=${plainStatuses.length} records=${plainStatusRecords.length}`)
check('its request bodies carry none of the mission vocabulary', plainRequests.length >= 1 && plainWords.length === 0, `found=${JSON.stringify(plainWords)}`)
check('it writes no mission card', cardsUnder(join(plain.paths.home, '.mercury')).length === 0)

if (OUT !== undefined) {
  const dir = resolve(OUT)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'screen-120x40-end.txt'), `${atEnd!.rows.join('\n')}\n`)
  writeFileSync(join(dir, 'cards.json'), `${JSON.stringify(cards, null, 1)}\n`)
  writeFileSync(join(dir, 'card-timeline.json'), `${JSON.stringify(cardTimeline.map(s => ({ ...s, at: new Date(s.atMs).toISOString() })), null, 1)}\n`)
  writeFileSync(join(dir, 'sends.json'), `${JSON.stringify(run.sendLog.map(s => ({ at: new Date(s.sent).toISOString(), text: Buffer.from(s.b64, 'base64').toString('utf8').replace(/\r/g, '⏎') })), null, 1)}\n`)
  writeFileSync(join(dir, 'requests.json'), `${JSON.stringify(requests.map((r, i) => ({ n: i + 1, goalServed: goalServed(systemText(r.body)), status: statusOf(lastUserText(r.body)), operatorWords: operatorWords(lastUserText(r.body)).slice(0, 400) })), null, 1)}\n`)
  writeFileSync(join(dir, 'requests-full.json'), `${JSON.stringify(requests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
  writeFileSync(join(dir, 'transcript-rows.json'), `${JSON.stringify(rows.map(r => ({ at: r.timestamp, type: r.type, isMeta: r.isMeta, subtype: r.subtype, level: r.level, origin: r.origin, attachment: r.attachment?.type, text: textOf(r).slice(0, 240) })), null, 1)}\n`)
  writeFileSync(join(dir, 'bare-transcript-rows.json'), `${JSON.stringify(bareRows.map(r => ({ at: r.timestamp, type: r.type, isMeta: r.isMeta, text: textOf(r).slice(0, 240) })), null, 1)}\n`)
  writeFileSync(join(dir, 'bare-card.json'), `${JSON.stringify(bareCard ?? null, null, 1)}\n`)
  writeFileSync(join(dir, 'plain-requests-full.json'), `${JSON.stringify(plainRequests.map(r => ({ system: systemText(r.body), messages: messagesOf(r.body).map(m => ({ role: m.role, content: flat(m.content).slice(0, 2000) })) })), null, 1)}\n`)
}
run.cleanup()
bare.cleanup()
plain.cleanup()
console.log(`\nmission served: ${failures === 0 ? `green (${checks} checks)` : `RED (${failures}/${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
