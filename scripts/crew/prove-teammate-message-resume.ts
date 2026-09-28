#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, toolResultOf, treeOf, type Frame } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const team = 'message-resume-team'
const worker = 'worker'
const workerAgentId = `${worker}@${team}`
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const STOP_NOTICE = 'stopped from the crew view'
const THIRD = 'THIRD-TURN'
const SEND_1 = 'toolu_send_after_stop'
const SEND_2 = 'toolu_send_after_eviction'
const MESSAGE_1 = 'CONTINUE-NOW-1: pick up where you were.'
const MESSAGE_2 = 'CONTINUE-NOW-2: once more, from your transcript.'
const REPLY_1 = 'FIRST-REPLY-LANDED'
const REPLY_2 = 'SECOND-REPLY-LANDED'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6' }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'TeamCreate', input: { team_name: team, description: 'Message continuation' } }, FIRST),
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, team_name: team, model: peerModel, subagent_type: 'mercury-general', description: 'Retain the conversation', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: SEND_1, name: 'SendMessage', input: { to: worker, message: MESSAGE_1, summary: 'pick up' } }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-SENT-1' }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-HEARD-1' }, REPLY_1),
  lead({ kind: 'tool_use', id: SEND_2, name: 'SendMessage', input: { to: worker, message: MESSAGE_2, summary: 'once more' } }, THIRD),
  lead({ kind: 'text', text: 'LEAD-SENT-2' }, THIRD),
  lead({ kind: 'text', text: 'LEAD-HEARD-2' }, REPLY_2),
  ...Array.from({ length: 12 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: `${REPLY_1}: continuing after HISTORY-WITNESS.`, summary: 'first reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-1' }),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: `${REPLY_2}: continuing once more.`, summary: 'second reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-2' }),
]
const tally = makeTally('prove-teammate-message-resume')
const world = await makeWorld('teammate-message-resume', script)
const session = bootLead(world, ['--permission-mode', 'sovereign'], ['Agent', 'Bash', 'TeamCreate', 'SendMessage'])
const inboxPath = join(world.teams, team, 'inboxes', 'team-lead.json')
const rosterPath = join(world.teams, team, 'config.json')
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined)
  return response(id)!.response as Frame
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
type InboxRow = { from: string; text: string }
type Roster = { members: Array<{ name: string; agentId: string }> }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const projects = join(world.config, 'projects')
const transcripts = (): string[] => treeOf(projects).filter(path => /subagents\/agent-a[0-9a-z]{8}\.jsonl$/.test(path))
const rows = (): Array<{ id: string; description: string }> =>
  session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_teammate').map(frame => ({ id: String(frame.task_id), description: String(frame.description) }))
const workerRows = (): Roster['members'] => (readJson<Roster>(rosterPath)?.members ?? []).filter(member => member.name.toLowerCase().startsWith(worker))
const availableNotices = (): number => (readJson<InboxRow[]>(inboxPath) ?? []).filter(row => row.from === worker && row.text.includes('idle_notification') && row.text.includes('"available"')).length
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const refusal = /is not running|Cannot deliver|no such member|inbox nobody reads/
const resumedWords = /resumed from its transcript with your message/

try {
  tally.section('the lead spawns a worker that lands a tool result; the operator stops it from the crew view')
  session.submit(`${FIRST}: create the team, spawn the worker, and park.`)
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'))
  const first = rows()[0]
  tally.check('a real in-process teammate runs with a history-bearing tool result', first !== undefined && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (first === undefined) throw new Error('the fixture has no teammate task id')
  const requestsBeforeStop = requests().length
  const stopped = await control('stop-worker', { subtype: 'stop_task', task_id: first.id })
  tally.check('the crew stop road stops the working teammate', stopped.subtype === 'success', JSON.stringify(stopped))

  tally.section('THE PIN: the stop notice wakes the lead; its message to the stopped worker resumes the worker with the message as its next turn, same name, same row, and the reply comes back')
  const answered1 = await until(() => session.stdout().includes('LEAD-SENT-1'), 60_000)
  const answer1 = toolResultOf(world, SEND_1)
  const text1 = answer1?.text ?? ''
  record('send-after-stop.txt', `${text1}\nis_error=${String(answer1?.isError)}\n`)
  tally.check('the lead was woken by the stop notice and its message to the worker was answered', answered1 && answer1 !== null, session.stdout().slice(-600))
  tally.check('the message is not refused as a seat nobody reads (RED on the base)', answer1 !== null && !refusal.test(text1), text1.slice(0, 300))
  tally.check('the answer says the worker was resumed from its transcript with the message', resumedWords.test(text1), text1.slice(0, 300))
  await until(() => requests().length > requestsBeforeStop, 30_000)
  const continued1 = requests()[requestsBeforeStop]
  record('continued-request-1.json', JSON.stringify(continued1?.body ?? null, null, 2))
  const history1 = JSON.stringify(continued1?.body.messages ?? [])
  tally.check('the worker makes a new request (RED on the base: none)', continued1 !== undefined, String(requests().length))
  tally.check('its history keeps the tool result from before the stop', history1.includes('"tool_result"') && history1.includes('HISTORY-WITNESS'))
  tally.check('the message rides as its next turn, in the teammate-message envelope from the lead', continued1 !== undefined && lastUser(continued1).includes(MESSAGE_1) && lastUser(continued1).includes('teammate_id=\\"team-lead\\"'), continued1 === undefined ? '' : lastUser(continued1).slice(-400))
  tally.check('the worker keeps its model', continued1?.body.model === peerModel)
  const resumed1 = (await until(() => rows().length >= 2, 30_000)) ? rows()[1] : undefined
  tally.check('the worker runs on under a new row that carries its own name, never a renamed one', resumed1 !== undefined && resumed1.id !== first.id && resumed1.description.startsWith(`${worker}:`), JSON.stringify(rows()))
  const rosterRows1 = workerRows()
  tally.check('the roster holds the worker under the same name and the same agent id (RED on the base: no row)', rosterRows1.length === 1 && rosterRows1[0]!.name === worker && rosterRows1[0]!.agentId === workerAgentId, JSON.stringify(rosterRows1))
  const heard1 = await until(() => session.stdout().includes('LEAD-HEARD-1'), 60_000)
  tally.check('the worker\'s reply reaches the lead as a turn (RED on the base: no reply)', heard1, session.stdout().slice(-400))

  tally.section('THE PIN, after the row has left the list: the stop and the three-second eviction, then a message from a fresh turn resumes it from its record')
  const idle = await until(() => availableNotices() >= 1, 30_000)
  tally.check('the resumed worker went idle after its answer', idle, JSON.stringify({ rows: rows(), available: availableNotices() }))
  const stoppedAgain = resumed1 === undefined ? { subtype: 'skipped' } : await control('stop-worker-again', { subtype: 'stop_task', task_id: resumed1.id })
  tally.check('the resumed worker is stopped again on its new row', stoppedAgain.subtype === 'success', JSON.stringify(stoppedAgain))
  await sleep(3500)
  const before = transcripts()
  tally.check('after the eviction the roster holds no row for the worker, and its one transcript stands on disk', workerRows().length === 0 && before.length === 1, JSON.stringify({ members: workerRows(), before }))
  const requestsBeforeSecond = requests().length
  session.submit(`${THIRD}: message the worker again.`)
  const answered2 = await until(() => session.stdout().includes('LEAD-SENT-2'), 60_000)
  const answer2 = toolResultOf(world, SEND_2)
  const text2 = answer2?.text ?? ''
  record('send-after-eviction.txt', `${text2}\nis_error=${String(answer2?.isError)}\n`)
  tally.check('the lead\'s second message was answered', answered2 && answer2 !== null, session.stdout().slice(-600))
  tally.check('the message is not refused as an unknown member (RED on the base: "no such member on team")', answer2 !== null && !refusal.test(text2), text2.slice(0, 300))
  tally.check('the answer says the worker was resumed from its transcript with the message', resumedWords.test(text2), text2.slice(0, 300))
  await until(() => requests().length > requestsBeforeSecond, 30_000)
  const continued2 = requests()[requestsBeforeSecond]
  record('continued-request-2.json', JSON.stringify(continued2?.body ?? null, null, 2))
  const history2 = JSON.stringify(continued2?.body.messages ?? [])
  tally.check('the worker makes a new request from its record (RED on the base: none)', continued2 !== undefined, String(requests().length))
  tally.check('its history keeps the tool result, the first message and its answer: one conversation across both resumes', history2.includes('HISTORY-WITNESS') && history2.includes(MESSAGE_1) && history2.includes('CONTINUED-1'))
  tally.check('the second message rides as its next turn', continued2 !== undefined && lastUser(continued2).includes(MESSAGE_2), continued2 === undefined ? '' : lastUser(continued2).slice(-400))
  const rosterRows2 = workerRows()
  tally.check('the roster holds the worker under the same name and agent id once more', rosterRows2.length === 1 && rosterRows2[0]!.name === worker && rosterRows2[0]!.agentId === workerAgentId, JSON.stringify(rosterRows2))
  const heard2 = await until(() => session.stdout().includes('LEAD-HEARD-2'), 60_000)
  tally.check('the second reply reaches the lead as a turn', heard2, session.stdout().slice(-400))
  const landed = await until(() => transcripts().some(path => readFileSync(join(projects, path), 'utf8').includes(MESSAGE_2)), 15_000)
  const after = transcripts()
  tally.check('both continuations land on the one transcript file', landed && after.length === 1 && after[0] === before[0], JSON.stringify(after))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
