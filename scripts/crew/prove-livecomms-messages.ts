#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, sleep, toolResultOf, treeOf, TURN_MS } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const SECOND = 'SECOND-TURN'
const WORKER_PROMPT = 'WORKER-PROMPT'
const NOTE = 'MID-TURN-NOTE: read this at your next tool boundary.'
const REPLY = 'REPLY-LANDED: got the note.'
const SEND_MID = 'toolu_send_mid_turn'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: crew, model: peerModel, subagent_type: 'mercury-general', description: 'Runs a long command', prompt: `${WORKER_PROMPT}: run the long command.` } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: SEND_MID, name: 'SendMessage', input: { to: worker, message: NOTE, summary: 'a note' } }, SECOND),
  lead({ kind: 'text', text: 'LEAD-SENT' }, SECOND),
  lead({ kind: 'text', text: 'LEAD-HEARD' }, REPLY),
  ...Array.from({ length: 12 }, ack),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 8', description: 'The long command' } }, WORKER_PROMPT),
  peer({ kind: 'tool_use', name: 'SendMessage', input: { to: 'crew-lead', message: REPLY, summary: 'the reply' } }, NOTE),
  peer({ kind: 'text', text: 'WORKER-DONE' }, NOTE),
]
const tally = makeTally('prove-livecomms-messages')
const world = await makeWorld('livecomms-messages', script)
const session = bootLead(world, ['--permission-mode', 'sovereign', '--session-id', sessionId], ['Agent', 'Bash', 'SendMessage'])
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!test() && Date.now() < deadline) await sleep(100)
  return test()
}
const inboxDir = join(world.crews, crew, 'inboxes')
const storeFile = join(world.config, 'crew', 'livecomms', `${crew}.json`)
type Stored = { messages?: Array<{ to: string; from: string; text: string; read?: boolean }> }
const stored = (): Stored => (existsSync(storeFile) ? (JSON.parse(readFileSync(storeFile, 'utf8')) as Stored) : {})

try {
  tally.section('the lead spawns a worker whose turn holds a long command; the lead messages it mid-turn')
  session.submit(`${FIRST}: spawn the worker, and park.`)
  await session.waitFor('the lead never parked after the spawn', () => session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const started = await until(() => requests().length >= 1, TURN_MS)
  tally.check('the worker started its turn and the lead parked', started, session.stdout().slice(-300))
  await sleep(1500)
  const requestsBefore = requests().length
  session.submit(`${SECOND}: message the worker now.`)
  const sent = await until(() => toolResultOf(world, SEND_MID) !== null, TURN_MS / 2)
  const answer = toolResultOf(world, SEND_MID)
  const text = answer?.text ?? ''
  record('send-mid-turn.txt', `${text}\nis_error=${String(answer?.isError)}\n`)
  tally.check("SendMessage answers with its own words, byte for byte: Message delivered to worker's inbox", sent && answer !== null && !answer.isError && /"success":true/.test(text) && text.includes(`Message delivered to ${worker}'s inbox`), text.slice(0, 300))

  tally.section('THE PIN: the message lands at the worker\'s next tool boundary, and no inbox file is written anywhere')
  const landed = await until(() => requests().slice(requestsBefore).some(request => lastUser(request).includes('MID-TURN-NOTE')), TURN_MS / 2)
  const boundary = requests().slice(requestsBefore).find(request => lastUser(request).includes('MID-TURN-NOTE'))
  record('boundary-request.json', JSON.stringify(boundary?.body ?? null, null, 2))
  tally.check('the worker\'s next request carries the note', landed && boundary !== undefined, String(requests().length))
  tally.check('it rides in the same user turn as the long command\'s tool result — the tool boundary, not the turn\'s end', boundary !== undefined && lastUser(boundary).includes('"tool_result"') && lastUser(boundary).includes('crewmate_id=\\"crew-lead\\"'), boundary === undefined ? '' : lastUser(boundary).slice(-400))
  const heard = await until(() => session.stdout().includes('LEAD-HEARD'), TURN_MS / 2)
  tally.check('the worker\'s reply wakes the parked lead as a turn (the lead\'s wake reads LiveComms)', heard, session.stdout().slice(-400))
  const tree = treeOf(world.crews)
  record('crews-tree.txt', tree.join('\n') + '\n')
  tally.check('no inboxes/ directory or file under the crews home (RED on the base: inboxes/worker.json and crew-lead.json are written)', !existsSync(inboxDir) && !tree.some(path => path.includes('inboxes')), tree.join(' '))
  const rows = stored().messages ?? []
  record('livecomms.json', JSON.stringify(stored(), null, 2) + '\n')
  record('peer-requests.json', JSON.stringify(requests().map(request => request.body.messages), null, 2))
  tally.check('the note reached the worker exactly once: no second delivery as a later turn', requests().filter(request => lastUser(request).includes('MID-TURN-NOTE')).length === 1 && requests().every(request => (JSON.stringify(request.body.messages).match(/MID-TURN-NOTE/g) ?? []).length <= 1), String(requests().map(request => (JSON.stringify(request.body.messages).match(/MID-TURN-NOTE/g) ?? []).length)))
  tally.check('the one LiveComms file holds the note addressed to the worker and the reply addressed to the lead (RED on the base: no such file)', rows.some(m => m.to === worker && m.from === 'crew-lead' && m.text === NOTE) && rows.some(m => m.to === 'crew-lead' && m.from === worker && m.text === REPLY), JSON.stringify(rows).slice(0, 400))
  tally.check('the delivered note is marked read on the store; the idle notice rode the same file', rows.some(m => m.to === worker && m.text === NOTE && m.read === true) && rows.some(m => m.to === 'crew-lead' && m.from === worker && m.text.includes('idle_notification')), JSON.stringify(rows.map(m => ({ to: m.to, from: m.from, read: m.read, text: m.text.slice(0, 40) }))))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
