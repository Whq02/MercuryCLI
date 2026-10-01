#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, toolResultOf, treeOf, TURN_MS, type Frame } from './crew-world.ts'

const PEER_MODEL = 'claude-opus-4-6'
const OWNER_ANSWER = 'OWNER-CHAT-ANSWER-STAYS-HERE'
const LEAD_ANSWER = 'LEAD-TASK-ANSWER-DELIVERED'
const lead = (turn: Record<string, unknown>, whenBody?: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, ...(whenBody ? { whenBody } : {}) }) as ScriptedTurn
const peer = (text: string): ScriptedTurn => ({ kind: 'text', text, model: PEER_MODEL, whenModel: 'opus-4-6' }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', id: 'toolu_chat_launch', name: 'Agent', input: { name: 'scribe', model: PEER_MODEL, subagent_type: 'mercury-general', run_in_background: false, description: 'Answer in the right chat', prompt: 'Report ready.' } }, 'SPAWN-SCRIBE'),
  lead({ kind: 'text', text: 'SCRIBE-READY' }, 'SPAWN-SCRIBE'),
  lead({ kind: 'text', text: 'OWNER-BARRIER-DONE' }, 'OWNER-BARRIER'),
  lead({ kind: 'tool_use', id: 'toolu_chat_lead', name: 'SendMessage', input: { to: 'scribe', message: 'LEAD-FOLLOW-UP' } }, 'LEAD-SEND'),
  lead({ kind: 'text', text: 'LEAD-BARRIER-DONE' }, 'LEAD-BARRIER'),
  ...Array.from({ length: 12 }, () => lead({ kind: 'text', text: 'LEAD-ACK' })),
  peer('INITIAL-REPORT'),
  peer(OWNER_ANSWER),
  peer(LEAD_ANSWER),
]
const tally = makeTally('prove-owner-chat-notification')
const world = await makeWorld('owner-chat-notification', script)
const session = bootLead(world, ['--permission-mode', 'sovereign'], ['Agent', 'SendMessage'])
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  const response = (): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)?.response as Frame | undefined
  await session.waitFor(`no response to ${id}`, () => response() !== undefined)
  return response()!
}
const notificationFrames = (from: number, id: string): Frame[] => session.frames.slice(from).filter(frame => frame.subtype === 'task_notification' && frame.task_id === id && frame.status === 'completed')
const leadPrompts = (): string[] => world.fixture.messageRequests().filter(request => (request.body as { model?: string }).model === LEAD_MODEL).map(request => JSON.stringify((request.body as { messages?: unknown }).messages))
const recordText = (): string => treeOf(join(world.config, 'projects')).filter(path => /subagents\/agent-.*\.jsonl$/.test(path)).map(path => readFileSync(join(world.config, 'projects', path), 'utf8')).join('\n')
try {
  session.submit('SPAWN-SCRIBE: start the scribe and wait for its answer.')
  await session.waitFor('the scribe did not finish its first turn', () => session.stdout().includes('SCRIBE-READY'), TURN_MS)
  const receipt = toolResultOf(world, 'toolu_chat_launch')
  const agentId = receipt?.text.match(/agentId: (\S+)/)?.[1]
  tally.check('the fixture launched a real sub-agent with a resumable transcript', agentId !== undefined && recordText().includes('INITIAL-REPORT'), receipt?.text)
  if (agentId === undefined) throw new Error('missing agent id')
  const beforeOwner = session.frames.length
  const resumed = await control('owner-chat', { subtype: 'resume_task', task_id: agentId, note: 'OWNER-FOLLOW-UP: answer me in your crew chat.' })
  tally.check('the crew-view chat road accepts the owner message', resumed.subtype === 'success', JSON.stringify(resumed))
  await session.waitFor('the owner chat turn did not complete', () => notificationFrames(beforeOwner, agentId).length > 0, TURN_MS)
  session.submit('OWNER-BARRIER: confirm the lead is ready for the next task.')
  await session.waitFor('the owner barrier never completed', () => session.stdout().includes('OWNER-BARRIER-DONE'), TURN_MS)
  tally.check('the owner answer remains in the crew chat transcript', recordText().includes(OWNER_ANSWER))

  const beforeLead = session.frames.length
  session.submit('LEAD-SEND: ask the scribe for a new lead task.')
  await session.waitFor('the lead SendMessage did not reach the agent', () => toolResultOf(world, 'toolu_chat_lead') !== null, TURN_MS)
  await session.waitFor('the lead-requested agent turn did not complete', () => notificationFrames(beforeLead, agentId).length > 0, TURN_MS)
  session.submit('LEAD-BARRIER: confirm the next lead task is complete.')
  await session.waitFor('the lead barrier never completed', () => session.stdout().includes('LEAD-BARRIER-DONE'), TURN_MS)
  await session.waitFor('the lead completion never reached the lead model', () => leadPrompts().some(text => text.includes('<task-notification>') && text.includes(LEAD_ANSWER)), TURN_MS)
  const leadDelivered = leadPrompts().filter(text => text.includes('<task-notification>') && text.includes(LEAD_ANSWER))
  record('lead-task-prompts.json', JSON.stringify(leadDelivered, null, 2))
  tally.check('a lead-sent message keeps its completion notification with the full answer', leadDelivered.length > 0, `lead prompts carrying the lead answer=${leadDelivered.length}`)
  const ownerLeaked = leadPrompts().filter(text => text.includes('<task-notification>') && text.includes(OWNER_ANSWER))
  record('owner-lead-prompts.json', JSON.stringify(ownerLeaked, null, 2))
  console.log(`  lead prompts carrying answers: owner=${ownerLeaked.length}, lead=${leadDelivered.length}`)
  tally.check('the owner chat answer never enters a lead task-notification', ownerLeaked.length === 0, `lead prompts carrying the full owner answer=${ownerLeaked.length}`)
  tally.check('the owner chat resume creates no lead inbox receipt either', leadPrompts().every(text => !text.includes('resumed from the crew view')))
} catch (error) {
  tally.check('the fixture reached every checkpoint', false, error instanceof Error ? error.message : String(error))
} finally {
  record('all-requests.json', JSON.stringify(world.fixture.messageRequests(), null, 2))
  record('all-frames.json', JSON.stringify(session.frames, null, 2))
  record('lead-stderr.txt', session.stderr())
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
