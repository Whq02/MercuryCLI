#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, crewMessagesTo, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, toolResultOf, treeOf, TURN_MS } from './crew-world.ts'

const scratchCrews = mkdtempSync(join(tmpdir(), 'crewmate-name-wins-crews-'))
process.env.MERCURY_CREWS_DIR = scratchCrews
process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'crewmate-name-wins-home-'))

const tally = makeTally('prove-crewmate-name-wins-product')
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const NAME = 'alpha'
const PLAIN_WORD = 'PLAIN-ALPHA-WORK'
const SEAT_WORD = 'SEAT-ALPHA-WORK'
const PING = 'PING-FOR-THE-CREWMATE'
const STEP_ONE = 'STEP-ONE'
const STEP_TWO = 'STEP-TWO'
const STEP_THREE = 'STEP-THREE'
const PLAIN_ID = 'toolu_name_plain'
const SEAT_ID = 'toolu_name_seat'
const SEND_ID = 'toolu_name_send'

const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: PLAIN_ID, name: 'Agent', input: { name: NAME, model: LEAD_MODEL, subagent_type: 'mercury-crew', description: 'a plain sub-agent named alpha', prompt: `${PLAIN_WORD}: reply done.` } }, STEP_ONE),
  lead({ kind: 'text', text: 'PLAIN-LAUNCHED' }, STEP_ONE),
  { kind: 'text', text: 'done', model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: PLAIN_WORD } as ScriptedTurn,
  lead({ kind: 'tool_use', id: SEAT_ID, name: 'Agent', input: { name: NAME, crew_name: 'crew', model: SEAT_MODEL, subagent_type: 'mercury-crew', description: 'the alpha crewmate', prompt: `${SEAT_WORD}: wait for a message.` } }, STEP_TWO),
  lead({ kind: 'text', text: 'SEAT-LAUNCHED' }, STEP_TWO),
  { kind: 'text', text: 'alpha is idle.', model: SEAT_MODEL, whenModel: SEAT_GATE, whenBody: SEAT_WORD } as ScriptedTurn,
  lead({ kind: 'tool_use', id: SEND_ID, name: 'SendMessage', input: { to: NAME, message: PING, summary: 'a ping' } }, STEP_THREE),
  lead({ kind: 'text', text: 'SENT' }, STEP_THREE),
  { kind: 'text', text: 'alpha read the ping.', model: SEAT_MODEL, whenModel: SEAT_GATE, whenBody: PING } as ScriptedTurn,
]
const world = await makeWorld('crewmate-name-wins', script)
const sessionId = randomUUID()
const tools = ['Agent', 'SendMessage']
type Roster = { members: Array<{ name: string; agentId: string; joinedAt: number }> }
type Item = { role?: string; content?: unknown }
const openingOf = (body: unknown): string => {
  const items = (body as { messages?: Item[] } | null)?.messages ?? []
  const first = items.find(item => item.role === 'user')
  return first === undefined ? '' : typeof first.content === 'string' ? first.content : JSON.stringify(first.content)
}
const plainBodies = (): unknown[] => world.fixture.messageRequests().map(request => request.body).filter(body => openingOf(body).includes(PLAIN_WORD))
const plainRequests = (): number => plainBodies().length
const seatRequests = (): number => world.fixture.messageRequests().filter(request => (request.body as { model?: string } | null)?.model === SEAT_MODEL).length
const seatPingRequests = (): number => world.fixture.messageRequests().filter(request => (request.body as { model?: string } | null)?.model === SEAT_MODEL && JSON.stringify(request.body).includes(PING)).length
const plainPingRequests = (): number => plainBodies().filter(body => JSON.stringify(body).includes(PING)).length

tally.section('§1 the real product: a plain sub-agent named alpha finishes, then a crewmate alpha joins the crew')
const session = bootLead(world, ['--session-id', sessionId], tools)
try {
  session.submit(`${STEP_ONE}: start a plain sub-agent named alpha.`)
  await session.waitFor('the plain launch never settled', () => session.stdout().includes('PLAIN-LAUNCHED'), TURN_MS)
  const plainResult = toolResultOf(world, PLAIN_ID)
  record('plain-launch-result.txt', `${plainResult?.text ?? ''}\nis_error=${String(plainResult?.isError)}\n`)
  tally.check('the plain sub-agent launched as a sub-agent of the session, not a crewmate', plainResult !== null && plainResult.isError === false && !/crewmate/i.test(plainResult.text), plainResult?.text.slice(0, 200) ?? '(no result)')
  const plainDone = Date.now() + TURN_MS / 3
  while (plainRequests() < 1 && Date.now() < plainDone) await sleep(50)
  const finished = Date.now() + TURN_MS / 3
  while (!session.frames.some(frame => frame.type === 'task' && frame.state === 'ended') && Date.now() < finished) await sleep(50)
  tally.check('the plain sub-agent ran its turn on the wire and finished', plainRequests() >= 1, `${plainRequests()} plain request(s)`)
  await sleep(500)
  session.submit(`${STEP_TWO}: start the crewmate alpha.`)
  await session.waitFor('the crewmate launch never settled', () => session.stdout().includes('SEAT-LAUNCHED'), TURN_MS)
  const seatResult = toolResultOf(world, SEAT_ID)
  record('seat-launch-result.txt', `${seatResult?.text ?? ''}\nis_error=${String(seatResult?.isError)}\n`)
  tally.check('the crewmate alpha spawned into the crew (crew_name)', seatResult !== null && seatResult.isError === false && /crewmate/i.test(seatResult.text), seatResult?.text.slice(0, 200) ?? '(no result)')
  const seatUp = Date.now() + TURN_MS / 3
  while (seatRequests() < 1 && Date.now() < seatUp) await sleep(50)
  const roster = readJson<Roster>(join(world.crews, sessionId, 'config.json'))
  tally.check('the roster lists the crewmate alpha, the newer launch of the name', roster !== null && roster.members.some(member => member.name === NAME), JSON.stringify(roster?.members.map(member => member.name)))

  tally.section('§2 the pin: SendMessage { to: "alpha" } reaches the crewmate; the finished plain sub-agent is not resumed (RED on the base)')
  session.submit(`${STEP_THREE}: send alpha the ping.`)
  await session.waitFor('the send never settled', () => session.stdout().includes('SENT'), TURN_MS)
  const sent = toolResultOf(world, SEND_ID)
  record('send-result.txt', `${sent?.text ?? ''}\nis_error=${String(sent?.isError)}\n`)
  tally.check('the reply says the message went to alpha\'s inbox, never that a finished agent was resumed', sent !== null && sent.isError === false && /delivered to alpha's inbox/.test(sent.text) && !/resumed/.test(sent.text), sent?.text.slice(0, 240) ?? '(no result)')
  const inbox = crewMessagesTo(world, sessionId, NAME)
  tally.check('the crew store carries the message for the crewmate', inbox.some(row => row.text.includes(PING)), JSON.stringify(inbox.map(row => row.text.slice(0, 60))))
  const seatRead = Date.now() + TURN_MS / 3
  while (seatPingRequests() < 1 && Date.now() < seatRead) await sleep(50)
  tally.check('the crewmate\'s next turn carried the ping (its request on the seat model quotes it)', seatPingRequests() >= 1, `${seatPingRequests()} seat request(s) with the ping of ${seatRequests()}`)
  await sleep(1500)
  tally.check('the plain sub-agent was NOT resumed with the ping (no request opening with its prompt carries the ping)', plainRequests() >= 1 && plainPingRequests() === 0, `${plainPingRequests()} of ${plainRequests()} plain request(s) carry the ping`)
  const transcripts = treeOf(join(world.config, 'projects')).filter(path => /agent-.*\.jsonl$/.test(path))
  const seatTranscripts = transcripts.filter(path => readFileSync(join(world.config, 'projects', path), 'utf8').includes(PING))
  record('transcripts.txt', `${transcripts.join('\n')}\nwith the ping:\n${seatTranscripts.join('\n')}\n`)
  tally.check('the ping is in a crewmate transcript on disk and in no plain sub-agent transcript', seatTranscripts.length >= 1 && seatTranscripts.every(path => !readFileSync(join(world.config, 'projects', path), 'utf8').includes(PLAIN_WORD)), JSON.stringify(seatTranscripts))
  record('lead-stderr.txt', session.stderr())
} catch (error) {
  tally.check('the session ran to its end', false, error instanceof Error ? error.message : String(error))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
