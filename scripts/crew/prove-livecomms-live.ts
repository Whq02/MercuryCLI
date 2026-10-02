#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, sleep, toolResultOf, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const SECOND = 'SECOND-TURN'
const ALICE_PROMPT = 'ALICE-PROMPT'
const BOB_PROMPT = 'BOB-PROMPT'
const HELLO = 'LIVE-HELLO from alice'
const TASK = 'LIVE-TASK wire the store'
const CLAIM = 'src/live/**'
const DOING = 'LIVE-DOING'
const FROM_ALICE = 'crewmate_id=\\"alice\\"'
const ALICE_WRITE = 'toolu_alice_livecomms_write'
const BOB_READ = 'toolu_bob_livecomms_read'
const LEAD_READ = 'toolu_lead_livecomms_read'
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'bob', crew_name: crew, model: peerModel, subagent_type: 'mercury-crew', description: 'Reads the live state', prompt: `${BOB_PROMPT}: wait for a message, then read LiveComms.` } }, FIRST),
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'alice', crew_name: crew, model: peerModel, subagent_type: 'mercury-crew', description: 'Writes the live state', prompt: `${ALICE_PROMPT}: write a message, a task, a claim and your busy flag through LiveComms.` } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: LEAD_READ, name: 'LiveComms', input: {} }, SECOND),
  lead({ kind: 'text', text: 'LEAD-READ-DONE' }, SECOND),
  ...Array.from({ length: 12 }, ack),
  peer({ kind: 'text', text: 'BOB-WAITING' }, BOB_PROMPT),
  peer({ kind: 'tool_use', id: BOB_READ, name: 'LiveComms', input: {} }, FROM_ALICE),
  peer({ kind: 'text', text: 'BOB-DONE' }, FROM_ALICE),
  peer(
    {
      kind: 'tool_use',
      id: ALICE_WRITE,
      name: 'LiveComms',
      input: { say: { to: 'bob', message: HELLO, summary: 'hello' }, task: { subject: TASK }, claim: { paths: [CLAIM] }, busy: { busy: true, doing: DOING } },
    },
    ALICE_PROMPT,
  ),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 20', description: 'Stay busy while the others read' } }, ALICE_PROMPT),
  peer({ kind: 'text', text: 'ALICE-DONE' }, ALICE_PROMPT),
]
const tally = makeTally('prove-livecomms-live')
const world = await makeWorld('livecomms-live', script)
const session = bootLead(world, ['--mode', 'sovereign', '--session-id', sessionId], ['Agent', 'Bash', 'SendMessage', 'LiveComms'])
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
const storeDir = join(world.config, 'crew', 'livecomms')
const storeFile = join(storeDir, `${crew}.json`)
const storeJson = (): Record<string, unknown> => (existsSync(storeFile) ? (JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>) : {})

try {
  tally.section('the lead spawns bob and alice; alice writes a message, a task, a claim and her busy flag in one LiveComms call')
  session.submit(`${FIRST}: spawn bob and alice, and park.`)
  await session.waitFor('the lead never parked after the spawns', () => session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const written = await until(() => toolResultOf(world, ALICE_WRITE) !== null, TURN_MS)
  const aliceAnswer = toolResultOf(world, ALICE_WRITE)
  const aliceText = aliceAnswer?.text ?? ''
  record('alice-write.txt', `${aliceText}\nis_error=${String(aliceAnswer?.isError)}\n`)
  tally.check('alice\'s LiveComms call was answered (RED on the base: no LiveComms tool — the call errors as an unknown tool)', written && aliceAnswer !== null && !aliceAnswer.isError, aliceText.slice(0, 300))
  const busyAt = aliceText.indexOf('- busy: ok')
  const messageAt = aliceText.indexOf('- message: ok')
  tally.check('the answer receipts the four writes, the message last (a receiver it wakes reads the rest)', /## Written \(4\)/.test(aliceText) && /task: ok/.test(aliceText) && /claim: ok/.test(aliceText) && busyAt >= 0 && messageAt > busyAt, aliceText.slice(0, 400))
  tally.check('the answer already shows the state after the writes: the task, the claim, alice busy with her word', aliceText.includes(TASK) && aliceText.includes(`alice: ${CLAIM}`) && new RegExp(`alice[^\\n]*\\[busy: ${DOING}\\]`).test(aliceText), aliceText.slice(0, 600))

  tally.section('THE PIN: bob\'s next turn is alice\'s message, and his LiveComms read shows what she wrote — live, in another crewmate')
  const bobRead = await until(() => toolResultOf(world, BOB_READ) !== null, TURN_MS)
  const bobRequest = requests().find(request => lastUser(request).includes(HELLO))
  tally.check('alice\'s message reached bob as his turn, in the crewmate-message envelope', bobRequest !== undefined && lastUser(bobRequest).includes('crewmate_id=\\"alice\\"'), bobRequest === undefined ? String(requests().length) : lastUser(bobRequest).slice(-300))
  const bobAnswer = toolResultOf(world, BOB_READ)
  const bobText = bobAnswer?.text ?? ''
  record('bob-read.txt', `${bobText}\nis_error=${String(bobAnswer?.isError)}\n`)
  tally.check('bob\'s LiveComms read was answered (RED on the base: unknown tool)', bobRead && bobAnswer !== null && !bobAnswer.isError, bobText.slice(0, 300))
  tally.check('bob reads the crew by name, alice\'s open task, her claim and her busy word', new RegExp(`# Crew: ${crew}`).test(bobText) && bobText.includes(TASK) && bobText.includes(`alice: ${CLAIM}`) && new RegExp(`alice[^\\n]*\\[busy: ${DOING}\\]`).test(bobText), bobText.slice(0, 600))

  tally.section('THE PIN: the lead\'s own read agrees')
  session.submit(`${SECOND}: read LiveComms.`)
  const leadRead = await until(() => toolResultOf(world, LEAD_READ) !== null, TURN_MS)
  const leadAnswer = toolResultOf(world, LEAD_READ)
  const leadText = leadAnswer?.text ?? ''
  record('lead-read.txt', `${leadText}\nis_error=${String(leadAnswer?.isError)}\n`)
  tally.check('the lead\'s LiveComms read was answered (RED on the base: unknown tool)', leadRead && leadAnswer !== null && !leadAnswer.isError, leadText.slice(0, 300))
  tally.check('the lead reads the same task, claim and busy word', leadText.includes(TASK) && leadText.includes(`alice: ${CLAIM}`) && new RegExp(`alice[^\\n]*\\[busy: ${DOING}\\]`).test(leadText), leadText.slice(0, 600))

  record('peer-requests.json', JSON.stringify(requests().map(request => request.body.messages), null, 2))
  tally.section('one file per crew under the crew store — the state every process reads')
  const json = storeJson()
  record('livecomms.json', JSON.stringify(json, null, 2) + '\n')
  const tasks = (json.tasks ?? {}) as Record<string, { subject: string }>
  const busy = (json.busy ?? {}) as Record<string, { busy: boolean; doing?: string }>
  tally.check('the store file exists (RED on the base: no crew/livecomms/)', existsSync(storeFile), storeFile)
  tally.check('it holds the task and the busy flag with her word (the claim lives in the claim store the read merges)', Object.values(tasks).some(t => t.subject === TASK) && busy.alice?.busy === true && busy.alice?.doing === DOING, JSON.stringify(json).slice(0, 400))
  const files = existsSync(storeDir) ? readdirSync(storeDir).filter(name => name.endsWith('.json')) : []
  tally.check('one file for the whole crew, none per member', files.length === 1 && files[0] === `${crew}.json`, JSON.stringify(files))
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
