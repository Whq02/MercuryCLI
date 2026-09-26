#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const framesDir = arg('--frames')

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')
const scratch = mkdtempSync(join(tmpdir(), 'wf-pause-'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wf-pause-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_LIVE_GLYPHS = '0'

const runControl = await import('../../src/tools/WorkflowTool/runControl.js')
const { WorkflowExecutionPause, requestWorkflowControl, serveWorkflowControl } = runControl
const manifestModule = await import('../../src/tools/WorkflowTool/runManifest.js')
const { claimRun, writeRunManifest, recordedOwnerAlive, partitionDiskRuns, diskResumability, RUN_MANIFEST_STALE_MS } = manifestModule
type WorkflowRunManifest = import('../../src/tools/WorkflowTool/runManifest.js').WorkflowRunManifest
type PausePosition = { after: number; next: Array<{ label: string; phaseTitle?: string }> }
type PauseSeam = {
  park?: (call: { label: string; phaseTitle?: string }, after: number, signal: AbortSignal) => Promise<void> | undefined
  position?: () => PausePosition | undefined
  onPosition?: (listener: () => void) => () => void
}
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex')

console.log('============================================================')
console.log(' Workflow pause — park at the next call, save the position, resume from it')
console.log('============================================================')

section('(1) the seam: a run pause parks the next agent() call before it starts; resume releases it; the position is known')
{
  const pause = new WorkflowExecutionPause()
  const seam = pause as unknown as PauseSeam
  const abort = new AbortController()
  check('the seam has a script-level park beside the per-agent wait', typeof seam.park === 'function' && typeof seam.position === 'function' && typeof seam.onPosition === 'function')
  if (typeof seam.park === 'function' && typeof seam.position === 'function' && typeof seam.onPosition === 'function') {
    check('an unpaused run never parks a call', seam.park({ label: 'second probe', phaseTitle: 'Work' }, 1, abort.signal) === undefined && seam.position() === undefined)
    const release = pause.register('agent-a')
    check('pause-agent parks that agent only, never the script', pause.change(true, 'operator', 'agent-a').outcome === 'applied' && seam.park({ label: 'second probe', phaseTitle: 'Work' }, 1, abort.signal) === undefined)
    pause.change(false, 'operator', 'agent-a')
    release()
    const heard: Array<PausePosition | undefined> = []
    const off = seam.onPosition(() => heard.push(seam.position?.()))
    check('the run pause applies', pause.change(true, 'operator').outcome === 'applied')
    const parked = seam.park({ label: 'second probe', phaseTitle: 'Work' }, 1, abort.signal)
    let released = false
    void parked?.then(() => (released = true))
    await wait(30)
    check('the next call parks (the wait stands, nothing spawned)', parked !== undefined && !released)
    const position = seam.position()
    check('the position names the step: after 1 call, next "second probe" in Work', position?.after === 1 && position.next.length === 1 && position.next[0]?.label === 'second probe' && position.next[0]?.phaseTitle === 'Work', JSON.stringify(position))
    check('the position listener heard the park', heard.length >= 1 && heard.at(-1)?.after === 1)
    const parkedToo = seam.park({ label: 'third probe', phaseTitle: 'Work' }, 1, abort.signal)
    await wait(10)
    check('a second parked call joins the position (a fan-out parks whole)', seam.position()?.next.length === 2, JSON.stringify(seam.position()))
    pause.change(false, 'operator')
    await wait(20)
    let releasedToo = false
    void parkedToo?.then(() => (releasedToo = true))
    await wait(10)
    check('resume releases every parked call and clears the position', released && releasedToo && seam.position() === undefined && heard.at(-1) === undefined)
    off()
    pause.change(true, 'operator')
    const parkedThenKilled = seam.park({ label: 'fourth probe' }, 3, abort.signal)
    let outcome = 'pending'
    void parkedThenKilled?.then(() => (outcome = 'resolved'), () => (outcome = 'rejected'))
    abort.abort('workflow-abort')
    await wait(20)
    check('a kill during the park drops the position and never lets the call proceed (a kill still kills)', seam.position() === undefined && outcome !== 'resolved', outcome)
  }
}

section('(2) the record: paused + fresh heartbeat is a parked live owner (P there resumes it); paused + stale heartbeat is saved on disk (the run id resumes it)')
{
  const now = 1_800_000_000_000
  const fresh = now - 1_000
  const stale = now - RUN_MANIFEST_STALE_MS - 1
  check('recordedOwnerAlive: a paused manifest with a fresh heartbeat is alive', recordedOwnerAlive({ status: 'paused' }, fresh, now) === true)
  check('recordedOwnerAlive: a paused manifest with a stale heartbeat is gone', recordedOwnerAlive({ status: 'paused' }, stale, now) === false)
  const rows = [
    { runId: 'parked', status: 'paused' as const, ownerPid: 424242, mtimeMs: fresh },
    { runId: 'saved', status: 'paused' as const, ownerPid: 424242, mtimeMs: stale },
  ]
  const parts = partitionDiskRuns(rows, new Set(), now, () => false)
  check('the board files a parked live run under External and a saved one under Past', parts.external.length === 1 && parts.external[0]?.runId === 'parked' && parts.past.length === 1 && parts.past[0]?.runId === 'saved', JSON.stringify(parts))
  const savedDir = join(scratch, 'saved-run')
  mkdirSync(savedDir, { recursive: true })
  const source = "export const meta = { name: 'saved', description: 'd' }\nreturn 1"
  writeFileSync(join(savedDir, 'workflow.js'), source)
  const deps = {
    pidAlive: () => false,
    fileExists: existsSync,
    readFileText: (p: string): string | undefined => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    sha256,
    nowMs: now,
  }
  const parked = diskResumability({ runDir: savedDir, ownerPid: 1, status: 'paused', scriptDigest: sha256(source), mtimeMs: fresh }, deps)
  check('R never relaunches a parked live run (never two writers)', !parked.ok && /parked|healthy owner/.test((parked as { reason: string }).reason ?? ''), JSON.stringify(parked))
  const saved = diskResumability({ runDir: savedDir, ownerPid: 1, status: 'paused', scriptDigest: sha256(source), mtimeMs: stale }, deps)
  check('a saved paused run resumes from disk', saved.ok, JSON.stringify(saved))

  const runDir = join(scratch, 'channel-run')
  mkdirSync(runDir, { recursive: true })
  const claim = await claimRun(runDir)
  const manifest: WorkflowRunManifest = {
    version: 1,
    runId: 'wf_pause_channel',
    runDir,
    status: 'paused',
    pausedBy: 'operator',
    startTime: 1,
    owner: { instanceId: claim.instanceId, epoch: claim.epoch },
    ownerPid: process.pid,
    controlVersion: 1,
    agentCount: 1,
    agents: [],
    totalTokens: 0,
    totalToolCalls: 0,
  }
  await writeRunManifest(manifest)
  const applied: string[] = []
  const close = await serveWorkflowControl({
    runDir,
    claim,
    journal: { append: async () => {} },
    apply: async request => {
      applied.push(request.action)
      return { outcome: 'applied', detail: `${request.action} by ${request.by}` }
    },
    onError: () => {},
  })
  const resumed = await requestWorkflowControl(runDir, { action: 'resume', by: 'second process' })
  check('P over a parked live run reaches it through the channel (resume applied)', resumed.outcome === 'applied' && applied.includes('resume'), JSON.stringify(resumed))
  const stopped = await requestWorkflowControl(runDir, { action: 'stop', by: 'second process' })
  check('x over a parked live run reaches it too (a kill still kills)', stopped.outcome === 'applied' && applied.includes('stop'), JSON.stringify(stopped))
  close()
  const old = (Date.now() - RUN_MANIFEST_STALE_MS - 5_000) / 1000
  utimesSync(join(runDir, 'run.json'), old, old)
  const gone = await requestWorkflowControl(runDir, { action: 'resume', by: 'second process' })
  check('a paused run whose owner is gone is refused with the resume-from-the-run-id words', gone.outcome === 'refused' && /run id/.test(gone.reason), JSON.stringify(gone))
}

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function textTurn(text: string): string {
  const id = `msg_pause_${Date.now() % 1e6}_${Math.floor(Math.random() * 1e4)}`
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'fixture-anthropic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
const WORD: Record<string, string> = { first: 'ALPHA', second: 'BETA', third: 'GAMMA', other: 'OMEGA' }
const requests: Array<{ agent: string; at: number }> = []
let releaseFirst: () => void = () => {}
let firstGate: Promise<void> = Promise.resolve()
const armFirstGate = (): void => {
  firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
}
const fixture = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.method !== 'POST' || !(req.url ?? '').includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const agent = raw.includes('first:') ? 'first' : raw.includes('second:') ? 'second' : raw.includes('third:') ? 'third' : 'other'
    requests.push({ agent, at: Date.now() })
    const reply = (): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(textTurn(WORD[agent] ?? 'OMEGA'))
    }
    if (agent === 'first') void firstGate.then(reply)
    else reply()
  })
})
const PORT = Number(process.env.WF_PAUSE_PORT ?? 34937)
await new Promise<void>(resolve => fixture.listen(PORT, '127.0.0.1', resolve))
const requestsOf = (agent: string, since = 0): number => requests.filter(r => r.agent === agent && r.at >= since).length

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
  toolUseId: 'pause-tool-use',
  readFileState: { readFileState: new Map(), clear: () => {} },
}
const script = "export const meta = { name: 'pause-fixture', description: 'three calls in a row', phases: [{ title: 'Work' }] }\nphase('Work')\nconst a = await agent('first: answer with your word', { label: 'first' })\nconst b = await agent('second: answer with your word', { label: 'second' })\nconst c = await agent('third: answer with your word', { label: 'third' })\nreturn [a, b, c].join('|')"
const mode = process.env.PAUSE_MODE
const input: any = mode === 'resume' ? { scriptPath: process.env.PAUSE_SCRIPT_PATH, resumeFromRunId: process.env.PAUSE_RESUME_RUN } : { script }
let res: any
try {
  res = await WorkflowTool.call(input, ctx, async () => ({ behavior: 'allow' }))
} catch (e) {
  emit({ ev: 'threw', message: (e as Error).message })
  process.exit(0)
}
const d = res.data
emit({ ev: 'launched', runId: d.runId, runDir: d.transcriptDir, taskId: d.taskId, scriptPath: d.scriptPath, error: d.error ?? null })
for (let i = 0; i < 1800; i++) {
  const t: any = state.tasks[d.taskId]
  if (t && t.status !== 'running') {
    let manifest: any = null
    for (let j = 0; j < 100; j++) {
      manifest = JSON.parse(readFileSync(join(d.transcriptDir, 'run.json'), 'utf8'))
      if (manifest.status !== 'running' && manifest.status !== 'paused') break
      await new Promise(r => setTimeout(r, 100))
    }
    emit({ ev: 'settled', task: t.status, manifest: manifest.status, endedBy: manifest.endedBy ?? null, pausedBy: manifest.pausedBy ?? null, pausedAt: manifest.pausedAt ?? null, result: t.result ?? null, error: t.error ?? null, agents: manifest.agents.map((a: any) => ({ label: a.label, state: a.state, cached: a.cached ?? false })) })
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
type ManifestOnDisk = { status: string; pausedBy?: string; pausedAt?: PausePosition; endedBy?: string; agentCount: number; agents: Array<{ label: string; state: string; waiting?: string; pausedBy?: string; cached?: boolean }> }
function readManifest(runDir: string): ManifestOnDisk {
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
const cwd = join(scratch, 'product-cwd')
mkdirSync(cwd, { recursive: true })
const fixtureEnv = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR!,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_NO_SELF_WARM: '1',
}
type Child = { proc: ChildProcess; out: () => string; err: () => string }
function launchChild(mode: string, extra: Record<string, string> = {}): Child {
  let out = ''
  let err = ''
  const proc = spawn(BUN, ['run', join(scratch, 'child.ts')], { cwd, env: { ...process.env, ...fixtureEnv, PAUSE_MODE: mode, ...extra } })
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
  proc.stderr?.on('data', (d: Buffer) => (err += d.toString()))
  return { proc, out: () => out, err: () => err }
}

async function pauseAfterTheFirst(child: Child, who: string): Promise<{ runDir: string; scriptPath: string; runId: string } | undefined> {
  const launched = await until(() => child.out().includes('"ev":"launched"'), 60_000)
  check(`${who}: the child launched the three-call run (the real tool path)`, launched, (child.out() + child.err()).slice(-400))
  if (!launched) return undefined
  const line = readLines(child.out()).find(l => l.ev === 'launched')!
  check(`${who}: the launch carried no error`, line.error === null, String(line.error))
  const runDir = String(line.runDir)
  const firstOnTheWire = await until(() => requestsOf('first') >= 1, 60_000)
  check(`${who}: the first call is on the wire (held by the fixture)`, firstOnTheWire, child.err().slice(-300))
  const paused = await requestWorkflowControl(runDir, { action: 'pause', by: 'operator' })
  check(`${who}: p over the run: the pause verb is applied`, paused.outcome === 'applied', JSON.stringify(paused))
  releaseFirst()
  const firstCached = await until(() => journalRows(runDir).some(r => r.type === 'result'), 20_000)
  check(`${who}: the first call finishes and the cache holds it`, firstCached, JSON.stringify(journalRows(runDir)))
  await wait(2_500)
  const rows = journalRows(runDir)
  const started = rows.filter(r => r.type === 'started')
  const results = rows.filter(r => r.type === 'result')
  check(`${who}: the second never starts — one started row, one result row (the first), no second key`, started.length === 1 && results.length === 1 && started[0]?.key === results[0]?.key, `started ${started.length} results ${results.length}`)
  check(`${who}: the cache holds the first's answer`, results[0]?.result === 'ALPHA', JSON.stringify(results[0]))
  check(`${who}: no request for the second reached the wire`, requestsOf('second') === 0, `second ${requestsOf('second')}`)
  const saved = await until(() => readManifest(runDir).status === 'paused', 5_000)
  const m = readManifest(runDir)
  check(`${who}: run.json says paused, by whom`, saved && m.pausedBy === 'operator', `status ${m.status} pausedBy ${m.pausedBy ?? 'none'}`)
  check(`${who}: run.json carries the position — after 1 call, next "second" in Work`, m.pausedAt?.after === 1 && m.pausedAt.next.length === 1 && m.pausedAt.next[0]?.label === 'second' && m.pausedAt.next[0]?.phaseTitle === 'Work', JSON.stringify(m.pausedAt ?? null))
  check(`${who}: run.json lists the first agent alone, done — no row for a second that never started`, m.agents.length === 1 && m.agents[0]?.label === 'first' && m.agents[0]?.state === 'done', JSON.stringify(m.agents))
  return { runDir, scriptPath: String(line.scriptPath), runId: String(line.runId) }
}

section('(3) the product: P parks the run after the first of three calls and saves it; P again resumes in place — the second and the third run, the first is not repeated')
armFirstGate()
let child: Child | undefined = launchChild('run')
{
  const run = await pauseAfterTheFirst(child, 'toggle')
  if (run) {
    const resumeAt = Date.now()
    const resumed = await requestWorkflowControl(run.runDir, { action: 'resume', by: 'operator' })
    check('toggle: p again: the resume verb is applied to the parked run', resumed.outcome === 'applied', JSON.stringify(resumed))
    const settledSeen = await until(() => child!.out().includes('"ev":"settled"'), 40_000)
    check('toggle: the run finishes after the resume', settledSeen, (child.out() + child.err()).slice(-400))
    const settled = readLines(child.out()).find(l => l.ev === 'settled') as Record<string, unknown> | undefined
    check('toggle: the task and run.json read completed with the three answers stitched', settled?.task === 'completed' && settled?.manifest === 'completed' && settled?.result === 'ALPHA|BETA|GAMMA', JSON.stringify(settled))
    check('toggle: the second started only after the resume, then the third; the first was never repeated', requestsOf('first') === 1 && requestsOf('second', resumeAt) === 1 && requestsOf('third', resumeAt) === 1, `first ${requestsOf('first')} second ${requestsOf('second', resumeAt)} third ${requestsOf('third', resumeAt)}`)
    check('toggle: the settled record drops the pause words', settled?.pausedBy === null && settled?.pausedAt === null, JSON.stringify(settled))
  }
}
child?.proc.kill('SIGKILL')

section('(4) the product: the process quits while parked — the saved run resumes later from its run id; the first replays from the cache, the second and the third run live')
requests.length = 0
armFirstGate()
child = launchChild('park')
{
  const run = await pauseAfterTheFirst(child, 'saved')
  child.proc.kill('SIGKILL')
  await wait(300)
  if (run) {
    const old = (Date.now() - 120_000) / 1000
    utimesSync(join(run.runDir, 'run.json'), old, old)
    const m = readManifest(run.runDir)
    check('saved: after the quit run.json still says paused with the position (nothing was lost)', m.status === 'paused' && m.pausedAt?.after === 1, JSON.stringify({ status: m.status, pausedAt: m.pausedAt ?? null }))
    const resumeAt = Date.now()
    const resumer = launchChild('resume', { PAUSE_SCRIPT_PATH: run.scriptPath, PAUSE_RESUME_RUN: run.runId })
    const settledSeen = await until(() => resumer.out().includes('"ev":"settled"') || resumer.out().includes('"ev":"threw"'), 60_000)
    check('saved: Workflow({scriptPath, resumeFromRunId}) relaunches the paused run', settledSeen && !resumer.out().includes('"ev":"threw"'), (resumer.out() + resumer.err()).slice(-500))
    const settled = readLines(resumer.out()).find(l => l.ev === 'settled') as Record<string, unknown> | undefined
    check('saved: the resumed run completes with the three answers stitched', settled?.task === 'completed' && settled?.result === 'ALPHA|BETA|GAMMA', JSON.stringify(settled))
    check("saved: the resumed run's first action is the second call — the first replays from the cache, never re-asked", requestsOf('first', resumeAt) === 0 && requestsOf('second', resumeAt) === 1 && requestsOf('third', resumeAt) === 1, `first ${requestsOf('first', resumeAt)} second ${requestsOf('second', resumeAt)} third ${requestsOf('third', resumeAt)}`)
    const agents = (settled?.agents as Array<{ label: string; state: string; cached: boolean }>) ?? []
    check('saved: the record marks the first cached and the other two live', agents.some(a => a.label === 'first' && a.cached) && agents.some(a => a.label === 'second' && !a.cached && a.state === 'done') && agents.some(a => a.label === 'third' && !a.cached && a.state === 'done'), JSON.stringify(agents))
    resumer.proc.kill('SIGKILL')
  }
}

section('(5) the product: a kill still kills a parked run')
requests.length = 0
armFirstGate()
child = launchChild('run')
{
  const run = await pauseAfterTheFirst(child, 'kill')
  if (run) {
    const stopped = await requestWorkflowControl(run.runDir, { action: 'stop', by: 'operator' }, { answerMs: 30_000 })
    check('kill: x over the parked run is applied', stopped.outcome === 'applied', JSON.stringify(stopped))
    const settledSeen = await until(() => child!.out().includes('"ev":"settled"'), 30_000)
    const settled = readLines(child.out()).find(l => l.ev === 'settled') as Record<string, unknown> | undefined
    check('kill: the task and run.json read killed, ended by the operator', settledSeen && settled?.task === 'killed' && settled?.manifest === 'killed' && settled?.endedBy === 'operator', JSON.stringify(settled))
    check('kill: the second never ran', requestsOf('second') === 0)
  }
}
child?.proc.kill('SIGKILL')
await new Promise<void>(resolve => fixture.close(() => resolve()))

section("(6) the view: a paused row's words and its chip; P toggles the selected run")
{
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const React = (await import('react')).default
  const { mock } = await import('bun:test')
  const { EventEmitter: NodeEventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const stripAnsi = (await import('strip-ansi')).default
  const controlCalls: string[] = []
  const stub = async (path: string, fixture: () => Record<string, unknown>): Promise<void> => {
    const actual = await import(path)
    mock.module(path, () => ({ ...actual, ...fixture() }))
  }
  await stub('../../src/tools/WorkflowTool/runControl.js', () => ({
    requestWorkflowControl: async (_dir: string, input: { action: string }) => {
      controlCalls.push(input.action)
      return { outcome: 'applied', detail: `${input.action} applied by the fixture` }
    },
  }))
  const roster = { rows: [], mission: [], samples: [], reported: true }
  await stub('../../src/components/tasks/useFocusedWork.js', () => ({
    useFocusedWorkRoster: () => roster,
    focusedRunnerPresence: () => 'live',
    otherSessionRunnerPids: () => new Set<number>(),
    focusedSessionIdOrNull: () => null,
  }))
  const viewCwd = join(scratch, 'view-cwd')
  mkdirSync(viewCwd, { recursive: true })
  await stub('../../src/hooks/useFocusedWorkspaceCwd.js', () => ({ useFocusedWorkspaceCwd: () => viewCwd }))
  const now = Date.now()
  const savedManifest: WorkflowRunManifest & { mtimeMs: number } = {
    version: 1,
    runId: 'wf_saved_on_disk',
    workflowName: 'doc-sweep',
    description: 'a run paused, then the session ended',
    phases: [{ title: 'Inventory' }, { title: 'Check' }],
    runDir: join(viewCwd, 'runs', 'wf_saved_on_disk'),
    startTime: now - 900_000,
    status: 'paused',
    pausedBy: 'session 9f3a2c11',
    pausedAt: { after: 2, next: [{ label: 'check:api', phaseTitle: 'Check' }] },
    ownerPid: 424242,
    controlVersion: 1,
    agentCount: 2,
    totalTokens: 41_200,
    totalToolCalls: 6,
    agents: [
      { index: 1, label: 'inventory', state: 'done', phaseIndex: 0, phaseTitle: 'Inventory', tokens: 20_100 },
      { index: 2, label: 'check:cli', state: 'done', phaseIndex: 1, phaseTitle: 'Check', tokens: 21_100 },
    ],
    mtimeMs: now - 600_000,
  } as WorkflowRunManifest & { mtimeMs: number }
  await stub('../../src/tools/WorkflowTool/runManifest.js', () => ({ listWorkflowRunsDetailed: async () => ({ rows: [savedManifest], unreadable: 0 }) }))
  await stub('../../src/bootstrap/state.js', () => ({ getSessionId: () => 'fixture-session-id' }))
  await stub('../../src/services/attention/actions.js', () => ({ submitDispatch: async () => ({ kind: 'dispatch-accepted' }), mintIntentId: () => 'intent-fixture' }))
  await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
  await stub('../../src/components/mercury-ui/components.js', () => ({ useNowTick: () => now }))

  const { WorkflowsBoard } = await import('../../src/components/tasks/WorkflowsBoard.js')
  const { AppStateProvider, getDefaultAppState } = await import('../../src/state/AppState.js')
  const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
  const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')

  const runningTask = (paused: boolean): Record<string, unknown> => ({
    id: 'wf-task-paused',
    type: 'local_workflow',
    status: 'running',
    description: 'three calls in a row',
    startTime: now - 61_000,
    notified: false,
    outputFile: join(viewCwd, 'out.json'),
    script: '',
    prompt: '',
    scriptPath: join(viewCwd, 'workflow.js'),
    workflowRunId: 'wf_live_parked',
    runDir: join(viewCwd, 'runs', 'wf_live_parked'),
    workflowName: 'pause-fixture',
    summary: 'three calls in a row',
    phases: [{ title: 'Work' }],
    defaultModel: 'claude-opus-4-8',
    ...(paused ? { pausedBy: 'session 9f3a2c11', pausedAt: { after: 1, next: [{ label: 'second', phaseTitle: 'Work' }] } } : {}),
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Work' },
      { type: 'workflow_agent', index: 1, label: 'first', phaseIndex: 0, phaseTitle: 'Work', state: 'done', agentId: 'a1first', tokens: 1_200, startedAt: now - 60_000, lastProgressAt: now - 30_000 },
    ],
    progressVersion: 2,
    agentCount: 1,
    totalTokens: 1_200,
    totalToolCalls: 0,
    logs: [],
    retain: false,
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      flushPendingSyncWork()
      await wait(5)
    }
  }
  async function mount(columns: number, rows: number, paused: boolean) {
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const initial = getDefaultAppState()
    const state = { ...initial, tasks: { 'wf-task-paused': runningTask(paused) } }
    const node = React.createElement(
      StdinContext.Provider,
      { value: context },
      React.createElement(AppStateProvider, { initialState: state as never }, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(WorkflowsBoard, { onClose: () => {} }))),
    )
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => {
      painted = resolve
    })
    const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    await wait(120)
    await settle()
    return {
      frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
      async key(name: string) {
        const event = new InputEvent({ name, sequence: name, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
        emitter.emit('input', event)
        await settle()
      },
      close() {
        instance.unmount()
        instance.cleanup()
        stream.destroy()
      },
    }
  }
  try {
    const wide = await mount(178, 51, true)
    const frame = wide.frame()
    if (framesDir) {
      mkdirSync(framesDir, { recursive: true })
      writeFileSync(join(framesDir, 'paused-178x51.txt'), frame + '\n')
    }
    const rowLine = frame.split('\n').find(l => l.includes('pause-fixture')) ?? ''
    check("the paused row's words: the St column reads paused, never a running spinner", /paused/.test(rowLine) && !/\brun\b/.test(rowLine), rowLine.trim())
    const pane = frame.split('\n').filter(l => /⦿ paused|by session 9f3a2c11|after 1 call|next second/.test(l)).join(' | ')
    check('the chip: ⦿ paused · by whom · the position (after 1 call · next second)', /⦿ paused/.test(frame) && /by session 9f3a2c11/.test(frame) && /after 1 call/.test(frame) && /next second/.test(frame), pane.slice(0, 400))
    check('the footer offers p resume on the paused row', /p resume/.test(frame), frame.split('\n').filter(l => /resume|pause/.test(l)).join(' | ').slice(0, 300))
    await wide.key('p')
    check('P on the paused row sends the resume verb', controlCalls.at(-1) === 'resume', JSON.stringify(controlCalls))
    await wide.key('3')
    const pastFrame = wide.frame()
    const pastLine = pastFrame.split('\n').find(l => l.includes('doc-sweep')) ?? ''
    check('a run paused and saved on disk lists under Past with the paused word and its position', /paused/.test(pastLine) && /after 2 calls/.test(pastFrame) && /next check:api/.test(pastFrame), pastLine.trim() + ' | ' + pastFrame.split('\n').filter(l => /after 2 calls|next check/.test(l)).join(' | '))
    wide.close()
    const narrow = await mount(80, 21, true)
    const narrowFrame = narrow.frame()
    if (framesDir) writeFileSync(join(framesDir, 'paused-80x21.txt'), narrowFrame + '\n')
    const narrowRow = narrowFrame.split('\n').find(l => l.includes('pause-fixture')) ?? ''
    check('at 80x21 the row still reads paused', /paused/.test(narrowRow), narrowRow.trim())
    narrow.close()
    const running = await mount(178, 51, false)
    const runningFrame = running.frame()
    if (framesDir) writeFileSync(join(framesDir, 'running-178x51.txt'), runningFrame + '\n')
    const runningRow = runningFrame.split('\n').find(l => l.includes('pause-fixture')) ?? ''
    check('an unpaused row keeps its running word', /\brun\b/.test(runningRow) && !/paused/.test(runningRow), runningRow.trim())
    await running.key('p')
    check('P on the running row sends the pause verb', controlCalls.at(-1) === 'pause', JSON.stringify(controlCalls))
    running.close()
    if (framesDir) writeFileSync(join(framesDir, 'index.txt'), ['paused-178x51.txt — the board at 178x51: an Active run parked by P (the row reads paused; the chip names who and the position) and a Past run paused then saved on disk', 'paused-80x21.txt — the same board at 80x21', 'running-178x51.txt — the same run before P (the running word)', ''].join('\n'))
  } catch (e) {
    check('the board renders in a source mount', false, e instanceof Error ? (e.stack ?? e.message).slice(0, 600) : String(e))
  }
}

rmSync(scratch, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL WORKFLOW-PAUSE CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
