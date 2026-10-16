#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, MODEL, NODE, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const tally = makeTally('prove-message-reaches-past-foreground-crewmate')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const ROOT = join(import.meta.dir, '..', '..')
const MAIN_ASK = 'delegation probe: hand the probe to a crewmate and wait for it'
const AGENT_PROMPT = 'the crewmate of the delegation probe'
const MESSAGE = 'the operator says: the tide is turning, read this now'
const HEARD = 'heard the operator:'
const NOT_YET = 'no operator message in hand'
const AGENT_DONE = 'the crewmate is done'
const HOLD_SECONDS = 12
const RECEIPT_WORDS = 'the operator sent a message while the crewmate held the turn'

type Frame = Record<string, unknown> & { atMs: number }

const runHome = realpathSync(mkdtempSync(join(tmpdir(), 'message-past-crewmate-')))
const cwd = join(runHome, 'work')
const t0 = Date.now()
let crewmateHeld = false
const fixture: ScriptedFixture = await startScriptedFixture((req: ScriptedRequest): WireBlock[] => {
  if (req.opening.trim() === AGENT_PROMPT) {
    if (req.step === 0) {
      crewmateHeld = true
      return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${HOLD_SECONDS}`, description: 'the crewmate holds the foreground' } }]
    }
    return [{ type: 'text', text: AGENT_DONE }]
  }
  if (req.ask.includes('<task-notification>')) return [{ type: 'text', text: 'noted' }]
  if (req.opening.trim() !== MAIN_ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0 && req.ask.trim() === MAIN_ASK) {
    return [{ type: 'tool_use', name: 'Crewmate', input: { description: 'the delegation probe', prompt: AGENT_PROMPT } }]
  }
  const carried = req.allTexts.some(text => text.includes(MESSAGE))
  return [{ type: 'text', text: carried ? `${HEARD} ${MESSAGE}` : NOT_YET }]
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
  env: childEnv(runHome, port) as Record<string, string | undefined>,
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

void host.prompt(MAIN_ASK, { id: randomUUID() }).catch(() => undefined)
const held = await until('the crewmate to take the foreground', () => crewmateHeld, vshotBudgetMs(40_000))
await sleep(1_000)
const sentAtMs = Date.now()
void host.prompt(MESSAGE, { id: randomUUID() }).catch(() => undefined)

const taskEnded = (f: Frame): boolean => f.type === 'task' && f.state === 'ended'
const mainText = (f: Frame): boolean => f.type === 'text' && f.parent_call_id === undefined
const heardFrame = (): Frame | undefined => frames.find(f => mainText(f) && JSON.stringify(f).includes(HEARD))
await until('the main agent to speak after the message', () => heardFrame() !== undefined, vshotBudgetMs((HOLD_SECONDS + 20) * 1000))
await until('the crewmate to end', () => frames.some(taskEnded), vshotBudgetMs((HOLD_SECONDS + 20) * 1000))
await sleep(1_500)
host.end()
await Promise.race([host.exited, sleep(5_000)])
try {
  host.child.kill('SIGKILL')
} catch {
}
await fixture.close()

const heard = heardFrame()
const notYet = frames.find(f => mainText(f) && JSON.stringify(f).includes(NOT_YET))
const ended = frames.find(taskEnded)
const mainSteps = fixture.requests.filter(r => r.opening.trim() === MAIN_ASK)
const afterCrewmate = mainSteps.find(r => r.step === 1)
const crewmateResult = afterCrewmate?.results[0]?.text ?? ''
const crewmateRequests = fixture.requests.filter(r => r.opening.trim() === AGENT_PROMPT)
const turnsStartedBeforeHeard = frames.filter(f => f.type === 'turn' && f.state === 'started' && heard !== undefined && f.atMs <= heard.atMs).length
const seconds = (ms: number | undefined): string => (ms === undefined ? 'never' : `${((ms - t0) / 1000).toFixed(2)}s`)
console.log(`  timeline: message sent ${seconds(sentAtMs)} · main spoke ${seconds(heard?.atMs)} · crewmate ended ${seconds(ended?.atMs)}`)
console.log(`  main requests: ${mainSteps.map(r => `step ${r.step} @${seconds(r.atMs)} ask=${JSON.stringify(r.ask.slice(0, 60))}`).join(' · ')}`)
console.log(`  crewmate result as the model read it: ${JSON.stringify(crewmateResult.slice(0, 400))}`)

tally.section('a message typed while a foreground crewmate holds the turn reaches the model before the crewmate ends')
tally.check('the crewmate took the foreground and held it', held && crewmateRequests.length >= 1)
tally.check('the main agent read the operator\'s message and answered it', heard !== undefined && notYet === undefined, heard === undefined ? `no reply carrying "${HEARD}"${notYet !== undefined ? ' — the model answered without the message' : ''}` : '')
tally.check('the answer landed BEFORE the crewmate ended (the message did not wait on the crewmate)', heard !== undefined && ended !== undefined && heard.atMs < ended.atMs, `main spoke ${seconds(heard?.atMs)} · crewmate ended ${seconds(ended?.atMs)}`)
tally.check('the message rode the live turn: no turn of its own was started for it', heard !== undefined && turnsStartedBeforeHeard === 1, `turns started before the answer: ${turnsStartedBeforeHeard}`)
tally.check('the Crewmate receipt says the crewmate went to the background because the operator sent a message', crewmateResult.includes('Crewmate launched in the background') && crewmateResult.includes(RECEIPT_WORDS), crewmateResult.slice(0, 300))
tally.check('the operator\'s words reached the model as the queued line of the same turn', afterCrewmate !== undefined && afterCrewmate.allTexts.some(text => text.includes(MESSAGE)), afterCrewmate === undefined ? 'no second request of the main turn' : afterCrewmate.ask.slice(0, 120))
tally.check('the crewmate ran on in the background to its own end', crewmateRequests.some(r => r.step === 1) && ended !== undefined, `crewmate requests ${crewmateRequests.length} · ended ${seconds(ended?.atMs)}`)

tally.section('the seam, structural')
{
  const run = readFileSync(join(ROOT, 'src/cli/run.ts'), 'utf8')
  const tasks = readFileSync(join(ROOT, 'src/tasks/LocalAgentTask/LocalAgentTask.tsx'), 'utf8')
  const receipts = readFileSync(join(ROOT, 'src/tasks/LocalAgentTask/launchReceipts.ts'), 'utf8')
  const queue = readFileSync(join(ROOT, 'src/input-core/command-queue.ts'), 'utf8')
  tally.check('the runner door hands the foreground crewmates over on a human prompt mid-turn, never on a Tab-held line, a cron wake or a held seat verb', run.includes("if (input.kind === 'prompt' && input.priority !== 'later' && !('origin' in saturnQueueStamp(input.origin)) && driver.isRunning() && !queuedWordsWaitForTurnEnd()) {") && run.includes('handOverForegroundAgentsToQueuedMessage(getAppState, setAppState)'))
  tally.check('the handover is the ctrl+b transition with its reason stamped on the task', tasks.includes('export function handOverForegroundAgentsToQueuedMessage(') && tasks.includes("handoverReason: 'message-queued'") && tasks.includes('backgroundAgentTask(task.id, getAppState, setAppState)'))
  tally.check('the receipt names the reason in the operator\'s terms', receipts.includes("case 'message-queued':") && receipts.includes(RECEIPT_WORDS))
  tally.check('the drain scoping is untouched: a subagent never drains user prompts', readFileSync(join(ROOT, 'src/run-core/attachment-drain.ts'), 'utf8').includes("return cmd.mode === 'task-notification' && cmd.agentId === scope.agentId"))
  tally.check('the turn-end hold is readable at the door', queue.includes('export function queuedWordsWaitForTurnEnd(): boolean'))
}

if (tally.failed() === 0) rmSync(runHome, { recursive: true, force: true })
else console.log(`  world kept: ${runHome}\n  stderr tail: ${stderr.slice(-800)}`)
tally.finish()
