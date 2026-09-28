#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiRefusalOf, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, toolResultOf, treeOf, type Frame } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const team = 'message-twice-team'
const worker = 'worker'
const workerAgentId = `${worker}@${team}`
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const STOP_NOTICE = 'stopped from the crew view'
const THIRD = 'THIRD-TURN'
const FOURTH = 'FOURTH-TURN'
const FIFTH = 'FIFTH-TURN'
const SEND_A = 'toolu_send_a'
const SEND_B = 'toolu_send_b'
const SEND_C = 'toolu_send_c'
const SEND_D = 'toolu_send_d'
const SEND_E = 'toolu_send_e'
const STOP_E = 'toolu_stop_e'
const MESSAGE_A = 'CONTINUE-NOW-A: pick up where you were.'
const MESSAGE_B = 'CONTINUE-NOW-B: and then take this second note.'
const MESSAGE_C = 'RUN-LONG: run a long command.'
const MESSAGE_D = 'CONTINUE-NOW-D: after the long command was cut.'
const MESSAGE_E = 'CONTINUE-NOW-E: the row still stands.'
const REPLY_1 = 'FIRST-REPLY-LANDED'
const REPLY_2 = 'SECOND-REPLY-LANDED'
const REPLY_3 = 'THIRD-REPLY-LANDED'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when !== undefined ? { whenBody: when } : {}) }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'TeamCreate', input: { team_name: team, description: 'Two messages at once' } }, FIRST),
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, team_name: team, model: peerModel, subagent_type: 'mercury-general', description: 'Retain the conversation', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead(
    {
      kind: 'stream',
      blocks: [{ type: 'text', deltas: ['two notes for the worker'] }],
      gapMs: 5,
      tools: [
        { id: SEND_A, name: 'SendMessage', input: { to: worker, message: MESSAGE_A, summary: 'pick up' } },
        { id: SEND_B, name: 'SendMessage', input: { to: worker, message: MESSAGE_B, summary: 'second note' } },
      ],
    },
    STOP_NOTICE,
  ),
  lead({ kind: 'text', text: 'LEAD-SENT-AB' }, STOP_NOTICE),
  lead({ kind: 'text', text: 'LEAD-HEARD-1' }, REPLY_1),
  lead({ kind: 'text', text: 'LEAD-HEARD-2' }, REPLY_2),
  lead(
    {
      kind: 'stream',
      blocks: [{ type: 'text', deltas: ['stop the worker and message it at once'] }],
      gapMs: 5,
      tools: [
        { id: STOP_E, name: 'TaskStop', input: { task_id: worker } },
        { id: SEND_E, name: 'SendMessage', input: { to: worker, message: MESSAGE_E, summary: 'standing row' } },
      ],
    },
    FIFTH,
  ),
  lead({ kind: 'text', text: 'LEAD-SENT-E' }, FIFTH),
  lead({ kind: 'tool_use', id: SEND_C, name: 'SendMessage', input: { to: worker, message: MESSAGE_C, summary: 'long command' } }, THIRD),
  lead({ kind: 'text', text: 'LEAD-SENT-C' }, THIRD),
  lead({ kind: 'tool_use', id: SEND_D, name: 'SendMessage', input: { to: worker, message: MESSAGE_D, summary: 'after the cut' } }, FOURTH),
  lead({ kind: 'text', text: 'LEAD-SENT-D' }, FOURTH),
  lead({ kind: 'text', text: 'LEAD-HEARD-3' }, REPLY_3),
  ...Array.from({ length: 16 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'text', text: 'CONTINUED-E' }, MESSAGE_E),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 20', description: 'A long command' } }, MESSAGE_C),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: `${REPLY_3}: continuing after the cut.`, summary: 'third reply' } }, MESSAGE_D),
  peer({ kind: 'text', text: 'CONTINUED-3' }, MESSAGE_D),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: `${REPLY_1}: continuing after HISTORY-WITNESS.`, summary: 'first reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-1' }),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', message: `${REPLY_2}: the second note landed.`, summary: 'second reply' } }),
  peer({ kind: 'text', text: 'CONTINUED-2' }),
]
const tally = makeTally('prove-teammate-message-twice')
const world = await makeWorld('teammate-message-twice', script)
const session = bootLead(world, ['--permission-mode', 'sovereign'], ['Agent', 'Bash', 'TeamCreate', 'SendMessage', 'TaskStop'])
const rosterPath = join(world.teams, team, 'config.json')
const inboxPath = join(world.teams, team, 'inboxes', `${worker}.json`)
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined)
  return response(id)!.response as Frame
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
type Roster = { members: Array<{ name: string; agentId: string }> }
type InboxRow = { from: string; text: string; read?: boolean }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const projects = join(world.config, 'projects')
const transcripts = (): string[] => treeOf(projects).filter(path => /subagents\/agent-a[0-9a-z]{8}\.jsonl$/.test(path))
const rows = (): Array<{ id: string; description: string }> =>
  session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_teammate').map(frame => ({ id: String(frame.task_id), description: String(frame.description) }))
const workerRows = (): Roster['members'] => (readJson<Roster>(rosterPath)?.members ?? []).filter(member => member.name.toLowerCase().startsWith(worker))
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const nextTurnCarrying = (from: number, text: string): Request | undefined => requests().slice(from).find(request => lastUser(request).includes(text))
const envelope = (request: Request | undefined, text: string): boolean => request !== undefined && lastUser(request).includes(text) && lastUser(request).includes('teammate_id=\\"team-lead\\"')

try {
  tally.section('the lead spawns a worker that lands a tool result; the operator stops it from the crew view mid-turn')
  session.submit(`${FIRST}: create the team, spawn the worker, and park.`)
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'))
  const first = rows()[0]
  tally.check('a real in-process teammate runs with a history-bearing tool result', first !== undefined && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (first === undefined) throw new Error('the fixture has no teammate task id')
  const requestsBeforeStop = requests().length
  const stopped = await control('stop-worker', { subtype: 'stop_task', task_id: first.id })
  tally.check('the crew stop road stops the working teammate', stopped.subtype === 'success', JSON.stringify(stopped))

  tally.section('THE PIN: the stop notice wakes the lead, which sends the stopped worker two messages in one turn — both land: one resumes the worker as its next turn, the other is its turn after')
  const answered = await until(() => session.stdout().includes('LEAD-SENT-AB'), 60_000)
  const answerA = toolResultOf(world, SEND_A)
  const answerB = toolResultOf(world, SEND_B)
  const textA = answerA?.text ?? ''
  const textB = answerB?.text ?? ''
  record('send-a.txt', `${textA}\nis_error=${String(answerA?.isError)}\n`)
  record('send-b.txt', `${textB}\nis_error=${String(answerB?.isError)}\n`)
  tally.check('the lead was woken by the stop notice and both messages were answered', answered && answerA !== null && answerB !== null, session.stdout().slice(-600))
  const okA = textA.includes('"success":true')
  const okB = textB.includes('"success":true')
  tally.check('both messages are accepted (RED on the base: one is refused as already resuming)', okA && okB, JSON.stringify({ a: textA.slice(0, 220), b: textB.slice(0, 220) }))
  tally.check('neither answer says the message could not be resumed or delivered', !/could not be resumed|could NOT be delivered|Cannot deliver/.test(textA + textB), JSON.stringify({ a: textA.slice(0, 220), b: textB.slice(0, 220) }))
  await until(() => requests().length > requestsBeforeStop, 30_000)
  const continued = requests()[requestsBeforeStop]
  record('continued-request.json', JSON.stringify(continued?.body ?? null, null, 2))
  const firstText = continued !== undefined && lastUser(continued).includes(MESSAGE_A) ? MESSAGE_A : MESSAGE_B
  const secondText = firstText === MESSAGE_A ? MESSAGE_B : MESSAGE_A
  tally.check('the worker makes a new request whose history keeps the tool result from before the stop', continued !== undefined && JSON.stringify(continued.body.messages).includes('HISTORY-WITNESS'), String(requests().length))
  tally.check('one of the two messages rides as its next turn, in the teammate-message envelope from the lead', envelope(continued, firstText), continued === undefined ? '' : lastUser(continued).slice(-400))
  tally.check('the same row: its roster row keeps the name and the agent id, and the new row carries its own name', workerRows().length === 1 && workerRows()[0]!.name === worker && workerRows()[0]!.agentId === workerAgentId && (rows()[1]?.description.startsWith(`${worker}:`) ?? false), JSON.stringify({ roster: workerRows(), rows: rows() }))
  const heard1 = await until(() => session.stdout().includes('LEAD-HEARD-1'), 60_000)
  tally.check('the worker\'s reply reaches the lead as a turn', heard1, session.stdout().slice(-400))
  const secondLanded = await until(() => nextTurnCarrying(requestsBeforeStop + 1, secondText) !== undefined, 45_000)
  const second = nextTurnCarrying(requestsBeforeStop + 1, secondText)
  record('second-message-request.json', JSON.stringify(second?.body ?? null, null, 2))
  tally.check('the other message reaches the worker as its turn after, in the lead\'s envelope (RED on the base: it never arrives)', secondLanded && envelope(second, secondText), JSON.stringify({ requests: requests().length, inbox: readJson<InboxRow[]>(inboxPath) }))
  tally.check('that turn\'s history carries the first message and the worker\'s answer to it: one conversation', second !== undefined && JSON.stringify(second.body.messages).includes(firstText) && JSON.stringify(second.body.messages).includes('CONTINUED-1'))
  const heard2 = await until(() => session.stdout().includes('LEAD-HEARD-2'), 60_000)
  tally.check('the worker\'s second reply reaches the lead as a turn', heard2, session.stdout().slice(-400))
  tally.check('the worker still runs under one roster row with its name and agent id', workerRows().length === 1 && workerRows()[0]!.name === worker && workerRows()[0]!.agentId === workerAgentId, JSON.stringify(workerRows()))

  tally.section('before the eviction: the lead stops the idle worker and messages it in the same turn — the message meets the standing row and resumes it')
  const requestsBeforeE = requests().length
  const rowsBeforeE = rows().length
  session.submit(`${FIFTH}: stop the worker and message it at once.`)
  const answeredE = await until(() => session.stdout().includes('LEAD-SENT-E'), 60_000)
  const stopE = toolResultOf(world, STOP_E)
  const answerE = toolResultOf(world, SEND_E)
  const textE = answerE?.text ?? ''
  record('stop-e.txt', `${stopE?.text ?? ''}\nis_error=${String(stopE?.isError)}\n`)
  record('send-e.txt', `${textE}\nis_error=${String(answerE?.isError)}\n`)
  tally.check('the lead\'s stop reached the running worker', answeredE && stopE !== null && /Stopped task/.test(stopE.text) && stopE.text.includes('in_process_teammate'), stopE?.text.slice(0, 200) ?? '')
  tally.check('the message that follows the stop within its turn is accepted and meets the row that still stands (the seat "was stopped", not "had left the list")', answerE !== null && textE.includes('"success":true') && /was stopped/.test(textE) && !/left the list/.test(textE), textE.slice(0, 300))
  await until(() => requests().length > requestsBeforeE, 30_000)
  const continuedE = requests()[requestsBeforeE]
  record('continued-request-e.json', JSON.stringify(continuedE?.body ?? null, null, 2))
  tally.check('the worker resumes with that message as its next turn and the whole earlier conversation in its context', envelope(continuedE, MESSAGE_E) && continuedE !== undefined && JSON.stringify(continuedE.body.messages).includes('CONTINUED-2'), continuedE === undefined ? '' : lastUser(continuedE).slice(-400))
  const rowE = (await until(() => rows().length > rowsBeforeE, 30_000)) ? rows()[rowsBeforeE] : undefined
  tally.check('it runs on under a new row with its own name; the roster keeps the name and the agent id', rowE !== undefined && rowE.description.startsWith(`${worker}:`) && workerRows().length === 1 && workerRows()[0]!.name === worker && workerRows()[0]!.agentId === workerAgentId, JSON.stringify({ rows: rows(), roster: workerRows() }))
  const answeredWorkerE = await until(() => transcripts().some(path => readFileSync(join(projects, path), 'utf8').includes('CONTINUED-E')), 30_000)
  tally.check('the resumed worker answers, and its answer lands on its transcript', answeredWorkerE, JSON.stringify(transcripts()))

  tally.section('a stop while a tool is mid-run, the eviction, then a message: the continuation replays a legal history with the message as its next turn')
  const requestsBeforeLong = requests().length
  session.submit(`${THIRD}: tell the worker to run the long command.`)
  const longStarted = await until(() => requests().length > requestsBeforeLong && JSON.stringify(requests().at(-1)?.body.messages).includes(MESSAGE_C), 60_000)
  tally.check('the idle worker takes the third message from its inbox and starts the long command', longStarted, JSON.stringify({ requests: requests().length }))
  await sleep(1500)
  const running = rows().at(-1)
  const stoppedMidTool = running === undefined ? { subtype: 'skipped' } : await control('stop-worker-mid-tool', { subtype: 'stop_task', task_id: running.id })
  tally.check('the worker is stopped from the crew view while its tool runs', stoppedMidTool.subtype === 'success', JSON.stringify(stoppedMidTool))
  await sleep(3500)
  const before = transcripts()
  tally.check('after the eviction the roster holds no row for the worker, and its one transcript stands on disk', workerRows().length === 0 && before.length === 1, JSON.stringify({ members: workerRows(), before }))
  const requestsBeforeD = requests().length
  session.submit(`${FOURTH}: message the worker again.`)
  const answeredD = await until(() => session.stdout().includes('LEAD-SENT-D'), 60_000)
  const answerD = toolResultOf(world, SEND_D)
  const textD = answerD?.text ?? ''
  record('send-d.txt', `${textD}\nis_error=${String(answerD?.isError)}\n`)
  tally.check('the message after the mid-tool stop is accepted and resumes the worker from its record', answeredD && textD.includes('"success":true') && /resumed from its transcript/.test(textD), textD.slice(0, 300))
  await until(() => requests().length > requestsBeforeD, 30_000)
  const continuedD = requests()[requestsBeforeD]
  record('continued-request-d.json', JSON.stringify(continuedD?.body ?? null, null, 2))
  const refusal = continuedD === undefined ? 'no request' : apiRefusalOf(continuedD.body)
  tally.check('the replayed history is one the API accepts: no tool_use without its result, no empty assistant turn', continuedD !== undefined && refusal === null, String(refusal))
  tally.check('the message rides as its next turn after the cut tool, with the earlier conversation in its context', envelope(continuedD, MESSAGE_D) && continuedD !== undefined && JSON.stringify(continuedD.body.messages).includes('HISTORY-WITNESS') && JSON.stringify(continuedD.body.messages).includes(MESSAGE_C), continuedD === undefined ? '' : lastUser(continuedD).slice(-400))
  const heard3 = await until(() => session.stdout().includes('LEAD-HEARD-3'), 60_000)
  tally.check('the worker\'s reply after the cut reaches the lead as a turn', heard3, session.stdout().slice(-400))
  const landed = await until(() => transcripts().some(path => readFileSync(join(projects, path), 'utf8').includes(MESSAGE_D)), 15_000)
  const after = transcripts()
  tally.check('every continuation lands on the one transcript file', landed && after.length === 1 && after[0] === before[0], JSON.stringify(after))
  tally.check('the roster holds the worker under the same name and agent id once more', workerRows().length === 1 && workerRows()[0]!.name === worker && workerRows()[0]!.agentId === workerAgentId, JSON.stringify(workerRows()))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
