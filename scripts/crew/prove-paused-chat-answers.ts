#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import type { Frame } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { closeWorld, DIST, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, NODE, record, sleep, TURN_MS } from './crew-world.ts'
import { CANCEL_MESSAGE } from '../../src/utils/messages/rejectionText.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const peerModel = 'claude-opus-4-6'
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6' }) as ScriptedTurn
const LAUNCH = 'Launch the lane.'
const OBJECTION = 'Not in part: research the proper way, and I did not say launch a lane.'
const DEMAND = 'Answer me.'
const CARRY = 'Carry on with the check.'
const GO_ON = 'Go on.'
const ANSWER = 'ANSWERED-AFTER-THE-PAUSE'
const CARRIED = 'CARRIED-THROUGH-THE-PARK'
const GONE_ON = 'GONE-ON-AFTER-THE-PARK'
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Crewmate', input: { name: 'lane', run_in_background: true, model: peerModel, crewmate_type: 'mercury-crew', description: 'Lane fold-over-window', prompt: 'Read the brief whole, then report.' } }),
  lead({ kind: 'paced', deltas: ['The lane is launched', '.', '.', '.', '.', '.', '.', '.', '.', '.'], gapMs: 300 }),
  lead({ kind: 'paced_tool_use', preDeltas: ['Stopping it', '.', '.', '.', '.', '.', '.', '.'], gapMs: 300, tools: [{ name: 'ToolSearch', input: { query: 'select:TaskStop' } }] }),
  lead({ kind: 'text', text: ANSWER }),
  lead({ kind: 'paced_tool_use', preDeltas: ['Checking', '.', '.', '.', '.', '.', '.', '.'], gapMs: 300, tools: [{ name: 'Bash', input: { command: `printf ${CARRIED}`, description: 'The check' } }] }),
  lead({ kind: 'text', text: GONE_ON }),
  ...Array.from({ length: 4 }, () => lead({ kind: 'text', text: GONE_ON })),
  peer({ kind: 'paced', deltas: Array.from({ length: 60 }, (_, i) => (i === 0 ? 'Reading the brief' : '.')), gapMs: 1000 }),
  peer({ kind: 'text', text: 'LANE-DONE' }),
]
const tally = makeTally('prove-paused-chat-answers')
const world = await makeWorld('paused-chat-answers', script)
const frames: Frame[] = []
let rowsOut = ''
let leadErr = ''
const refusals: string[] = []
const host = hostRunner({
  node: NODE,
  dist: DIST,
  argv: ['--model', LEAD_MODEL, '--allowed-tools', 'Crewmate', 'ToolSearch', 'Bash', '--mode', 'sovereign'],
  cwd: world.project,
  env: world.env as Record<string, string | undefined>,
  home: world.env.MERCURY_CONFIG_DIR ?? world.project,
  raw: text => {
    rowsOut += text
  },
  onRow: frame => frames.push(frame),
})
host.child.stderr!.on('data', (chunk: Buffer) => {
  leadErr += chunk.toString('utf8')
})
void host.initialize().catch(() => undefined)
const wire = host.peer
let leadDone = false
const leadExited = new Promise<number | null>(resolveExit => host.child.on('close', code => {
  leadDone = true
  resolveExit(code)
}))
const submit = (text: string): void => {
  wire.request('queue/add', { type: 'prompt', content: text }, { deadlineMs: TURN_MS }).catch((error: unknown) => {
    refusals.push(`queue/add: ${error instanceof Error ? error.message : String(error)}`)
  })
}
const waitFor = async (label: string, test: () => boolean, timeoutMs = TURN_MS): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (leadDone || Date.now() >= deadline) {
      console.log(`  [WAIT TIMEOUT] ${label}\n--- rows tail ---\n${rowsOut.slice(-1200)}\n--- stderr tail ---\n${leadErr.slice(-800)}\n--- queue ---\n${refusals.join('\n')}`)
      return false
    }
    await sleep(25)
  }
  return true
}
const terminate = async (): Promise<number | null> => {
  host.child.kill('SIGTERM')
  const code = await Promise.race([leadExited, sleep(60_000).then(() => null)])
  if (!leadDone) host.child.kill('SIGKILL')
  host.peer.close('the proof ended')
  return code
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const requestsOf = (model: string): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === model)
const leadRequests = (): Request[] => requestsOf(LEAD_MODEL)
const lastUserOf = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const requestCarrying = (words: string, from = 0): Request | undefined => leadRequests().slice(from).find(request => lastUserOf(request).includes(words))
const toolCallRow = (tool: string): Frame | undefined => frames.find(frame => frame.type === 'tool_call' && frame.tool === tool)
const toolResultRow = (callId: unknown): Frame | undefined => frames.find(frame => frame.type === 'tool_result' && frame.call_id === callId)
const taskEnded = (taskId: unknown): boolean => frames.some(frame => frame.type === 'task' && frame.state === 'ended' && frame.task_id === taskId)
const outcomes = (): Frame[] => frames.filter(frame => frame.type === 'outcome')
const textLanded = (words: string): boolean => frames.some(frame => frame.type === 'text' && typeof frame.text === 'string' && frame.text.includes(words))
const gateFacts = async (): Promise<{ paused: boolean; parked: number } | null> => {
  const facts = (await wire.request('session/facts', {}, { deadlineMs: 15_000 }).catch(() => null)) as { pause_gate?: { paused: boolean; parked: number } } | null
  return facts?.pause_gate ?? null
}
const interrupt = (): Promise<{ interrupted: boolean } | null> => wire.request('turn/interrupt', {}, { deadlineMs: 10_000 }).catch(() => null) as Promise<{ interrupted: boolean } | null>
const pauseGate = (paused: boolean): Promise<{ paused: boolean; parked: number; changed: boolean } | null> =>
  wire.request('session/pause_gate', { paused }, { deadlineMs: 10_000 }).catch(() => null) as Promise<{ paused: boolean; parked: number; changed: boolean } | null>
const clock = (): string => new Date().toISOString().slice(11, 23)
const ANSWER_WINDOW_MS = 10_000
const PARK_WINDOW_MS = 1_500

try {
  tally.section('S1 THE OWNER\'S STRETCH — a background crewmate, an Esc within a second, the crew view\'s p during the next stream, the parked tool, the Esc, the prompt')
  submit(LAUNCH)
  const launched = await waitFor('the lead did not launch the crewmate and continue', () => requestsOf(peerModel).length >= 1 && leadRequests().length >= 2, TURN_MS)
  const started = frames.find(frame => frame.type === 'task' && frame.state === 'started' && frame.task_type === 'local_agent')
  const taskId = started?.task_id
  tally.check('the fixture starts a real background crewmate and the lead\'s turn runs on (its second request streams)', launched && typeof taskId === 'string', JSON.stringify({ launched, taskId, lead: leadRequests().length, peer: requestsOf(peerModel).length }))
  if (typeof taskId !== 'string') throw new Error('the fixture has no crewmate task id')
  console.log(`  ${clock()} interrupt (Esc) within a second of the launch`)
  const firstEsc = await interrupt()
  const firstTurnEnded = await waitFor('the interrupted lead turn did not settle', () => outcomes().length >= 1, TURN_MS)
  await sleep(1_000)
  tally.check('the Esc ends the lead\'s turn at once and never waits on the crewmate: the crewmate is still running a second later', firstEsc?.interrupted === true && firstTurnEnded && !taskEnded(taskId), JSON.stringify({ firstEsc, outcomes: outcomes().length, crewmateEnded: taskEnded(taskId) }))

  const leadBeforeObjection = leadRequests().length
  submit(OBJECTION)
  const objectionStreams = await waitFor('the objection did not reach the model', () => leadRequests().length >= leadBeforeObjection + 1, TURN_MS)
  tally.check('the objection starts a lead turn (its request streams)', objectionStreams, String(leadRequests().length))
  console.log(`  ${clock()} p in the crew view while the answer streams`)
  const closed = await pauseGate(true)
  const stopped = (await wire.request('agent/stop', { agent_id: taskId }, { deadlineMs: TURN_MS }).catch((error: unknown) => ({ refused: String(error) }))) as Frame
  tally.check('p closes the gate and x x stops the crewmate (the daemon\'s two verbs of 06:45:04Z and 06:45:07Z)', closed?.paused === true && closed.changed === true && stopped.receipt === 'applied', JSON.stringify({ closed, stopped }))
  const toolAsked = await waitFor('the model never asked for ToolSearch', () => toolCallRow('ToolSearch') !== undefined, TURN_MS)
  const toolSearch = toolCallRow('ToolSearch')
  await sleep(PARK_WINDOW_MS)
  const parkedAtTool = await gateFacts()
  tally.check('the in-flight stream finishes and ToolSearch parks before it runs (the pause gate\'s own law): no tool result, no further request, the seat parked', toolAsked && toolResultRow(toolSearch?.call_id) === undefined && leadRequests().length === leadBeforeObjection + 1 && parkedAtTool?.paused === true && (parkedAtTool?.parked ?? 0) >= 1, JSON.stringify({ toolAsked, result: toolResultRow(toolSearch?.call_id), lead: leadRequests().length, parkedAtTool }))
  console.log(`  ${clock()} interrupt (Esc) on the parked tool`)
  const secondEsc = await interrupt()
  const secondTurnEnded = await waitFor('the Esc did not end the parked turn', () => outcomes().length >= 2 && toolResultRow(toolSearch?.call_id) !== undefined, TURN_MS)
  tally.check('the Esc ends the parked turn: the tool is cancelled before it ran (the operator-stopped words), the turn is over', secondEsc?.interrupted === true && secondTurnEnded && toolResultRow(toolSearch?.call_id)?.output === CANCEL_MESSAGE, JSON.stringify({ secondEsc, result: toolResultRow(toolSearch?.call_id) }))

  const leadBeforeDemand = leadRequests().length
  console.log(`  ${clock()} the prompt "${DEMAND}" — the one that went unanswered`)
  submit(DEMAND)
  const t0 = Date.now()
  const answered = await waitFor('no model request followed the prompt', () => requestCarrying(DEMAND, leadBeforeDemand) !== undefined, ANSWER_WINDOW_MS)
  const tookMs = Date.now() - t0
  const gateAfter = await gateFacts()
  tally.check(`the prompt typed into the paused chat is answered: its model request is issued within ${ANSWER_WINDOW_MS / 1000}s (took ${tookMs}ms)`, answered, JSON.stringify({ lead: leadRequests().length, before: leadBeforeDemand, gateAfter }))
  tally.check('the operator\'s own prompt opened the operator\'s gate: the facts read open, nothing parked', gateAfter?.paused === false && gateAfter.parked === 0, JSON.stringify(gateAfter))
  const landed = answered && (await waitFor('the answer never landed', () => textLanded(ANSWER), TURN_MS))
  tally.check('the answer lands on the chat', landed)
  record('s1-requests.json', JSON.stringify(leadRequests().map(request => ({ model: request.body.model, last: lastUserOf(request).slice(0, 200) })), null, 2))
  if (!landed) throw new Error('the chat is deaf after the pause — the second scene needs a chat that answers')

  tally.section('S2 THE PAUSE MID-TURN, THEN WORDS WITHOUT AN ESC — the parked tool runs from exactly where it stopped, then the words are answered')
  const leadBeforeCarry = leadRequests().length
  submit(CARRY)
  const carryStreams = await waitFor('the carry prompt did not reach the model', () => leadRequests().length >= leadBeforeCarry + 1, TURN_MS)
  const closedAgain = await pauseGate(true)
  const bashAsked = await waitFor('the model never asked for Bash', () => toolCallRow('Bash') !== undefined, TURN_MS)
  const bash = toolCallRow('Bash')
  await sleep(PARK_WINDOW_MS)
  const parkedAtBash = await gateFacts()
  tally.check('p during the stream parks the Bash call before it runs', carryStreams && closedAgain?.paused === true && bashAsked && toolResultRow(bash?.call_id) === undefined && parkedAtBash?.paused === true, JSON.stringify({ closedAgain, result: toolResultRow(bash?.call_id), parkedAtBash }))
  console.log(`  ${clock()} the prompt "${GO_ON}" with no Esc`)
  submit(GO_ON)
  const ran = await waitFor('the parked Bash never ran', () => toolResultRow(bash?.call_id)?.status === 'ok' && (toolResultRow(bash?.call_id)?.output as string | undefined)?.includes(CARRIED) === true, ANSWER_WINDOW_MS)
  tally.check('the words lift the park: the Bash call the model asked for runs with its exact input, from exactly where it stopped', ran, JSON.stringify(toolResultRow(bash?.call_id)))
  const goneOn = await waitFor('the words were never answered', () => requestCarrying(GO_ON, leadBeforeCarry) !== undefined && textLanded(GONE_ON), TURN_MS)
  const gateEnd = await gateFacts()
  tally.check('the words reach the model after the turn they lifted, and the gate reads open', goneOn && gateEnd?.paused === false, JSON.stringify({ gateEnd, lead: leadRequests().length }))
} catch (error) {
  tally.check('the scenes ran to their end', false, error instanceof Error ? error.message : String(error))
} finally {
  await terminate()
  await closeWorld(world)
}
tally.finish()
