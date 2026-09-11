#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 170s')
  process.exit(1)
}, 170_000)
guard.unref?.()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  for (;;) {
    if (cond()) return true
    if (Date.now() > deadline) return false
    await wait(50)
  }
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'wf-control-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-control-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { requestWorkflowControl, serveWorkflowControl, WorkflowExecutionPause, parseWorkflowControlRequest, readWorkflowControlAnswer, workflowControlDir } = await import(
  '../../src/tools/WorkflowTool/runControl.js'
)
const { claimRun, writeRunManifest, readRunClaim } = await import('../../src/tools/WorkflowTool/runManifest.js')
type WorkflowRunManifest = import('../../src/tools/WorkflowTool/runManifest.js').WorkflowRunManifest

console.log('============================================================')
console.log(' Workflow run control — the persistent channel, from any process')
console.log('============================================================')

section('(1) the channel: journaled before the effect, claim-fenced, never replayed')
{
  const runDir = join(scratch, 'channel-run')
  mkdirSync(runDir, { recursive: true })
  const journal: unknown[] = []
  const applied: string[] = []
  const errors: unknown[] = []
  const claim = await claimRun(runDir)
  const manifest: WorkflowRunManifest = {
    version: 1,
    runId: 'wf_channel_fixture',
    runDir,
    status: 'running',
    startTime: 1,
    owner: { instanceId: claim.instanceId, epoch: claim.epoch },
    ownerPid: process.pid,
    controlVersion: 1,
    sessionId: 'launching-session',
    agentCount: 0,
    agents: [],
    totalTokens: 0,
    totalToolCalls: 0,
  }
  await writeRunManifest(manifest)
  const journalStub = { append: async (row: unknown) => void journal.push(row) }
  let close = await serveWorkflowControl({
    runDir,
    claim,
    journal: journalStub,
    apply: async request => {
      check('the request is journaled BEFORE the effect', (journal.at(-1) as { type?: string })?.type === 'control-request')
      applied.push(request.action)
      return { outcome: 'applied', detail: `${request.action} by ${request.by}` }
    },
    onError: e => errors.push(e),
  })
  const stop = await requestWorkflowControl(runDir, { action: 'stop', by: 'second process' })
  check('a second process reaches the current claimed execution', stop.outcome === 'applied' && stop.detail === 'stop by second process', JSON.stringify(stop))
  check('request and result are journaled once each', journal.length === 2 && (journal[1] as { type?: string }).type === 'control-result' && applied.length === 1)
  const files = (await import('node:fs/promises')).readdir(workflowControlDir(runDir))
  const names = await files
  check('the request and its answer stay on disk after the action', names.some(n => n.endsWith('.request.json')) && names.some(n => n.endsWith('.response.json')))
  const requestName = names.find(n => n.endsWith('.request.json'))!
  const raw = readFileSync(join(workflowControlDir(runDir), requestName), 'utf8')
  const parsed = parseWorkflowControlRequest(raw, requestName.slice(0, -'.request.json'.length))
  check('the persisted request names the claim and who asked', parsed !== null && parsed.instanceId === claim.instanceId && parsed.epoch === claim.epoch && parsed.by === 'second process')
  const answer = await readWorkflowControlAnswer(runDir, parsed!.id)
  check('the answer on disk carries the claim and the outcome', answer !== null && answer.instanceId === claim.instanceId && answer.result.outcome === 'applied')
  close()

  close = await serveWorkflowControl({
    runDir,
    claim,
    journal: journalStub,
    apply: async () => {
      applied.push('duplicate')
      return { outcome: 'applied', detail: 'duplicate' }
    },
    onError: e => errors.push(e),
  })
  const pause = await requestWorkflowControl(runDir, { action: 'pause', by: 'launching session' })
  check('a reopened reader never replays an answered request', pause.outcome === 'applied' && applied.length === 2 && !applied.slice(0, -1).includes('duplicate'), JSON.stringify(applied))
  close()

  let failJournal = true
  close = await serveWorkflowControl({
    runDir,
    claim,
    journal: { append: async () => { if (failJournal) throw new Error('fixture journal unavailable') } },
    apply: async () => {
      applied.push('should-not-apply')
      return { outcome: 'applied', detail: 'unexpected' }
    },
    onError: e => errors.push(e),
  })
  const held = await requestWorkflowControl(runDir, { action: 'resume', by: 'launching session' }, { answerMs: 400 })
  check('a failed journal write blocks the action and answers pending, never applied', held.outcome === 'pending' && !applied.includes('should-not-apply') && errors.length > 0, JSON.stringify(held))
  close()
  failJournal = false

  const replacement = await claimRun(runDir)
  close = await serveWorkflowControl({
    runDir,
    claim: replacement,
    journal: journalStub,
    apply: async () => {
      applied.push('stale')
      return { outcome: 'applied', detail: 'unexpected' }
    },
    onError: e => errors.push(e),
  })
  const stale = await requestWorkflowControl(runDir, { action: 'stop', by: 'second process' })
  check('a manifest from an earlier claim is refused without touching execution', stale.outcome === 'refused' && /changed hands/.test(stale.reason) && !applied.includes('stale'), JSON.stringify(stale))
  manifest.owner = { instanceId: replacement.instanceId, epoch: replacement.epoch }
  manifest.status = 'completed'
  await writeRunManifest(manifest)
  const ended = await requestWorkflowControl(runDir, { action: 'stop', by: 'second process' })
  check('a settled run answers the typed cannot-act line', ended.outcome === 'refused' && /already settled — nothing to stop/.test(ended.reason), JSON.stringify(ended))
  close()
  const legacy = join(scratch, 'legacy-run')
  mkdirSync(legacy, { recursive: true })
  await writeRunManifest({ ...manifest, runDir: legacy, status: 'running', controlVersion: undefined })
  const old = await requestWorkflowControl(legacy, { action: 'stop', by: 'second process' })
  check('a run without the channel is refused by name', old.outcome === 'refused' && /predates the persistent control channel/.test(old.reason), JSON.stringify(old))
  const bogus = parseWorkflowControlRequest(JSON.stringify({ version: 1, id: 'x', action: 'stop', by: 'a', instanceId: 'i', epoch: 1, at: 1 }), 'x')
  check('a malformed request never parses', bogus === null)
}

section('(2) the pause seam: parks between model calls, resumes in place, aborts typed')
{
  const pause = new WorkflowExecutionPause()
  const release = pause.register('agent-a')
  const states: Array<string | undefined> = []
  const abort = new AbortController()
  check('an unpaused agent never waits', pause.wait('agent-a', abort.signal, () => {}) === undefined)
  check('pausing a phantom agent is refused', pause.change(true, 'me', 'agent-zz').outcome === 'refused')
  check('resuming an unpaused run is refused with the reason', pause.change(false, 'me').outcome === 'refused')
  const p1 = pause.change(true, 'session abc', 'agent-a')
  check('pause-agent is applied and names who paused', p1.outcome === 'applied' && /paused by session abc/.test(p1.detail) && pause.pausedBy('agent-a') === 'session abc')
  check('pausing twice is refused, naming the holder', pause.change(true, 'other', 'agent-a').outcome === 'refused')
  const waiting = pause.wait('agent-a', abort.signal, by => states.push(by))
  let resolved = false
  void waiting?.then(() => (resolved = true))
  await wait(50)
  check('a paused agent parks (the wait stands) and reports who paused it', !resolved && states[0] === 'session abc')
  pause.change(false, 'session abc', 'agent-a')
  await wait(20)
  check('resume releases the same wait and clears the word', resolved && states.at(-1) === undefined && pause.pausedBy('agent-a') === undefined)
  const p2 = pause.change(true, 'operator')
  check('a run-level pause applies to every registered agent', p2.outcome === 'applied' && pause.pausedBy('agent-a') === 'operator' && pause.runPaused())
  const w2 = pause.wait('agent-a', abort.signal, by => states.push(by))
  let outcome = 'pending'
  void w2?.then(() => (outcome = 'resolved'), () => (outcome = 'rejected'))
  abort.abort('workflow-abort')
  await wait(20)
  check('an abort during a pause rejects typed (never a hung promise)', outcome === 'rejected')
  release()
}

section('(2b) combined controls: resuming one agent under a whole-run pause leaves the other parked and named')
{
  const pause = new WorkflowExecutionPause()
  const releaseA = pause.register('agent-a')
  const releaseB = pause.register('agent-b')
  const abort = new AbortController()
  const statesA: Array<string | undefined> = []
  const statesB: Array<string | undefined> = []
  check('the run pauses both', pause.change(true, 'operator').outcome === 'applied' && pause.pausedBy('agent-a') === 'operator' && pause.pausedBy('agent-b') === 'operator')
  const wa = pause.wait('agent-a', abort.signal, by => statesA.push(by))
  const wb = pause.wait('agent-b', abort.signal, by => statesB.push(by))
  let aDone = false
  let bDone = false
  void wa?.then(() => (aDone = true))
  void wb?.then(() => (bDone = true))
  await wait(30)
  check('both park under the run pause', !aDone && !bDone && statesA[0] === 'operator' && statesB[0] === 'operator')
  const r1 = pause.change(false, 'session xyz', 'agent-a')
  await wait(30)
  check('resume-agent under a run pause is applied and frees that agent only', r1.outcome === 'applied' && aDone && !bDone, JSON.stringify({ r1, aDone, bDone }))
  check('the other agent keeps the pause and its holder\'s name', pause.pausedBy('agent-b') === 'operator' && statesB.at(-1) === 'operator')
  check('the run-level pause word clears (not every agent is paused)', !pause.runPaused() && pause.pausedBy() === undefined && pause.pausedBy('agent-a') === undefined)
  check('a fresh agent joining now is not paused', (() => { const rel = pause.register('agent-c'); const free = pause.wait('agent-c', abort.signal, () => {}) === undefined; rel(); return free })())
  check('resuming the run with only one agent paused is still a resume', pause.change(false, 'operator').outcome === 'applied')
  await wait(30)
  check('that resume frees the remaining agent', bDone && pause.pausedBy('agent-b') === undefined && statesB.at(-1) === undefined)
  check('nothing is left to resume', pause.change(false, 'operator').outcome === 'refused')
  releaseA()
  releaseB()
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function sleepTurn(seconds: number): string {
  const id = `msg_ctrl_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_ctrl_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`, name: 'Sleep', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ seconds }) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
const requests: Array<{ agent: string; at: number; raw: string }> = []
const fixture = (await import('node:http')).createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.method !== 'POST' || !(req.url ?? '').includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const agent = raw.includes('alpha:') ? 'alpha' : raw.includes('beta:') ? 'beta' : 'other'
    requests.push({ agent, at: Date.now(), raw })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sleepTurn(1))
  })
})
const PORT = Number(process.env.WF_CONTROL_PORT ?? 34931)
await new Promise<void>(resolve => fixture.listen(PORT, '127.0.0.1', resolve))
const requestsOf = (agent: string): number => requests.filter(r => r.agent === agent).length

const CHILD = String.raw`
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
delete process.env.NODE_ENV
await import('${REPO}/src/tasks.js')
const { enableConfigs } = await import('${REPO}/src/utils/config/globalConfig.js')
enableConfigs()
const { WorkflowTool } = await import('${REPO}/src/tools/WorkflowTool/WorkflowTool.js')
const { getDefaultAppState } = await import('${REPO}/src/state/AppStateStore.js')
const emit = (o: unknown) => console.log('@@' + JSON.stringify(o))
let state: any = getDefaultAppState()
const setAppState = (fn: any) => { state = typeof fn === 'function' ? fn(state) : fn }
const ctx: any = {
  getAppState: () => state,
  setAppState,
  setAppStateForTasks: setAppState,
  options: { mainLoopModel: 'claude-opus-4-8', mcpClients: [], mcpResources: {}, tools: [], commands: [], debug: false, verbose: false, isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
  abortController: new AbortController(),
  toolUseId: 'control-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}
const script = "export const meta = { name: 'control-fixture', description: 'two agents that run until told', phases: [{ title: 'Work' }] }\nphase('Work')\nconst [a, b] = await parallel([() => agent('alpha: keep sleeping one second at a time until stopped', { label: 'alpha' }), () => agent('beta: keep sleeping one second at a time until stopped', { label: 'beta' })])\nreturn { a, b }"
const res = await WorkflowTool.call({ script }, ctx, async () => ({ behavior: 'allow' }))
const d = res.data
emit({ ev: 'launched', runId: d.runId, runDir: d.transcriptDir, taskId: d.taskId, error: d.error ?? null })
for (let i = 0; i < 1800; i++) {
  const t: any = state.tasks[d.taskId]
  if (t && t.status !== 'running') {
    let manifest: any = null
    for (let j = 0; j < 100; j++) {
      manifest = JSON.parse(readFileSync(join(d.transcriptDir, 'run.json'), 'utf8'))
      if (manifest.status !== 'running') break
      await new Promise(r => setTimeout(r, 100))
    }
    emit({ ev: 'settled', task: t.status, manifest: manifest.status, endedBy: manifest.endedBy ?? null, agents: manifest.agents.map((a: any) => ({ label: a.label, state: a.state, error: a.error ?? null, endedBy: a.endedBy ?? null })), error: t.error ?? null })
    process.exit(0)
  }
  await new Promise(r => setTimeout(r, 100))
}
emit({ ev: 'timeout' })
process.exit(1)
`
writeFileSync(join(scratch, 'child.ts'), CHILD)

function readLines(out: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('@@')) continue
    try {
      rows.push(JSON.parse(line.slice(2)))
    } catch {}
  }
  return rows
}

function readManifest(runDir: string): { status: string; pausedBy?: string; endedBy?: string; agents: Array<{ label: string; state: string; waiting?: string; pausedBy?: string; error?: string; endedBy?: string }> } {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
}
function journalRows(runDir: string): Array<Record<string, unknown>> {
  const p = join(runDir, 'journal.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

let child: ChildProcess | undefined
let out = ''
const cwd = join(scratch, 'product-cwd')
mkdirSync(cwd, { recursive: true })
const fixtureEnv = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR!,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_NO_SELF_WARM: '1',
}

section('(3) the product: pause and resume one agent, kill the other, stop the run — from ANOTHER process')
child = spawn(BUN, ['run', join(scratch, 'child.ts')], { cwd, env: { ...process.env, ...fixtureEnv } })
child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
let childErr = ''
child.stderr?.on('data', (d: Buffer) => (childErr += d.toString()))
const launched = await until(() => out.includes('"ev":"launched"'), 60_000)
check('the child launched a two-agent run (the real tool path)', launched, (out + childErr).slice(-400))
if (launched) {
  const line = readLines(out).find(l => l.ev === 'launched')!
  check('the launch carried no error', line.error === null, String(line.error))
  const runDir = String(line.runDir)
  const claim = await readRunClaim(runDir)
  check('the run dir carries a claim and the control directory', claim !== undefined && existsSync(workflowControlDir(runDir)))
  const bothTurning = await until(() => requestsOf('alpha') >= 2 && requestsOf('beta') >= 2, 60_000)
  check('both agents are taking turns on the wire', bothTurning, `alpha ${requestsOf('alpha')} beta ${requestsOf('beta')} · ${childErr.slice(-300)}`)
  const manifestBefore = await until(() => readManifest(runDir).agents.length === 2, 15_000)
  check('run.json lists both agents and claims the channel', manifestBefore && (readManifest(runDir) as { controlVersion?: number }).controlVersion === 1 && readManifest(runDir).status === 'running')
  const idOf = (label: string): string | undefined => (readManifest(runDir).agents.find(a => a.label === label) as { agentId?: string } | undefined)?.agentId
  await until(() => idOf('alpha') !== undefined && idOf('beta') !== undefined, 15_000)
  const alphaBefore = idOf('alpha')!

  const pauseRes = await requestWorkflowControl(runDir, { action: 'pause-agent', by: 'second process', agentId: alphaBefore })
  check('p over alpha from the second process: applied, naming who paused', pauseRes.outcome === 'applied' && /paused by second process/.test(pauseRes.detail), JSON.stringify(pauseRes))
  const pausedRow = await until(() => readManifest(runDir).agents.some(a => a.label === 'alpha' && a.waiting === 'operator' && a.pausedBy === 'second process'), 20_000)
  check("alpha's row in run.json reads paused, by whom (it parked before its next model call)", pausedRow, JSON.stringify(readManifest(runDir).agents))
  const alphaAtPark = requestsOf('alpha')
  const betaAtPark = requestsOf('beta')
  await wait(3_000)
  check('a paused alpha sends no further requests while beta keeps going', requestsOf('alpha') === alphaAtPark && requestsOf('beta') > betaAtPark, `alpha ${alphaAtPark}→${requestsOf('alpha')} beta ${betaAtPark}→${requestsOf('beta')}`)
  const twice = await requestWorkflowControl(runDir, { action: 'pause-agent', by: 'second process', agentId: alphaBefore })
  check('pausing an already paused agent is refused with the holder', twice.outcome === 'refused' && /already paused by second process/.test(twice.reason), JSON.stringify(twice))

  const resumeRes = await requestWorkflowControl(runDir, { action: 'resume-agent', by: 'second process', agentId: alphaBefore })
  check('p again resumes alpha in place (the same attempt, no relaunch)', resumeRes.outcome === 'applied' && /resumed by second process/.test(resumeRes.detail), JSON.stringify(resumeRes))
  const released = await until(() => requestsOf('alpha') > alphaAtPark, 20_000)
  check('alpha sends requests again after the resume', released, `alpha ${alphaAtPark}→${requestsOf('alpha')}`)
  const unpausedRow = await until(() => readManifest(runDir).agents.some(a => a.label === 'alpha' && a.waiting !== 'operator' && a.pausedBy === undefined), 15_000)
  check("alpha's row drops the paused word", unpausedRow, JSON.stringify(readManifest(runDir).agents))
  check('alpha keeps ONE agent id across pause and resume (no new attempt)', idOf('alpha') === alphaBefore)

  const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.js')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  let sendState = getDefaultAppState()
  const sendCtx = {
    getAppState: () => sendState,
    setAppState: (u: (p: typeof sendState) => typeof sendState) => { sendState = u(sendState) },
    setAppStateForTasks: (u: (p: typeof sendState) => typeof sendState) => { sendState = u(sendState) },
    options: { tools: [] },
    abortController: new AbortController(),
    messages: [],
  } as never
  const word = `harbour-count-${Date.now()}`
  const sent = (await runWithCwdOverride(cwd, () => SendMessageTool.call({ to: alphaBefore, message: `alpha: ${word}` } as never, sendCtx, undefined as never, { requestId: 'req_wf_msg' } as never))) as { data: { success: boolean; message: string } }
  check('SendMessage to a worker of a run this process does not own rides the control channel', sent.data.success === true && /Message queued for worker/.test(sent.data.message) && /journal/.test(sent.data.message), sent.data.message.slice(0, 200))
  const heard = await until(() => requests.some(r => r.agent === 'alpha' && r.raw.includes(word)), 20_000)
  check('alpha reads the message at its next step (the wire carries the words)', heard, `alpha requests ${requestsOf('alpha')}`)
  const heardBy = requests.filter(r => r.raw.includes(word)).map(r => r.agent)
  check('only alpha reads it — beta never sees the words', heardBy.length > 0 && heardBy.every(a => a === 'alpha'), JSON.stringify(heardBy))
  const phantom = (await runWithCwdOverride(cwd, () => SendMessageTool.call({ to: 'a0123456789abcdef', message: 'anyone there' } as never, sendCtx, undefined as never, { requestId: 'req_wf_msg2' } as never))) as { data: { success: boolean; message: string } }
  check('an id no live run carries falls through to the transcript road (its own precise refusal)', phantom.data.success === false && /no transcript/i.test(phantom.data.message), phantom.data.message.slice(0, 160))

  const betaId = idOf('beta')!
  const killRes = await requestWorkflowControl(runDir, { action: 'kill-agent', by: 'second process', agentId: betaId })
  check('x over beta kills it: applied, naming who killed', killRes.outcome === 'applied' && /killed by second process/.test(killRes.detail), JSON.stringify(killRes))
  const betaKilled = await until(() => readManifest(runDir).agents.some(a => a.label === 'beta' && a.state === 'error' && a.error === 'killed by the operator' && a.endedBy === 'operator'), 20_000)
  check("beta's row reads error · killed by the operator, ended by the operator", betaKilled, JSON.stringify(readManifest(runDir).agents))
  const betaAtKill = requestsOf('beta')
  await wait(2_500)
  check('a killed beta sends no further requests (no retry ladder)', requestsOf('beta') === betaAtKill, `${betaAtKill}→${requestsOf('beta')}`)
  const killAgain = await requestWorkflowControl(runDir, { action: 'kill-agent', by: 'second process', agentId: betaId })
  check('killing a settled agent is refused: already settled', killAgain.outcome === 'refused' && /already settled — nothing to kill/.test(killAgain.reason), JSON.stringify(killAgain))
  check('alpha is still alive after beta was killed (the run keeps its fan-out)', readManifest(runDir).agents.some(a => a.label === 'alpha' && (a.state === 'progress' || a.state === 'start')) && readManifest(runDir).status === 'running')

  const stopRes = await requestWorkflowControl(runDir, { action: 'stop', by: 'second process' }, { answerMs: 30_000 })
  check('x on the list stops the run from the second process', stopRes.outcome === 'applied' && /stopped by second process/.test(stopRes.detail), JSON.stringify(stopRes))
  const settledSeen = await until(() => out.includes('"ev":"settled"'), 30_000)
  check('the launching process settled the run', settledSeen, out.slice(-300))
  const settled = readLines(out).find(l => l.ev === 'settled') as Record<string, unknown> | undefined
  check('the task reads killed and run.json reads killed, ended by the second process', settled?.task === 'killed' && settled?.manifest === 'killed' && settled?.endedBy === 'second process', JSON.stringify(settled))
  const agents = (settled?.agents as Array<{ label: string; state: string; error: string | null }>) ?? []
  check('alpha (live at the stop) settled as stopped; beta keeps its killed record', agents.some(a => a.label === 'alpha' && a.state === 'stopped') && agents.some(a => a.label === 'beta' && a.state === 'error' && a.error === 'killed by the operator'), JSON.stringify(agents))
  check('the journal, the claim, the manifest and the control records stay on disk', existsSync(join(runDir, 'journal.jsonl')) && existsSync(join(runDir, 'claim.json')) && existsSync(join(runDir, 'run.json')) && existsSync(workflowControlDir(runDir)))
  const rows = journalRows(runDir)
  const acts = rows.filter(r => r.type === 'control-request').map(r => (r.request as { action: string }).action)
  const results = rows.filter(r => r.type === 'control-result').map(r => `${r.action}:${(r.result as { outcome: string }).outcome}`)
  check('every act is journaled: the request then its result, in order', JSON.stringify(acts) === JSON.stringify(['pause-agent', 'pause-agent', 'resume-agent', 'message-agent', 'kill-agent', 'kill-agent', 'stop']) && JSON.stringify(results) === JSON.stringify(['pause-agent:applied', 'pause-agent:refused', 'resume-agent:applied', 'message-agent:applied', 'kill-agent:applied', 'kill-agent:refused', 'stop:applied']), `${JSON.stringify(acts)} ${JSON.stringify(results)}`)
  check('every control row carries the owner epoch', rows.filter(r => r.type === 'control-request' || r.type === 'control-result').every(r => typeof r.epoch === 'number'))
  const after = await requestWorkflowControl(runDir, { action: 'pause', by: 'second process' })
  check('after the stop the channel answers already settled', after.outcome === 'refused' && /already settled/.test(after.reason), JSON.stringify(after))
}
child?.kill('SIGKILL')
await new Promise<void>(resolve => fixture.close(() => resolve()))

rmSync(scratch, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL RUN-CONTROL CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
