#!/usr/bin/env bun
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { closeWorld, DIST, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, NODE, record, sleep, treeOf, TURN_MS } from './crew-world.ts'

if (process.env.MERCURY_CONFIG_DIR) process.env.TMPDIR = process.env.MERCURY_CONFIG_DIR
const peerModel = 'claude-opus-4-6'
const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: peerModel, whenModel: 'opus-4-6' }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead({ kind: 'tool_use', name: 'Agent', input: { name: 'worker', crew_name: 'crew', model: peerModel, subagent_type: 'mercury-crew', description: 'Retain the conversation', prompt: 'Run pwd and retain HISTORY-WITNESS in your reasoning.' } }),
  lead({ kind: 'text', text: 'LEAD-PARKED' }),
  ...Array.from({ length: 12 }, () => lead({ kind: 'text', text: 'LEAD-ACK' })),
  peer({ kind: 'tool_use', name: 'Bash', input: { command: 'printf HISTORY-WITNESS', description: 'Record the history witness' } }),
  peer({ kind: 'paced', deltas: ['STILL-WORKING', '.', '.', '.', '.', '.'], gapMs: 5000 }),
  peer({ kind: 'text', text: 'CONTINUED-FROM-HISTORY' }),
]
const tally = makeTally('prove-crewmate-transcript-resume')
const world = await makeWorld('crewmate-transcript-resume', script)
const frames: Frame[] = []
let rowsOut = ''
let leadErr = ''
const refusals: string[] = []
const host = hostRunner({
  node: NODE,
  dist: DIST,
  argv: ['--model', LEAD_MODEL, '--allowed-tools', 'Agent', 'Bash', '--mode', 'sovereign'],
  cwd: world.project,
  env: world.env as Record<string, string | undefined>,
  home: world.env.MERCURY_CONFIG_DIR ?? world.project,
  raw: text => {
    rowsOut += text
  },
  onRow: frame => frames.push(frame),
})
host.child.stderr!.on('data', (chunk: Buffer) => {
  leadErr += chunk.toString('utf8')
})
void host.initialize().catch(() => undefined)
const wire = host.peer
let leadDone = false
const leadExited = new Promise<number | null>(resolveExit => host.child.on('close', code => {
  leadDone = true
  resolveExit(code)
}))
const session = {
  frames,
  stdout: (): string => rowsOut,
  stderr: (): string => leadErr,
  submit: (text: string): void => {
    wire.request('queue/add', { type: 'prompt', content: text }, { deadlineMs: TURN_MS }).catch((error: unknown) => {
      refusals.push(`queue/add: ${error instanceof Error ? error.message : String(error)}`)
    })
  },
  waitFor: async (label: string, test: () => boolean, timeoutMs = TURN_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!test()) {
      if (leadDone || Date.now() >= deadline) throw new Error(`${label}\n--- rows tail ---\n${rowsOut.slice(-1500)}\n--- stderr tail ---\n${leadErr.slice(-1500)}\n--- queue ---\n${refusals.join('\n')}`)
      await sleep(25)
    }
  },
  terminate: async (): Promise<number | null> => {
    host.child.kill('SIGTERM')
    const code = await Promise.race([leadExited, sleep(60_000).then(() => null)])
    if (!leadDone) host.child.kill('SIGKILL')
    host.peer.close('the proof ended')
    return code
  },
}
const answerOf = (request: Promise<unknown>): Promise<Frame> => request.then(receipt => receipt as Frame, (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }))
const stopAgent = (agentId: string): Promise<Frame> => answerOf(wire.request('agent/stop', { agent_id: agentId }, { deadlineMs: TURN_MS }))
const resumeAgent = (agentId: string, note: string): Promise<Frame> => answerOf(wire.request('agent/resume', { agent_id: agentId, note }, { deadlineMs: TURN_MS }))
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
  session.submit('Spawn the worker and park.')
  await session.waitFor('the worker did not start its second request', () => requests().length >= 2 && session.stdout().includes('LEAD-PARKED'), TURN_MS)
  const started = session.frames.find(frame => frame.type === 'task' && frame.state === 'started' && frame.task_type === 'in_process_crewmate')
  const taskId = started?.task_id
  tally.check('the fixture starts a real in-process crewmate with a history-bearing tool result', typeof taskId === 'string' && JSON.stringify(requests()[1]?.body.messages).includes('HISTORY-WITNESS'))
  if (typeof taskId !== 'string') throw new Error('the fixture has no crewmate task id')
  const stopped = await stopAgent(taskId)
  tally.check('the crew stop road stops the working crewmate', stopped.receipt === 'applied', JSON.stringify(stopped))
  await sleep(3500)
  const before = transcripts()
  tally.check('the stopped crewmate\'s transcript stands on disk after the stop and the eviction', before.length === 1 && readFileSync(join(projects, before[0]!), 'utf8').includes('HISTORY-WITNESS'), JSON.stringify(before))
  const beforeResume = requests().length
  const resumed = await resumeAgent(taskId, `${NOTE}: use your existing conversation.`)
  record('resume-response.json', JSON.stringify(resumed, null, 2))
  const resumedOk = resumed.refused === undefined && typeof resumed.agent_id === 'string'
  tally.check('r can resume the stopped row after its ephemeral task has been evicted', resumedOk, JSON.stringify(resumed))
  if (resumedOk) {
    await session.waitFor('the resumed crewmate did not make a request carrying the note', () => continuationAfter(beforeResume) !== undefined, TURN_MS)
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
    tally.check('the resumed turn lands on the same transcript file: one transcript for the crewmate, the note after the history', landed() && after.length === 1 && after[0] === before[0], JSON.stringify(after))
  }
} finally {
  await session.terminate()
  await closeWorld(world)
}
tally.finish()
