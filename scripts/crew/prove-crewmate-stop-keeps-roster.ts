#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { parseFrame, spawnRunnerDoor, type Frame } from '../lib/rows.ts'
import { closeWorld, DIST, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, NODE, readJson, record, sleep, toolResultOf, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const workerAgentId = `${worker}@${crew}`
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const STOP_NOTICE = 'stopped from the crew view'
const SECOND = 'SECOND-TURN'
const REPLY_1 = 'REPLY-ONE-LANDED'
const BRIEF_1 = 'toolu_brief_after_stop'
const SEND_1 = 'toolu_send_after_stop'
const BRIEF_2 = 'toolu_brief_after_resume'
const MESSAGE_1 = 'CONTINUE-NOW-1: pick up where you were.'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when !== undefined ? { whenBody: when } : {}) }) as ScriptedTurn
const tally = makeTally('prove-crewmate-stop-keeps-roster')
const work = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'crewmate-place-'))
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: crew, cwd: work, model: peerModel, subagent_type: 'mercury-crew', description: 'Keep the place', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: BRIEF_1, name: 'LiveComms', input: {} }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-READ-1' }, STOP_NOTICE),
  lead({ kind: 'tool_use', id: SEND_1, name: 'SendMessage', input: { to: worker, message: MESSAGE_1, summary: 'pick up' } }, SECOND),
  lead({ kind: 'text', text: 'LEAD-SENT-1' }, SECOND),
  lead({ kind: 'tool_use', id: BRIEF_2, name: 'LiveComms', input: {} }, REPLY_1),
  lead({ kind: 'text', text: 'LEAD-READ-2' }, REPLY_1),
  ...Array.from({ length: 12 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: `${REPLY_1}: continuing after HISTORY-WITNESS.`, summary: 'first reply' } }, MESSAGE_1),
  peer({ kind: 'text', text: 'CONTINUED-1' }, MESSAGE_1),
]
const world = await makeWorld('crewmate-stop-keeps-roster', script)
const frames: Frame[] = []
let rowsOut = ''
let leadErr = ''
const refusals: string[] = []
const door = spawnRunnerDoor({
  node: NODE,
  argv: [DIST, 'run', '--model', LEAD_MODEL, '--allowed-tools', 'Agent', 'Bash', 'SendMessage', 'LiveComms', '--mode', 'sovereign', '--session-id', sessionId],
  cwd: world.project,
  env: world.env,
  onLine: line => {
    rowsOut += `${line}\n`
    const frame = parseFrame(line)
    if (frame !== null) frames.push(frame)
  },
})
door.child.stderr!.on('data', (chunk: Buffer) => {
  leadErr += chunk.toString('utf8')
})
const wire = door.connection.peer
let leadDone = false
const leadExited = new Promise<number | null>(resolveExit => door.child.on('close', code => {
  leadDone = true
  resolveExit(code)
}))
const session = {
  frames,
  stdout: (): string => rowsOut,
  stderr: (): string => leadErr,
  submit: (text: string): void => {
    wire.request('queue/add', { type: 'prompt', content: text }, { deadlineMs: TURN_MS }).catch((error: unknown) => {
      refusals.push(`queue/add: ${error instanceof Error ? error.message : String(error)}`)
    })
  },
  waitFor: async (label: string, test: () => boolean, timeoutMs = TURN_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!test()) {
      if (leadDone || Date.now() >= deadline) throw new Error(`${label}\n--- rows tail ---\n${rowsOut.slice(-1500)}\n--- stderr tail ---\n${leadErr.slice(-1500)}\n--- queue ---\n${refusals.join('\n')}`)
      await sleep(25)
    }
  },
  terminate: async (): Promise<number | null> => {
    door.child.kill('SIGTERM')
    const code = await Promise.race([leadExited, sleep(60_000).then(() => null)])
    if (!leadDone) door.child.kill('SIGKILL')
    door.connection.close('the proof ended')
    return code
  },
}
const stopAgent = (agentId: string): Promise<Frame> => wire.request('agent/stop', { agent_id: agentId }, { deadlineMs: TURN_MS }).then(receipt => receipt as Frame, (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }))
const rosterPath = join(world.crews, crew, 'config.json')
type Member = { name: string; agentId: string; cwd?: string; isActive?: boolean; stoppedAt?: number; backendType?: string }
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const rowsOf = (): string[] => session.frames.filter(frame => frame.type === 'task' && frame.state === 'started' && frame.task_type === 'in_process_crewmate').map(frame => String(frame.task_id))
const members = (): Member[] => readJson<{ members: Member[] }>(rosterPath)?.members ?? []
const workerMembers = (): Member[] => members().filter(member => member.agentId === workerAgentId)
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const rosterSection = (text: string): string[] => {
  const at = text.indexOf('## Roster')
  if (at < 0) return []
  const rest = text.slice(at).split('\n').slice(1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return end < 0 ? rest : rest.slice(0, end)
}
const rosterLines = (text: string, name: string): string[] => rosterSection(text).filter(line => new RegExp(`^- ${name}\\b`).test(line))
const rosterLine = (text: string, name: string): string | undefined => rosterLines(text, name)[0]

try {
  tally.section('the lead starts a crewmate in its own folder; the operator stops it from the crew view mid-turn')
  session.submit(`${FIRST}: start the worker and park.`)
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const first = rowsOf()[0]
  tally.check('a real in-process crewmate runs with a history-bearing tool result', first !== undefined && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (first === undefined) throw new Error('the fixture has no crewmate task id')
  const born = workerMembers()[0]
  tally.check('the roster record carries the crewmate under its name, working, in its own folder', born !== undefined && born.cwd === work && born.stoppedAt === undefined, JSON.stringify(members()))
  const stopped = await stopAgent(first)
  tally.check('the crew stop road stops the working crewmate', stopped.receipt === 'applied', JSON.stringify(stopped))

  tally.section('THE PIN: the roster record stays after the stop, marked stopped, its folder kept — never removed at the kill')
  const marked = await until(() => workerMembers()[0]?.stoppedAt !== undefined, TURN_MS / 3)
  const after = workerMembers()[0]
  record('roster-after-stop.json', JSON.stringify(members(), null, 2))
  tally.check('the crew file keeps the crewmate\'s record (RED on the base: the kill removes it)', after !== undefined, JSON.stringify(members()))
  tally.check('the record is marked stopped with the clock of the stop, and not active', marked && after !== undefined && typeof after.stoppedAt === 'number' && after.isActive === false, JSON.stringify(after ?? null))
  tally.check('the record keeps the crewmate\'s folder', after?.cwd === work, JSON.stringify(after ?? null))
  const read1 = await until(() => session.stdout().includes('LEAD-READ-1'), TURN_MS)
  const brief1 = toolResultOf(world, BRIEF_1)
  const text1 = brief1?.text ?? ''
  record('livecomms-after-stop.txt', text1)
  tally.check('the stop notice woke the lead and its LiveComms read was answered', read1 && brief1 !== null, session.stdout().slice(-400))
  const line1 = rosterLine(text1, worker)
  tally.check('the LiveComms roster lists the stopped crewmate as stopped (RED on the base: no row for it)', line1 !== undefined && /\[stopped\]/.test(line1), line1 ?? text1.slice(0, 400))
  tally.check('…never as busy or idle', line1 === undefined || !/\[(busy|idle)/.test(line1), line1 ?? '')

  tally.section('a message resumes it from the kept record: the words name the stop, the record reads working again under the one name, and the LiveComms roster follows')
  session.submit(`${SECOND}: message the worker.`)
  const sent1 = await until(() => session.stdout().includes('LEAD-SENT-1'), TURN_MS)
  const answer1 = toolResultOf(world, SEND_1)
  const send1 = answer1?.text ?? ''
  record('send-after-stop.txt', `${send1}\nis_error=${String(answer1?.isError)}\n`)
  tally.check('the message to the stopped crewmate was answered as a resume', sent1 && /"success":true/.test(send1) && /resumed from its transcript with your message/.test(send1), send1.slice(0, 300))
  tally.check('the answer says the crewmate was stopped, read from its roster record (RED on the base: "had ended and its row had left the list")', /was stopped/.test(send1) && !/left the list/.test(send1), send1.slice(0, 300))
  const resumedRow = await until(() => rowsOf().length >= 2, TURN_MS / 3)
  const again = workerMembers()
  tally.check('the crewmate runs on under a new row, and the roster holds ONE record for it, working again', resumedRow && again.length === 1 && again[0]!.stoppedAt === undefined, JSON.stringify({ rows: rowsOf(), members: again }))
  const read2 = await until(() => session.stdout().includes('LEAD-READ-2'), TURN_MS)
  const brief2 = toolResultOf(world, BRIEF_2)
  const text2 = brief2?.text ?? ''
  record('livecomms-after-resume.txt', text2)
  const line2 = rosterLine(text2, worker)
  tally.check('the reply woke the lead, and the LiveComms roster reads the crewmate working or idle again, never stopped', read2 && line2 !== undefined && /\[(busy|idle)/.test(line2) && !/\[stopped\]/.test(line2), line2 ?? text2.slice(0, 400))
  tally.check('the roster names it once', rosterLines(text2, worker).length === 1, rosterSection(text2).join('\n'))
} finally {
  await session.terminate()
  await closeWorld(world)
  rmSync(work, { recursive: true, force: true })
}
tally.finish()
