#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import type { Frame } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { closeWorld, DIST, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, NODE, record, sleep, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const peerModel = 'claude-opus-4-6'
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6' }) as ScriptedTurn
const LAUNCH = 'Launch the lane.'
const CONTROL = 'Carry on, main.'
const WOKE = 'WOKE-AFTER-THE-WORDS'
const WOKE_AGAIN = 'WOKE-AFTER-THE-NOTE'
const NOTE_A = 'Wake up and carry on (typed at the crewmate).'
const NOTE_B = 'A note addressed to the crewmate.'
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Crewmate', input: { name: 'lane', run_in_background: true, model: peerModel, crewmate_type: 'mercury-crew', description: 'Lane fold-over-window', prompt: 'Read the brief whole, then report.' } }),
  lead({ kind: 'text', text: 'LAUNCHED' }),
  ...Array.from({ length: 5 }, () => lead({ kind: 'text', text: 'LEAD-MORE' })),
  peer({ kind: 'paced_tool_use', preDeltas: Array.from({ length: 40 }, (_, i) => (i === 0 ? 'Reading the brief' : '.')), gapMs: 400, tools: [{ name: 'Bash', input: { command: `printf ${WOKE}`, description: 'The first check' } }] }),
  peer({ kind: 'paced_tool_use', preDeltas: Array.from({ length: 20 }, (_, i) => (i === 0 ? 'Carrying on' : '.')), gapMs: 400, tools: [{ name: 'Bash', input: { command: `printf ${WOKE_AGAIN}`, description: 'The second check' } }] }),
  peer({ kind: 'text', text: 'LANE-DONE' }),
  ...Array.from({ length: 4 }, () => peer({ kind: 'text', text: 'LANE-MORE' })),
]
const tally = makeTally('prove-paused-crewmate-wakes')
const world = await makeWorld('paused-crewmate-wakes', script)
const frames: Frame[] = []
let rowsOut = ''
let leadErr = ''
const queue: string[] = []
const host = hostRunner({
  node: NODE,
  dist: DIST,
  argv: ['--model', LEAD_MODEL, '--allowed-tools', 'Crewmate', 'Bash', '--mode', 'sovereign'],
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
const submit = (row: Record<string, unknown>): void => {
  wire.request('queue/add', row as never, { deadlineMs: TURN_MS }).then(
    answer => queue.push(`queue/add ${JSON.stringify(row).slice(0, 60)} → ${JSON.stringify(answer)}`),
    (error: unknown) => queue.push(`queue/add: ${error instanceof Error ? error.message : String(error)}`),
  )
}
const waitFor = async (label: string, test: () => boolean, timeoutMs = TURN_MS): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (leadDone || Date.now() >= deadline) {
      console.log(`  [WAIT TIMEOUT] ${label}\n--- rows tail ---\n${rowsOut.slice(-1200)}\n--- stderr tail ---\n${leadErr.slice(-800)}\n--- queue ---\n${queue.join('\n')}`)
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
const lastUserOf = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const toolCallRows = (tool: string): Frame[] => frames.filter(frame => frame.type === 'tool_call' && frame.tool === tool)
const toolResultRow = (callId: unknown): Frame | undefined => frames.find(frame => frame.type === 'tool_result' && frame.call_id === callId)
const outputOf = (callId: unknown): string => String(toolResultRow(callId)?.output ?? '')
const outcomes = (): Frame[] => frames.filter(frame => frame.type === 'outcome')
const textLanded = (words: string): boolean => frames.some(frame => frame.type === 'text' && typeof frame.text === 'string' && frame.text.includes(words))
const gateFacts = async (): Promise<{ paused: boolean; parked: number } | null> => {
  const facts = (await wire.request('session/facts', {}, { deadlineMs: 15_000 }).catch(() => null)) as { pause_gate?: { paused: boolean; parked: number } } | null
  return facts?.pause_gate ?? null
}
const pauseGate = (paused: boolean): Promise<{ paused: boolean; parked: number; changed: boolean } | null> =>
  wire.request('session/pause_gate', { paused }, { deadlineMs: 10_000 }).catch(() => null) as Promise<{ paused: boolean; parked: number; changed: boolean } | null>
const clock = (): string => new Date().toISOString().slice(11, 23)
const SETTLE_MS = 1_500

try {
  tally.section('THE SCENE — a crewmate launched, the lead\'s turn waiting on it, p pressed while the crewmate streams: its Bash parks before it runs')
  submit({ type: 'prompt', content: LAUNCH })
  const launched = await waitFor('the lead did not launch the crewmate and wait on it', () => requestsOf(peerModel).length >= 1 && textLanded('LAUNCHED') && frames.some(frame => frame.type === 'turn' && frame.state === 'waiting'), TURN_MS)
  await sleep(1_000)
  const started = frames.find(frame => frame.type === 'task' && frame.state === 'started' && frame.task_type === 'local_agent')
  const taskId = started?.task_id
  tally.check('a real background crewmate streams and the lead\'s turn waits on it', launched && typeof taskId === 'string', JSON.stringify({ launched, taskId }))
  if (typeof taskId !== 'string') throw new Error('no crewmate task id')
  console.log(`  ${clock()} p (session/pause_gate) while the crewmate streams`)
  const closed = await pauseGate(true)
  const bashAsked = await waitFor('the crewmate never asked for its first Bash', () => toolCallRows('Bash').length >= 1, TURN_MS)
  const bash1 = toolCallRows('Bash')[0]
  await sleep(SETTLE_MS)
  const parked = await gateFacts()
  tally.check('the crewmate\'s stream finishes and its Bash parks before it runs: no tool result, the facts read the gate closed with one parked', closed?.paused === true && bashAsked && toolResultRow(bash1?.call_id) === undefined && parked?.paused === true && (parked?.parked ?? 0) >= 1, JSON.stringify({ closed, bash: bash1?.call_id, result: toolResultRow(bash1?.call_id), parked }))

  tally.section('A — WORDS TYPED AT THE PAUSED CREWMATE (agent/resume with a note, the crew view\'s road) wake that crewmate alone; the gate stays closed')
  console.log(`  ${clock()} agent/resume {agent_id, note} → the crewmate`)
  const resumed = (await wire.request('agent/resume', { agent_id: taskId, note: NOTE_A }, { deadlineMs: 10_000 }).catch((error: unknown) => ({ refused: String(error) }))) as Record<string, unknown>
  const tA = Date.now()
  const wokeA = await waitFor('the parked Bash never ran after the words', () => toolResultRow(bash1?.call_id) !== undefined, TURN_MS)
  const tookA = Date.now() - tA
  const gateA = await gateFacts()
  tally.check('the runner accepted the words for the running crewmate (queued)', resumed.queued === true, JSON.stringify(resumed))
  tally.check(`the words wake the paused crewmate: its parked Bash runs with the input its model asked for (took ${tookA}ms)`, wokeA && outputOf(bash1?.call_id).includes(WOKE), JSON.stringify({ result: toolResultRow(bash1?.call_id), gateA }))
  tally.check('the gate stays closed and nothing else is parked: the lift is the crewmate\'s alone', gateA?.paused === true && gateA.parked === 0, JSON.stringify(gateA))
  if (!wokeA) throw new Error('the crewmate is deaf to the words — the later scenes need a crewmate that wakes')

  tally.section('B — p twice (open, then a fresh pause) parks the woken crewmate again at its next tool; a note addressed to it (queue/add type:note, the daemon\'s delivery) wakes it again')
  const opened = await pauseGate(false)
  const closedAgain = await pauseGate(true)
  const bashAskedAgain = await waitFor('the crewmate never asked for its second Bash', () => toolCallRows('Bash').length >= 2, TURN_MS)
  const bash2 = toolCallRows('Bash')[1]
  await sleep(SETTLE_MS)
  const parkedAgain = await gateFacts()
  tally.check('a fresh pause after a reopen holds the crewmate again: its second Bash parks, the facts read it parked', opened?.paused === false && closedAgain?.paused === true && bashAskedAgain && toolResultRow(bash2?.call_id) === undefined && parkedAgain?.paused === true && (parkedAgain?.parked ?? 0) >= 1, JSON.stringify({ opened, closedAgain, result: toolResultRow(bash2?.call_id), parkedAgain }))
  console.log(`  ${clock()} queue/add {type:'note', to} → the crewmate`)
  submit({ type: 'note', to: taskId, content: NOTE_B })
  const tB = Date.now()
  const wokeB = await waitFor('the parked Bash never ran after the addressed note', () => toolResultRow(bash2?.call_id) !== undefined, TURN_MS)
  const tookB = Date.now() - tB
  const gateB = await gateFacts()
  tally.check(`the addressed note wakes the paused crewmate: its parked Bash runs with the input its model asked for (took ${tookB}ms)`, wokeB && outputOf(bash2?.call_id).includes(WOKE_AGAIN), JSON.stringify({ result: toolResultRow(bash2?.call_id), gateB, queue }))
  tally.check('the gate stays closed after the note', gateB?.paused === true, JSON.stringify(gateB))
  const finished = await waitFor('the crewmate never finished', () => textLanded('LANE-DONE'), TURN_MS)
  tally.check('the crewmate runs to its end under the closed gate', finished, JSON.stringify({ finished, peer: requestsOf(peerModel).length }))

  tally.section('CONTROL — the operator\'s prompt to the chat opens the whole gate (round 1 kept)')
  const leadBefore = requestsOf(LEAD_MODEL).length
  console.log(`  ${clock()} queue/add {type:'prompt'} → main`)
  submit({ type: 'prompt', content: CONTROL })
  const tC = Date.now()
  const answered = await waitFor('the prompt to main was never sent to the model', () => requestsOf(LEAD_MODEL).slice(leadBefore).some(request => lastUserOf(request).includes(CONTROL)), TURN_MS)
  const tookC = Date.now() - tC
  const gateC = await gateFacts()
  tally.check(`the prompt to main is answered (its request issued, took ${tookC}ms) and the gate reads open`, answered && gateC?.paused === false && gateC.parked === 0, JSON.stringify({ answered, gateC, outcomes: outcomes().length }))
  const carried = await waitFor('the words sent to the crewmate never reached a request of its own', () => [NOTE_A, NOTE_B].every(note => requestsOf(peerModel).some(request => JSON.stringify(request.body.messages ?? []).includes(note))), TURN_MS)
  tally.check('both messages sent to the crewmate reach its own model requests (the typed words as guidance when its run ends, the note at its next request) — late, never dropped', carried, JSON.stringify(requestsOf(peerModel).map(lastUserOf).map(text => text.slice(0, 100))))
  record('requests.json', JSON.stringify({ lead: requestsOf(LEAD_MODEL).map(lastUserOf), peer: requestsOf(peerModel).map(lastUserOf) }, null, 2))
} catch (error) {
  tally.check('the scenes ran to their end', false, error instanceof Error ? error.message : String(error))
} finally {
  await terminate()
  await closeWorld(world)
}
tally.finish()
