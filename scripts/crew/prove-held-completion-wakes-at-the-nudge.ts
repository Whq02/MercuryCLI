#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const tally = makeTally('prove-held-completion-wakes-at-the-nudge')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const MAIN_ASK = 'notes probe: start the background crewmate and do not wait for it; I will pass its report on when it arrives'
const AGENT_PROMPT = 'the background crewmate of the notes probe'
const AGENT_DONE = 'line 3: TODO: item 2'
const RELAYED = 'the crewmate reported:'
const CREWMATE_SECONDS = 4
const DEADLINE_MS = 1_000

type Frame = Record<string, unknown> & { atMs: number }

const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'held-completion-nudge-')))
const cwd = join(runHome, 'work')
const t0 = Date.now()
let notificationTurns = 0
let nudgeTurns = 0
let followUpNotificationsInHistory = 0
let followUpNudgesInHistory = 0
const FOLLOW_UP = 'operator follow-up after the nudge'
const FOLLOW_UP_ACK = 'follow-up acknowledged'
const fixture: ScriptedFixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
  if (req.opening.trim() === AGENT_PROMPT) {
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${CREWMATE_SECONDS}`, description: 'the crewmate sleeps' } }]
    return [{ type: 'text', text: AGENT_DONE }]
  }
  if (req.ask.includes(FOLLOW_UP)) {
    followUpNotificationsInHistory = req.allTexts.filter(t => t.includes('<task-notification>')).length
    followUpNudgesInHistory = req.allTexts.filter(t => t.includes('waited unread')).length
    return [{ type: 'text', text: FOLLOW_UP_ACK }]
  }
  if (req.allTexts.some(text => text.includes('waited unread'))) {
    nudgeTurns++
    return [{ type: 'text', text: 'nudge settled' }]
  }
  if (req.ask.includes('<task-notification>')) {
    notificationTurns++
    const carried = req.allTexts.some(text => text.includes(AGENT_DONE))
    return [{ type: 'text', text: carried ? `${RELAYED} ${AGENT_DONE}` : 'a wake with no report in hand' }]
  }
  if (req.opening.trim() !== MAIN_ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) {
    return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'notes2 with sleep', prompt: AGENT_PROMPT, run_in_background: true } }]
  }
  return [{ type: 'text', text: 'the crewmate runs in the background; I will not wait for it' }]
})
seedScratchHome(runHome, cwd)
const port = Number(new URL(fixture.base).port)

const frames: Frame[] = []
let stderr = ''
const host = hostRunner({
  node: NODE,
  dist: DIST,
  argv: ['--model', MODEL, '--mode', 'sovereign', '--sovereign'],
  cwd,
  env: { ...childEnv(runHome, port), MERCURY_NOTICE_DEADLINE_MS: String(DEADLINE_MS) } as Record<string, string | undefined>,
  home: runHome,
  onRow: frame => {
    frames.push({ ...frame, atMs: Date.now() })
  },
})
host.child.stderr!.on('data', (chunk: Buffer) => {
  stderr += chunk.toString('utf8')
})
void host.initialize().catch(() => undefined)

const until = async (label: string, pred: () => boolean, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(50)
  }
  console.log(`  (gave up waiting for ${label})`)
  return false
}
const seconds = (ms: number | undefined): string => (ms === undefined ? 'never' : `${((ms - t0) / 1000).toFixed(2)}s`)
const turnRows = (): Frame[] => frames.filter(f => f.type === 'turn' && f.state === 'started')
const waitingRow = (): Frame | undefined => frames.find(f => f.type === 'turn' && f.state === 'waiting')
const relayed = (): Frame | undefined => frames.find(f => f.type === 'text' && f.parent_call_id === undefined && JSON.stringify(f).includes(RELAYED))
const taskEnded = (): Frame | undefined => frames.find(f => f.type === 'task' && f.state === 'ended')

void host.prompt(MAIN_ASK, { id: randomUUID() }).catch(() => undefined)
const launched = await until('the lead to answer and park on its background crewmate', () => frames.some(f => f.type === 'text' && JSON.stringify(f).includes('runs in the background')) && waitingRow() !== undefined, vshotBudgetMs(40_000))
const escAt = Date.now()
const interrupted = await host.request('turn/interrupt', { by: 'operator', clientOpId: randomUUID() }, 10_000).catch(() => null)
const idle = await until('the lead to go idle after esc (the parked turn\'s outcome lands)', () => frames.some(f => f.type === 'outcome' && f.atMs >= escAt), vshotBudgetMs(15_000))
const turnsBeforeCompletion = turnRows().length
const ended = await until('the crewmate to finish', () => taskEnded() !== undefined, vshotBudgetMs((CREWMATE_SECONDS + 20) * 1000))
const endedAt = taskEnded()?.atMs
const woke = await until('the lead to wake with the report', () => relayed() !== undefined, vshotBudgetMs(DEADLINE_MS + 12_000))
const wokeAt = relayed()?.atMs
await sleep(DEADLINE_MS + 400)
void host.prompt(FOLLOW_UP, { id: randomUUID() }).catch(() => undefined)
const followedUp = await until('the operator follow-up to settle', () => frames.some(f => f.type === 'text' && f.parent_call_id === undefined && JSON.stringify(f).includes(FOLLOW_UP_ACK)), vshotBudgetMs(15_000))
await sleep(200)
host.end()
await Promise.race([host.exited, sleep(5_000)])
try {
  host.child.kill('SIGKILL')
} catch {
}
await fixture.close()

const leadTurnsAfterCompletion = turnRows().filter(f => endedAt !== undefined && f.atMs >= endedAt)
const relayedFrames = frames.filter(f => f.type === 'text' && f.parent_call_id === undefined && JSON.stringify(f).includes(RELAYED))
console.log(`  timeline: esc ${seconds(escAt)} · crewmate ended ${seconds(endedAt)} · lead woke with the report ${seconds(wokeAt)} · turns ${turnRows().map(f => seconds(f.atMs)).join(', ')}`)
console.log(`  interrupt answer: ${JSON.stringify(interrupted)} · frames ${frames.length}`)

tally.section("a background crewmate's report held by the esc law reaches the lead at the nudge deadline, not at the next keystroke")
tally.check('the lead launched the crewmate in the background and parked on it', launched, `launched ${launched}`)
tally.check('esc ended the park and the lead went idle while the crewmate ran on', idle && interrupted !== null, `idle ${idle} interrupt ${JSON.stringify(interrupted)}`)
tally.check('the crewmate finished while the lead was idle', ended && endedAt !== undefined && endedAt > escAt, `ended ${seconds(endedAt)}`)
tally.check('no turn started between the esc and the completion (the esc law stands inside the deadline)', turnRows().filter(f => f.atMs > escAt + 500 && (endedAt === undefined || f.atMs < endedAt)).length === 0, turnRows().map(f => seconds(f.atMs)).join(', '))
tally.check('after the completion, the esc hold kept the report held until the nudge deadline', endedAt !== undefined && leadTurnsAfterCompletion[0] !== undefined && leadTurnsAfterCompletion[0].atMs - endedAt >= DEADLINE_MS - 150, `ended ${seconds(endedAt)} · first wake turn ${seconds(leadTurnsAfterCompletion[0]?.atMs)}`)
tally.check('the lead woke with the report in hand without any keystroke', woke && relayed() !== undefined, woke ? '' : `no relay; last frames ${frames.slice(-4).map(f => `${String(f.type)}${f.state !== undefined ? `:${String(f.state)}` : ''}`).join(' ')}`)
tally.check(`the wake came within the deadline plus the poll window (${DEADLINE_MS} ms + a few seconds)`, endedAt !== undefined && wokeAt !== undefined && wokeAt - endedAt <= vshotBudgetMs(DEADLINE_MS + 8_000), `ended ${seconds(endedAt)} · woke ${seconds(wokeAt)}`)
tally.check('the wake was its own turn (a turn started after the completion)', leadTurnsAfterCompletion.length >= 1 && turnRows().length > turnsBeforeCompletion, `turns after completion: ${leadTurnsAfterCompletion.length}`)
tally.check('the held report was delivered once at the nudge and never a second time on a later sweep or operator turn', followedUp && notificationTurns === 1 && nudgeTurns === 1 && followUpNotificationsInHistory === 1 && followUpNudgesInHistory === 1 && relayedFrames.length === 1, `notificationTurns=${notificationTurns} nudgeTurns=${nudgeTurns} inHistory=${followUpNotificationsInHistory}/${followUpNudgesInHistory} relayedFrames=${relayedFrames.length}`)
tally.check('no runner error on stderr', !/error|exception/i.test(stderr), stderr.slice(0, 300))

tally.section('the seam: the nudge is the operator stand-in the driver waits for')
{
  const { readFileSync } = await import('node:fs')
  const driver = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'headless', 'turnDriver.ts'), 'utf8')
  const run = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'run.ts'), 'utf8')
  tally.check("the driver has a door that ends the operator wait and kicks", driver.includes('endOperatorWait'))
  tally.check("the idle nudge's wake opens that door before it queues the nudge", /wake: \(agentId, notices\) => \{[\s\S]{0,600}driver\.endOperatorWait\(\)/.test(run))
}

tally.finish()
