#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, sleep, treeOf, TURN_MS, type Frame } from './team-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const team = 'continuation-team'
const peerModel = 'claude-opus-4-6'
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6' }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'TeamCreate', input: { team_name: team, description: 'Transcript continuation' } }),
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'worker', team_name: team, model: peerModel, subagent_type: 'mercury-general', description: 'Retain the conversation', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }),
  lead({ kind: 'text', text: 'LEAD-PARKED' }),
  ...Array.from({ length: 12 }, () => lead({ kind: 'text', text: 'LEAD-ACK' })),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'text', text: 'CONTINUED-FROM-HISTORY' }),
]
const tally = makeTally('prove-teammate-transcript-resume')
const world = await makeWorld('teammate-transcript-resume', script)
const session = bootLead(world, ['--permission-mode', 'sovereign'], ['Agent', 'Bash', 'TeamCreate'])
const response = (id: string): Frame | undefined => session.frames.find(frame => frame.type === 'control_response' && (frame.response as Frame | undefined)?.request_id === id)
const control = async (id: string, request: Frame): Promise<Frame> => {
  session.child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
  await session.waitFor(`no control response for ${id}`, () => response(id) !== undefined)
  return response(id)!.response as Frame
}
type Request = { body: { model?: string; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => (world.fixture.messageRequests() as Request[]).filter(request => request.body.model === peerModel)
const projects = join(world.config, 'projects')
const transcripts = (): string[] => treeOf(projects).filter(path => /subagents\/agent-a[0-9a-z]{8}\.jsonl$/.test(path))
const NOTE = 'CONTINUE-NOW'
const lastUser = (request: Request): string => {
  const last = request.body.messages?.at(-1)
  return last?.role === 'user' ? JSON.stringify(last.content) : ''
}
const continuationAfter = (from: number): Request | undefined => requests().slice(from).find(request => lastUser(request).includes(NOTE))

try {
  session.submit('Create a team, spawn the worker, and park.')
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const started = session.frames.find(frame => frame.subtype === 'task_started' && frame.task_type === 'in_process_teammate')
  const taskId = started?.task_id
  tally.check('the fixture starts a real in-process teammate with a history-bearing tool result', typeof taskId === 'string' && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (typeof taskId !== 'string') throw new Error('the fixture has no teammate task id')
  const stopped = await control('stop-worker', { subtype: 'stop_task', task_id: taskId })
  tally.check('the crew stop road stops the working teammate', stopped.subtype === 'success', JSON.stringify(stopped))
  await sleep(3500)
  const before = transcripts()
  tally.check('the stopped teammate\'s transcript stands on disk after the stop and the eviction', before.length === 1 && readFileSync(join(projects, before[0]!), 'utf8').includes('HISTORY-WITNESS'), JSON.stringify(before))
  const beforeResume = requests().length
  const resumed = await control('resume-worker', { subtype: 'resume_task', task_id: taskId, note: `${NOTE}: use your existing conversation.` })
  record('resume-response.json', JSON.stringify(resumed, null, 2))
  tally.check('r can resume the stopped row after its ephemeral task has been evicted', resumed.subtype === 'success', JSON.stringify(resumed))
  if (resumed.subtype === 'success') {
    await session.waitFor('the resumed teammate did not make a request carrying the note', () => continuationAfter(beforeResume) !== undefined, TURN_MS)
    const continued = continuationAfter(beforeResume) ?? requests()[beforeResume]!
    const history = JSON.stringify(continued.body.messages)
    record('continued-request.json', JSON.stringify(continued.body, null, 2))
    tally.check('the resumed request retains the prior tool result rather than restarting the prompt', history.includes('"tool_result"') && history.includes('HISTORY-WITNESS'), history.slice(-600))
    const last = continued.body.messages?.at(-1)
    tally.check('the continuation is the next user turn after the retained history', last?.role === 'user' && JSON.stringify(last.content).includes(NOTE), JSON.stringify(last))
    tally.check('the original model remains selected', continued.body.model === peerModel)
    const landed = (): boolean => transcripts().some(path => readFileSync(join(projects, path), 'utf8').includes(NOTE))
    const until = Date.now() + TURN_MS / 6
    while (!landed() && Date.now() < until) await sleep(100)
    const after = transcripts()
    tally.check('the resumed turn lands on the same transcript file: one transcript for the teammate, the note after the history', landed() && after.length === 1 && after[0] === before[0], JSON.stringify(after))
  }
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
