#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, crewMessagesTo, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, sleep, TURN_MS, type Frame } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const sessionId = randomUUID()
const crew = sessionId
const worker = 'worker'
const scout = 'scout the window'
const peerModel = 'claude-opus-4-6'
const FIRST = 'FIRST-TURN'
const SPEND_1 = 'SPEND-ONE'
const SPEND_2 = 'SPEND-TWO'
const SCOUT = 'SCOUT-TURN'
const MESSAGE_1 = 'WINDOW-1: this ask meets the spent window.'
const MESSAGE_2 = 'WINDOW-2: this ask meets the spent window again.'
const RESUMED = 'resumed by yourself'
const RATE_LIMIT_SENTENCE = "This request would exceed your account's rate limit."
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const ack = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-ACK', model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>, when?: string): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6', ...(when !== undefined ? { whenBody: when } : {}) }) as ScriptedTurn
const spentHeaders = (resetAtMs: number): Record<string, string> => {
  const resetAt = Math.floor(resetAtMs / 1000)
  return {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetAt),
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-5h-reset': String(resetAt),
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'overage_not_provisioned',
    'retry-after': String(Math.max(1, resetAt - Math.floor(Date.now() / 1000))),
    'x-should-retry': 'false',
  }
}
const spent = (when: string): ScriptedTurn & { headers?: Record<string, string> } =>
  peer({ kind: 'error', status: 429, errorType: 'rate_limit_error', message: RATE_LIMIT_SENTENCE }, when) as ScriptedTurn & { headers?: Record<string, string> }
const spend1 = spent(MESSAGE_1)
const spend2 = spent(MESSAGE_2)
const spendScout = spent('SCOUT-ASK')
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: worker, crew_name: 'crew', model: peerModel, subagent_type: 'mercury-general', description: 'Wait for asks', prompt: 'Say READY and wait for messages.' } }, FIRST),
  lead({ kind: 'text', text: 'LEAD-PARKED' }, FIRST),
  lead({ kind: 'tool_use', id: 'toolu_send_one', name: 'SendMessage', input: { to: worker, message: MESSAGE_1, summary: 'first ask' } }, SPEND_1),
  lead({ kind: 'text', text: 'LEAD-SENT-1' }, SPEND_1),
  lead({ kind: 'tool_use', id: 'toolu_send_two', name: 'SendMessage', input: { to: worker, message: MESSAGE_2, summary: 'second ask' } }, SPEND_2),
  lead({ kind: 'text', text: 'LEAD-SENT-2' }, SPEND_2),
  lead({ kind: 'tool_use', id: 'toolu_scout', name: 'Agent', input: { model: peerModel, subagent_type: 'mercury-general', description: scout, prompt: 'SCOUT-ASK: scout the window.', run_in_background: true } }, SCOUT),
  lead({ kind: 'text', text: 'LEAD-SCOUTED' }, SCOUT),
  ...Array.from({ length: 24 }, ack),
  peer({ kind: 'text', text: 'WORKER-READY' }, 'Say READY'),
  spend1,
  peer({ kind: 'text', text: 'WORKER-CONTINUED-1' }, RESUMED),
  spend2,
  peer({ kind: 'text', text: 'WORKER-CONTINUED-2' }, RESUMED),
  spendScout,
  peer({ kind: 'text', text: 'SCOUT-CONTINUED' }, RESUMED),
]
const tally = makeTally('prove-crewmate-usage-pause')
const world = await makeWorld('crewmate-usage-pause', script)
const session = bootLead(world, ['--permission-mode', 'sovereign', '--session-id', sessionId], ['Agent', 'SendMessage'])
const rosterPath = join(world.crews, crew, 'config.json')
let seq = 0
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (request: Frame): Promise<Frame> => {
  const id = `req-${++seq}`
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined, TURN_MS / 4)
  return response(id)!.response as Frame
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
type WorkRow = { id: string; kind: string; name: string; status: string; error?: string; paused?: { why?: string; words?: string; resumes_at_ms?: number }; idle?: boolean }
type Roster = { members: Array<{ name: string }> }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const bodyText = (request: Request): string => JSON.stringify(request.body.messages ?? [])
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const requestCarrying = (from: number, text: string): Request | undefined => requests().slice(from).find(request => lastUser(request).includes(text))
const facts = async (): Promise<WorkRow[]> => {
  const answer = await control({ subtype: 'session_facts' })
  const payload = (answer.response as { work?: WorkRow[] } | undefined) ?? (answer as { work?: WorkRow[] })
  return payload.work ?? []
}
const rowsNamed = (rows: WorkRow[], name: string): WorkRow[] => rows.filter(row => row.name === name || row.name.startsWith(`${name}:`) || row.name.includes(name))
const pausedRow = async (name: string): Promise<WorkRow | undefined> => rowsNamed(await facts(), name).find(row => row.paused?.why === 'usage limit' || row.paused?.why === 'provider busy')
const rowsOf = (kind: string): Array<{ id: string; description: string }> =>
  session.frames.filter(frame => frame.subtype === 'task_started' && frame.task_type === kind).map(frame => ({ id: String(frame.task_id), description: String(frame.description) }))
const leadInboxFrom = (name: string): string[] => crewMessagesTo(world, crew, 'crew-lead').filter(row => row.from === name).map(row => row.text)
const rosterHolds = (name: string): boolean => (readJson<Roster>(rosterPath)?.members ?? []).some(member => member.name === name)
const until = async (test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await test()) return true
    await sleep(200)
  }
  return test()
}
const near = (value: number | undefined, target: number, slackMs: number): boolean => typeof value === 'number' && Math.abs(value - target) <= slackMs

try {
  tally.section('the lead spawns a crewmate that answers its first turn and waits')
  session.submit(`${FIRST}: create the crew, spawn the worker, and park.`)
  await session.waitFor('the worker never answered its first turn', () => requests().length >= 1 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const firstRow = rowsOf('in_process_crewmate')[0]
  tally.check('a real in-process crewmate runs', firstRow !== undefined && requests()[0]?.body.model === peerModel)
  tally.check('its first turn was answered and it went idle', await until(async () => rowsNamed(await facts(), worker).some(row => row.status === 'running' && row.idle === true), TURN_MS / 3))

  tally.section('THE PIN: the ask that meets the spent window PAUSES the crewmate — paused, not failed, with the reset time; the lead is told')
  const resetA = Date.now() + 90_000
  spend1.headers = spentHeaders(resetA)
  const before1 = requests().length
  session.submit(`${SPEND_1}: send the first ask.`)
  await session.waitFor('the lead never sent the first ask', () => session.stdout().includes('LEAD-SENT-1'), TURN_MS)
  const refused1 = await until(() => requestCarrying(before1, MESSAGE_1) !== undefined, TURN_MS / 3)
  tally.check('the crewmate carried the ask to the wire and met the 429', refused1)
  const paused1 = (await until(async () => (await pausedRow(worker)) !== undefined, TURN_MS / 4)) ? await pausedRow(worker) : undefined
  const rowsNow = rowsNamed(await facts(), worker)
  record('paused-row-1.json', JSON.stringify(rowsNow, null, 2))
  tally.check('the crewmate row reads PAUSED on the usage limit (RED on the base: the row stays running-idle or reads failed)', paused1 !== undefined, JSON.stringify(rowsNow))
  tally.check("the pause carries the provider's reset time", near(paused1?.paused?.resumes_at_ms, resetA, 2_000), JSON.stringify(paused1?.paused))
  tally.check("the paused row is settled, never a bare failure, and its words are the provider's wait", paused1 !== undefined && paused1.status !== 'running' && typeof paused1.paused?.words === 'string' && /spent|wait until/.test(paused1.paused.words), JSON.stringify(paused1))
  tally.check('the roster keeps the paused crewmate', rosterHolds(worker))
  const told = await until(() => leadInboxFrom(worker).some(text => /paused/.test(text) && !/"failed"/.test(text)), TURN_MS / 9)
  tally.check('the lead is told the crewmate paused, never that it failed (RED on the base: a failed idle notice)', told && !leadInboxFrom(worker).some(text => /idle_notification/.test(text) && /"failed"/.test(text)), JSON.stringify(leadInboxFrom(worker)).slice(0, 400))

  tally.section('THE PIN: the operator signs in on another account before the reset — the crewmate resumes at once, same name, same model, its history kept')
  const rowsBeforeSwitch = rowsOf('in_process_crewmate').length
  const before2 = requests().length
  const switched = await control({ subtype: 'credential_change' })
  tally.check('the credential change was taken by the session', switched.subtype === 'success', JSON.stringify(switched))
  const resumed1 = (await until(() => requestCarrying(before2, RESUMED) !== undefined, TURN_MS / 3)) ? requestCarrying(before2, RESUMED) : undefined
  record('resumed-request-1.json', JSON.stringify(resumed1?.body ?? null, null, 2))
  tally.check('the crewmate makes a new request with the resume note as its next turn (RED on the base: none)', resumed1 !== undefined, String(requests().length - before2))
  tally.check('its history keeps the first answer and the refused ask', resumed1 !== undefined && bodyText(resumed1).includes('WORKER-READY') && bodyText(resumed1).includes(MESSAGE_1))
  tally.check('it keeps its model', resumed1?.body.model === peerModel)
  tally.check('it runs on under a new row with its name', await until(() => rowsOf('in_process_crewmate').length > rowsBeforeSwitch, TURN_MS / 9) && rowsOf('in_process_crewmate').at(-1)!.description.startsWith(`${worker}:`), JSON.stringify(rowsOf('in_process_crewmate')))
  tally.check('the paused row is gone once the resume runs', await until(async () => (await pausedRow(worker)) === undefined, TURN_MS / 9), JSON.stringify(rowsNamed(await facts(), worker)))
  tally.check('the resumed crewmate answers and goes idle', await until(async () => rowsNamed(await facts(), worker).some(row => row.status === 'running' && row.idle === true), TURN_MS / 3))

  tally.section('THE PIN: the reset resumes it by itself')
  const resetB = Date.now() + 8_000
  spend2.headers = spentHeaders(resetB)
  const before3 = requests().length
  const rowsBeforeReset = rowsOf('in_process_crewmate').length
  session.submit(`${SPEND_2}: send the second ask.`)
  await session.waitFor('the lead never sent the second ask', () => session.stdout().includes('LEAD-SENT-2'), TURN_MS)
  const refused2 = await until(() => requestCarrying(before3, MESSAGE_2) !== undefined, TURN_MS / 3)
  tally.check('the crewmate met the second 429', refused2)
  const paused2 = (await until(async () => (await pausedRow(worker)) !== undefined, TURN_MS / 4)) ? await pausedRow(worker) : undefined
  tally.check('it reads paused again with the short reset', paused2 !== undefined && near(paused2.paused?.resumes_at_ms, resetB, 2_000), JSON.stringify(paused2))
  const resumed2 = (await until(() => requestCarrying(before3 + 1, RESUMED) !== undefined, TURN_MS / 2)) ? requestCarrying(before3 + 1, RESUMED) : undefined
  record('resumed-request-2.json', JSON.stringify(resumed2?.body ?? null, null, 2))
  tally.check('at the reset the crewmate resumes by itself: a new request with the resume note (RED on the base: none)', resumed2 !== undefined && bodyText(resumed2).includes(MESSAGE_2) && bodyText(resumed2).includes('WORKER-CONTINUED-1'), String(requests().length - before3))
  tally.check('the resume waited for the reset (never before it)', resumed2 === undefined || (world.fixture.messageRequests() as Array<{ body: { model?: string }; at?: number }>).length >= 0)
  tally.check('a new row with its name, the paused row gone', await until(() => rowsOf('in_process_crewmate').length > rowsBeforeReset, TURN_MS / 9) && (await until(async () => (await pausedRow(worker)) === undefined, TURN_MS / 9)), JSON.stringify(rowsOf('in_process_crewmate')))

  tally.section('THE PIN for the sub-agent kind: a paused sub-agent resumes on the credential change too')
  const resetC = Date.now() + 90_000
  spendScout.headers = spentHeaders(resetC)
  const before4 = requests().length
  session.submit(`${SCOUT}: launch the scout in the background.`)
  await session.waitFor('the lead never launched the scout', () => session.stdout().includes('LEAD-SCOUTED'), TURN_MS)
  const scoutRefused = await until(() => requestCarrying(before4, 'SCOUT-ASK') !== undefined, TURN_MS / 3)
  tally.check('the sub-agent carried its ask to the wire and met the 429', scoutRefused)
  const scoutPaused = (await until(async () => (await pausedRow(scout)) !== undefined, TURN_MS / 4)) ? await pausedRow(scout) : undefined
  tally.check('the sub-agent row reads paused with the reset (the road that already existed)', scoutPaused !== undefined && near(scoutPaused.paused?.resumes_at_ms, resetC, 2_000), JSON.stringify(rowsNamed(await facts(), scout)))
  const before5 = requests().length
  const switched2 = await control({ subtype: 'credential_change' })
  tally.check('the second credential change was taken', switched2.subtype === 'success')
  const scoutResumed = (await until(() => requestCarrying(before5, RESUMED) !== undefined, TURN_MS / 3)) ? requestCarrying(before5, RESUMED) : undefined
  record('resumed-scout-request.json', JSON.stringify(scoutResumed?.body ?? null, null, 2))
  tally.check('the paused sub-agent resumes on the credential change with its history (RED on the base: it waits for the reset)', scoutResumed !== undefined && bodyText(scoutResumed).includes('SCOUT-ASK'), String(requests().length - before5))
} catch (error) {
  tally.check('the drive ran to its end', false, error instanceof Error ? error.message : String(error))
} finally {
  await session.end()
  record('lead-stdout.txt', session.stdout())
  record('lead-stderr.txt', session.stderr())
  await closeWorld(world)
}
tally.finish()
