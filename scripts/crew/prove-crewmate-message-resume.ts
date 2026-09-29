#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiRefusalOf, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, crewMessagesTo, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, toolResultOf, treeOf, TURN_MS, type Frame } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const workerAgentId = `${worker}@${crew}`
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const STOP_NOTICE = 'stopped from the crew view'
const STANDING = 'STANDING-TURN'
const LONG = 'LONG-TURN'
const THIRD = 'THIRD-TURN'
const SEND_1 = 'toolu_send_after_stop'
const SEND_1B = 'toolu_send_after_stop_second'
const SEND_3 = 'toolu_send_standing_row'
const STOP_3 = 'toolu_stop_standing_row'
const SEND_4 = 'toolu_send_long_command'
const SEND_2 = 'toolu_send_after_eviction'
const MESSAGE_1 = 'CONTINUE-NOW-1: pick up where you were.'
const MESSAGE_1B = 'SECOND-NOTE-1: and then take this second note.'
const MESSAGE_3 = 'CONTINUE-NOW-3: the row still stands.'
const MESSAGE_4 = 'RUN-LONG: run a long command.'
const MESSAGE_2 = 'CONTINUE-NOW-2: once more, from your transcript.'
const REPLY_1 = 'REPLY-ONE-LANDED'
const REPLY_1B = 'REPLY-TWO-LANDED'
const REPLY_2 = 'REPLY-THREE-LANDED'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when !== undefined ? { whenBody: when } : {}) }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: 'crew', model: peerModel, subagent_type: 'mercury-general', description: 'Retain the conversation', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead(
    {
      kind: 'stream',
      blocks: [{ type: 'text', deltas: ['two notes for the stopped worker'] }],
      gapMs: 5,
      tools: [
        { id: SEND_1, name: 'SendMessage', input: { to: worker, message: MESSAGE_1, summary: 'pick up' } },
        { id: SEND_1B, name: 'SendMessage', input: { to: worker, message: MESSAGE_1B, summary: 'second note' } },
      ],
    },
    STOP_NOTICE,
  ),
  lead({ kind: 'text', text: 'LEAD-SENT-1' }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-HEARD-1' }, REPLY_1),
  lead({ kind: 'text', text: 'LEAD-HEARD-1B' }, REPLY_1B),
  lead(
    {
      kind: 'stream',
      blocks: [{ type: 'text', deltas: ['stop the worker and message it at once'] }],
      gapMs: 5,
      tools: [
        { id: STOP_3, name: 'TaskStop', input: { task_id: worker } },
        { id: SEND_3, name: 'SendMessage', input: { to: worker, message: MESSAGE_3, summary: 'standing row' } },
      ],
    },
    STANDING,
  ),
  lead({ kind: 'text', text: 'LEAD-SENT-3' }, STANDING),
  lead({ kind: 'tool_use', id: SEND_4, name: 'SendMessage', input: { to: worker, message: MESSAGE_4, summary: 'long command' } }, LONG),
  lead({ kind: 'text', text: 'LEAD-SENT-4' }, LONG),
  lead({ kind: 'tool_use', id: SEND_2, name: 'SendMessage', input: { to: worker, message: MESSAGE_2, summary: 'once more' } }, THIRD),
  lead({ kind: 'text', text: 'LEAD-SENT-2' }, THIRD),
  lead({ kind: 'text', text: 'LEAD-HEARD-2' }, REPLY_2),
  ...Array.from({ length: 16 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'text', text: 'CONTINUED-3' }, MESSAGE_3),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 20', description: 'A long command' } }, MESSAGE_4),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: `${REPLY_2}: continuing after the cut.`, summary: 'third reply' } }, MESSAGE_2),
  peer({ kind: 'text', text: 'CONTINUED-2' }, MESSAGE_2),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: `${REPLY_1}: continuing after HISTORY-WITNESS.`, summary: 'first reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-1' }),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: `${REPLY_1B}: the second note landed.`, summary: 'second reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-1B' }),
]
const tally = makeTally('prove-crewmate-message-resume')
const world = await makeWorld('crewmate-message-resume', script)
const session = bootLead(world, ['--permission-mode', 'sovereign', '--session-id', sessionId], ['Agent', 'Bash', 'SendMessage', 'TaskStop'])
const rosterPath = join(world.crews, crew, 'config.json')
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined)
  return response(id)!.response as Frame
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
type Roster = { members: Array<{ name: string; agentId: string }> }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const projects = join(world.config, 'projects')
const transcripts = (): string[] => treeOf(projects).filter(path => /subagents\/agent-a[0-9a-z]{8}\.jsonl$/.test(path))
const rowsOf = (): Array<{ id: string; description: string }> =>
  session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_crewmate').map(frame => ({ id: String(frame.task_id), description: String(frame.description) }))
const workerRows = (): Roster['members'] => (readJson<Roster>(rosterPath)?.members ?? []).filter(member => member.name.toLowerCase().startsWith(worker))
const sameRow = (): boolean => workerRows().length === 1 && workerRows()[0]!.name === worker && workerRows()[0]!.agentId === workerAgentId
const availableNotices = (): number => crewMessagesTo(world, crew, 'crew-lead').filter(row => row.from === worker && row.text.includes('idle_notification') && row.text.includes('"available"')).length
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const envelope = (request: Request | undefined, text: string): boolean => request !== undefined && lastUser(request).includes(text) && lastUser(request).includes('crewmate_id=\\"crew-lead\\"')
const nextTurnCarrying = (from: number, text: string): Request | undefined => requests().slice(from).find(request => lastUser(request).includes(text))
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const landedOnTranscript = (text: string): boolean => transcripts().some(path => readFileSync(join(projects, path), 'utf8').includes(text))
const resumedWords = (text: string): boolean => /"success":true/.test(text) && /resumed from its transcript with your message/.test(text)
const refused = (text: string): boolean => /"success":false/.test(text) || /Cannot deliver|that seat is not running|no such member|could not be resumed|could NOT be delivered/.test(text)

try {
  tally.section('the lead spawns a worker that lands a tool result; the operator stops it from the crew view mid-turn')
  session.submit(`${FIRST}: spawn the worker and park.`)
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const first = rowsOf()[0]
  tally.check('a real in-process crewmate runs with a history-bearing tool result', first !== undefined && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (first === undefined) throw new Error('the fixture has no crewmate task id')
  const requestsBeforeStop = requests().length
  const stopped = await control('stop-worker', { subtype: 'stop_task', task_id: first.id })
  tally.check('the crew stop road stops the working crewmate', stopped.subtype === 'success', JSON.stringify(stopped))

  tally.section('THE PIN: the stop notice wakes the lead, whose two messages to the stopped worker both land — one resumes it with the message as its next turn, the other is its turn after — same name, same row, and each reply comes back')
  const answered1 = await until(() => session.stdout().includes('LEAD-SENT-1'), TURN_MS * 2 / 3)
  const answer1 = toolResultOf(world, SEND_1)
  const answer1B = toolResultOf(world, SEND_1B)
  const text1 = answer1?.text ?? ''
  const text1B = answer1B?.text ?? ''
  record('send-after-stop.txt', `${text1}\nis_error=${String(answer1?.isError)}\n`)
  record('send-after-stop-second.txt', `${text1B}\nis_error=${String(answer1B?.isError)}\n`)
  tally.check('the stop notice woke the lead and its messages to the worker were answered', answered1 && answer1 !== null && answer1B !== null, session.stdout().slice(-600))
  tally.check('the message is not refused as a dead seat (RED on the base: "that seat is not running")', answer1 !== null && !refused(text1), text1.slice(0, 300))
  tally.check('the answer says the worker was resumed from its transcript with the message', resumedWords(text1), text1.slice(0, 300))
  tally.check('the second message of the same turn is accepted too, never refused as already resuming', answer1B !== null && !refused(text1B), text1B.slice(0, 300))
  await until(() => nextTurnCarrying(requestsBeforeStop, MESSAGE_1) !== undefined, TURN_MS / 3)
  const continued1 = nextTurnCarrying(requestsBeforeStop, MESSAGE_1) ?? requests()[requestsBeforeStop]
  record('continued-request-1.json', JSON.stringify(continued1?.body ?? null, null, 2))
  const history1 = JSON.stringify(continued1?.body.messages ?? [])
  tally.check('the worker makes a new request (RED on the base: none)', continued1 !== undefined, String(requests().length))
  tally.check('its history keeps the tool result from before the stop', history1.includes('"tool_result"') && history1.includes('HISTORY-WITNESS'))
  tally.check('the message rides as its next turn, in the crewmate-message envelope from the lead', envelope(continued1, MESSAGE_1), continued1 === undefined ? '' : lastUser(continued1).slice(-400))
  tally.check('the worker keeps its model', continued1?.body.model === peerModel)
  const resumedRow = (await until(() => rowsOf().length >= 2, TURN_MS / 3)) ? rowsOf()[1] : undefined
  tally.check('the same row: the roster keeps the name and the agent id, and the new row carries the name (RED on the base: no row)', sameRow() && resumedRow !== undefined && resumedRow.description.startsWith(`${worker}:`), JSON.stringify({ roster: workerRows(), rows: rowsOf() }))
  const heard1 = await until(() => session.stdout().includes('LEAD-HEARD-1'), TURN_MS * 2 / 3)
  tally.check('the worker\'s reply reaches the lead as a turn (RED on the base: no reply)', heard1, session.stdout().slice(-400))
  const secondLanded = await until(() => nextTurnCarrying(requestsBeforeStop + 1, MESSAGE_1B) !== undefined, TURN_MS / 2)
  const continued1B = nextTurnCarrying(requestsBeforeStop + 1, MESSAGE_1B)
  record('continued-request-1b.json', JSON.stringify(continued1B?.body ?? null, null, 2))
  tally.check('the second message reaches the worker as its turn after, in the lead\'s envelope, with the first message and its answer before it: one conversation', secondLanded && envelope(continued1B, MESSAGE_1B) && continued1B !== undefined && JSON.stringify(continued1B.body.messages).includes(MESSAGE_1) && JSON.stringify(continued1B.body.messages).includes('CONTINUED-1'), continued1B === undefined ? String(requests().length) : lastUser(continued1B).slice(-400))
  const heard1B = await until(() => session.stdout().includes('LEAD-HEARD-1B'), TURN_MS * 2 / 3)
  tally.check('the second reply reaches the lead as a turn', heard1B, session.stdout().slice(-400))
  const idle = await until(() => availableNotices() >= 1, TURN_MS / 3)
  tally.check('the resumed worker ran under a new row and went idle after its answers', resumedRow !== undefined && idle && sameRow(), JSON.stringify({ rows: rowsOf(), available: availableNotices(), roster: workerRows() }))

  tally.section('THE PIN, while the stopped row still stands: the lead stops the idle worker and messages it in the same turn, so the message meets the row before the eviction')
  const requestsBeforeStanding = requests().length
  const rowsBeforeStanding = rowsOf().length
  session.submit(`${STANDING}: stop the worker and message it at once.`)
  const answered3 = await until(() => session.stdout().includes('LEAD-SENT-3'), TURN_MS * 2 / 3)
  const stop3 = toolResultOf(world, STOP_3)
  const answer3 = toolResultOf(world, SEND_3)
  const text3 = answer3?.text ?? ''
  record('stop-standing-row.txt', `${stop3?.text ?? ''}\nis_error=${String(stop3?.isError)}\n`)
  record('send-standing-row.txt', `${text3}\nis_error=${String(answer3?.isError)}\n`)
  tally.check('the lead\'s stop reached the running worker', answered3 && stop3 !== null && /Stopped task/.test(stop3.text) && stop3.text.includes('in_process_crewmate'), stop3?.text.slice(0, 200) ?? '')
  tally.check('the message that follows the stop within its turn meets the row that still stands: the seat "was stopped", not "had left the list", and is resumed', answer3 !== null && resumedWords(text3) && /was stopped/.test(text3) && !/left the list/.test(text3), text3.slice(0, 300))
  await until(() => nextTurnCarrying(requestsBeforeStanding, MESSAGE_3) !== undefined, TURN_MS / 3)
  const continued3 = nextTurnCarrying(requestsBeforeStanding, MESSAGE_3) ?? requests()[requestsBeforeStanding]
  record('continued-request-3.json', JSON.stringify(continued3?.body ?? null, null, 2))
  tally.check('the worker resumes with that message as its next turn and the whole earlier conversation in its context', envelope(continued3, MESSAGE_3) && continued3 !== undefined && JSON.stringify(continued3.body.messages).includes('CONTINUED-1B'), continued3 === undefined ? '' : lastUser(continued3).slice(-400))
  const row3 = (await until(() => rowsOf().length > rowsBeforeStanding, TURN_MS / 3)) ? rowsOf()[rowsBeforeStanding] : undefined
  tally.check('it runs on under a new row with its own name; the roster keeps the name and the agent id', row3 !== undefined && row3.description.startsWith(`${worker}:`) && sameRow(), JSON.stringify({ rows: rowsOf(), roster: workerRows() }))
  const answered3Landed = await until(() => landedOnTranscript('CONTINUED-3'), TURN_MS / 3)
  tally.check('the resumed worker answers, and its answer lands on its transcript', answered3Landed, JSON.stringify(transcripts()))

  tally.section('THE PIN, after the row has left the list: a stop while a tool runs, the three-second eviction, then a message from a fresh turn resumes it from its record')
  const requestsBeforeLong = requests().length
  session.submit(`${LONG}: tell the worker to run the long command.`)
  const longStarted = await until(() => requests().length > requestsBeforeLong && lastUser(requests().at(-1)!).includes(MESSAGE_4), TURN_MS * 2 / 3)
  tally.check('the idle worker takes the message from its inbox and starts the long command', longStarted, String(requests().length))
  await sleep(1500)
  const running = rowsOf().at(-1)
  const stoppedAgain = running === undefined ? { subtype: 'skipped' } : await control('stop-worker-again', { subtype: 'stop_task', task_id: running.id })
  tally.check('the resumed worker is stopped again on its new row, while its tool runs', stoppedAgain.subtype === 'success', JSON.stringify(stoppedAgain))
  await sleep(3500)
  const before = transcripts()
  tally.check('after the eviction the roster holds no row for the worker, and its one transcript stands on disk', workerRows().length === 0 && before.length === 1, JSON.stringify({ members: workerRows(), before }))
  const requestsBeforeSecond = requests().length
  session.submit(`${THIRD}: message the worker again.`)
  const answered2 = await until(() => session.stdout().includes('LEAD-SENT-2'), TURN_MS * 2 / 3)
  const answer2 = toolResultOf(world, SEND_2)
  const text2 = answer2?.text ?? ''
  record('send-after-eviction.txt', `${text2}\nis_error=${String(answer2?.isError)}\n`)
  tally.check('the lead\'s message after the eviction was answered', answered2 && answer2 !== null, session.stdout().slice(-600))
  tally.check('the message is not refused as an unknown member (RED on the base: "no such member on crew")', answer2 !== null && !refused(text2), text2.slice(0, 300))
  tally.check('the answer says the worker was resumed from its transcript with the message', resumedWords(text2), text2.slice(0, 300))
  await until(() => nextTurnCarrying(requestsBeforeSecond, MESSAGE_2) !== undefined, TURN_MS / 3)
  const continued2 = nextTurnCarrying(requestsBeforeSecond, MESSAGE_2) ?? requests()[requestsBeforeSecond]
  record('continued-request-2.json', JSON.stringify(continued2?.body ?? null, null, 2))
  const history2 = JSON.stringify(continued2?.body.messages ?? [])
  tally.check('the worker makes a new request from its record (RED on the base: none)', continued2 !== undefined, String(requests().length))
  const refusal = continued2 === undefined ? 'no request' : apiRefusalOf(continued2.body)
  tally.check('the replayed history is one the API accepts: no tool_use without its result, no empty assistant turn', continued2 !== undefined && refusal === null, String(refusal))
  tally.check('its history keeps the tool result, every earlier message and its answers: one conversation across every resume', history2.includes('HISTORY-WITNESS') && history2.includes(MESSAGE_1) && history2.includes('CONTINUED-1') && history2.includes(MESSAGE_1B) && history2.includes(MESSAGE_3) && history2.includes(MESSAGE_4))
  tally.check('the message rides as its next turn', envelope(continued2, MESSAGE_2), continued2 === undefined ? '' : lastUser(continued2).slice(-400))
  const heard2 = await until(() => session.stdout().includes('LEAD-HEARD-2'), TURN_MS * 2 / 3)
  tally.check('the reply after the cut reaches the lead as a turn', heard2, session.stdout().slice(-400))
  const landed = await until(() => landedOnTranscript(MESSAGE_2), TURN_MS / 6)
  const after = transcripts()
  tally.check('every continuation lands on the one transcript file', landed && after.length === 1 && after[0] === before[0], JSON.stringify(after))
  tally.check('the roster holds the worker under the same name and agent id once more', sameRow(), JSON.stringify(workerRows()))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
