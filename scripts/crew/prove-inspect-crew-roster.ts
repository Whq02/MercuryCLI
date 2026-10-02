#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, toolResultOf, treeOf, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const crew = randomUUID()
const worker = 'roster-witness'
const peerModel = 'claude-opus-4-6'
const FIRST = 'SPAWN-ROSTER-WITNESS'
const RUNNING = 'READ-RUNNING-ROSTER'
const STOP = 'STOP-ROSTER-WITNESS'
const STOPPED = 'READ-STOPPED-ROSTER'
const RESUME = 'MESSAGE-ROSTER-WITNESS'
const RESUMED = 'READ-RESUMED-ROSTER'
const MESSAGE = 'CONTINUE-ROSTER-WITNESS: keep working from your transcript.'
const stopInput = { task_id: '' }
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when ? { whenBody: when } : {}) }) as ScriptedTurn
const reads = (phase: string, when: string): ScriptedTurn[] => [
  lead({ kind: 'tool_use', id: `live_${phase}`, name: 'LiveComms', input: {} }, when),
  lead({ kind: 'tool_use', id: `inspect_${phase}`, name: 'Inspect', input: { ref: 'mercury://crew' } }, when),
  lead({ kind: 'text', text: `READ-${phase}-DONE` }, when),
]
const spawnInput: Record<string, unknown> = { name: worker, crew_name: crew, model: peerModel, subagent_type: 'mercury-crew', description: 'Keep the roster witness', prompt: 'Record HISTORY-WITNESS, then keep working.' }
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: spawnInput }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  ...reads('running', RUNNING),
  lead({ kind: 'tool_use', id: 'stop_worker', name: 'TaskStop', input: stopInput }, STOP),
  lead({ kind: 'text', text: 'STOP-DONE' }, STOP),
  ...reads('stopped', STOPPED),
  lead({ kind: 'tool_use', id: 'message_worker', name: 'SendMessage', input: { to: worker, message: MESSAGE, summary: 'Continue the witness' } }, RESUME),
  lead({ kind: 'text', text: 'MESSAGE-DONE' }, RESUME),
  ...reads('resumed', RESUMED),
  ...Array.from({ length: 12 }, () => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the transcript witness' } }),
  peer({ kind: 'hang', deltas: ['WORKING-BEFORE-STOP'] }),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'pwd', description: 'Read the resumed working folder' } }, MESSAGE),
  peer({ kind: 'hang', deltas: ['WORKING-AFTER-MESSAGE'] }, MESSAGE),
]
const tally = makeTally('prove-inspect-crew-roster')
const world = await makeWorld('inspect-crew-roster', script)
const work = join(world.project, 'worker-place')
mkdirSync(work)
spawnInput.cwd = work
const session = bootLead(world, ['--mode', 'sovereign', '--session-id', crew], ['Agent', 'Bash', 'TaskStop', 'SendMessage', 'LiveComms', 'Inspect'])
type Member = { name: string; agentId: string; cwd?: string; isActive?: boolean; stoppedAt?: number }
const members = (): Member[] => readJson<{ members: Member[] }>(join(world.crews, crew, 'config.json'))?.members ?? []
const taskIds = (): string[] => session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_crewmate').map(frame => String(frame.task_id))
const requests = () => world.fixture.messageRequests().filter(request => (request.body as { model?: string })?.model === peerModel)
const rows = (text: string): Array<[string, string]> => [...text.matchAll(/^- ([^\s]+)(?: <[^>]+>)? \[([^\]:]+)(?::[^\]]*)?\]/gm)].map(match => [match[1]!, match[2]!] as [string, string]).sort(([a], [b]) => a.localeCompare(b))
const readPhase = async (phase: string, prompt: string, status: 'busy' | 'stopped'): Promise<void> => {
  session.submit(`${prompt}: read both crew roads.`)
  await session.waitFor(`${phase} reads did not finish`, () => session.stdout().includes(`READ-${phase}-DONE`))
  const live = toolResultOf(world, `live_${phase}`)
  const inspect = toolResultOf(world, `inspect_${phase}`)
  const liveText = live?.text ?? ''
  const inspectText = inspect?.text ?? ''
  record(`livecomms-${phase}.txt`, liveText)
  record(`inspect-${phase}.txt`, inspectText)
  console.log(`\n${phase.toUpperCase()} LIVECOMMS:\n${liveText}\n${phase.toUpperCase()} INSPECT:\n${inspectText}`)
  const rosterText = liveText.split('## Roster')[1]?.split('\n## ')[0] ?? ''
  const liveRows = rows(rosterText)
  const inspectRows = rows(inspectText)
  tally.check(`${phase}: both tools answered without error`, live !== null && !live.isError && inspect !== null && !inspect.isError)
  tally.check(`${phase}: LiveComms names the crewmate once as ${status}`, liveRows.filter(([name, state]) => name === worker && state === status).length === 1, JSON.stringify(liveRows))
  tally.check(`${phase}: Inspect carries every roster name and the same status word, row for row`, liveRows.length > 0 && JSON.stringify(inspectRows) === JSON.stringify(liveRows), JSON.stringify({ liveRows, inspectRows }))
  const lines = inspectText.split('\n').filter(line => line.startsWith(`- ${worker} `))
  tally.check(`${phase}: Inspect names the crewmate once, with its ${status === 'busy' ? 'running' : 'stopped'} state and cwd`, lines.length === 1 && lines[0]!.includes(`state: ${status === 'busy' ? 'running' : 'stopped'}`) && lines[0]!.includes(`cwd: ${work}`), lines.join('\n') || inspectText)
}
try {
  session.submit(`${FIRST}: start the crewmate and park.`)
  await session.waitFor('crewmate did not record its history and start working', () => requests().length >= 2 && taskIds().length === 1 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  tally.check('Agent starts a real in-process crewmate with history in its own cwd', members().some(member => member.name === worker && member.cwd === work) && JSON.stringify(requests()[1]?.body).includes('HISTORY-WITNESS'))
  await readPhase('running', RUNNING, 'busy')
  stopInput.task_id = taskIds()[0]!
  session.submit(`${STOP}: stop the crewmate task.`)
  await session.waitFor('TaskStop did not settle', () => session.stdout().includes('STOP-DONE') && members().some(member => member.name === worker && member.stoppedAt !== undefined))
  const stop = toolResultOf(world, 'stop_worker')
  tally.check('TaskStop stops the running crewmate through the product tool', stop !== null && !stop.isError && stop.text.includes(`Stopped task ${stopInput.task_id}`), stop?.text)
  const stopped = members().filter(member => member.name === worker)
  record('roster-stopped.json', JSON.stringify(members(), null, 2))
  tally.check('the stopped roster record keeps the same name, cwd and stop state', stopped.length === 1 && stopped[0]!.isActive === false && stopped[0]!.cwd === work && typeof stopped[0]!.stoppedAt === 'number')
  await readPhase('stopped', STOPPED, 'stopped')
  const projects = join(world.config, 'projects')
  const transcripts = treeOf(projects).filter(path => /subagents\/agent-a[0-9a-z]{8}\.jsonl$/.test(path))
  tally.check('the stopped transcript retains the earlier tool result', transcripts.length === 1 && readFileSync(join(projects, transcripts[0]!), 'utf8').includes('HISTORY-WITNESS'), JSON.stringify(transcripts))
  session.submit(`${RESUME}: message the stopped crewmate.`)
  await session.waitFor('message did not resume the crewmate into a working turn', () => session.stdout().includes('MESSAGE-DONE') && taskIds().length === 2 && requests().length >= 4)
  const message = toolResultOf(world, 'message_worker')
  tally.check('SendMessage resumes the stopped crewmate from its transcript', message !== null && !message.isError && /resumed from its transcript with your message/.test(message.text), message?.text)
  const resumed = members().filter(member => member.name === worker)
  tally.check('the resumed roster keeps one record, the same identity and cwd, now running', resumed.length === 1 && resumed[0]!.agentId === stopped[0]?.agentId && resumed[0]!.cwd === work && resumed[0]!.stoppedAt === undefined && resumed[0]!.isActive !== false, JSON.stringify(resumed))
  tally.check('the resumed turn actually ran in that cwd with its prior history', JSON.stringify(requests().at(-1)?.body).includes(work) && JSON.stringify(requests().at(-1)?.body).includes('HISTORY-WITNESS'))
  await readPhase('resumed', RESUMED, 'busy')
} finally {
  record('session-frames.json', JSON.stringify(session.frames, null, 2))
  record('session-stderr.txt', session.stderr())
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
