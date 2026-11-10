import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'
import type { LlmHostEvent, LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
pinSourceRef()
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
const vast = await vastFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
let beforePodRead: ((request: Request) => void) | undefined
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Only loopback fixtures are allowed') }
  beforePodRead?.(request)
  return nativeFetch(request)
}, nativeFetch)
let checks = 0
let failures = 0
const check = (name: string, truth: unknown, detail?: unknown): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail !== undefined ? ' · ' + JSON.stringify(detail) : '')) }
const sshCalls: string[] = []
const runner = { run: async (command: string) => { sshCalls.push(command); throw new Error('No SSH on a stopped machine') }, tunnel: () => { sshCalls.push('tunnel'); throw new Error('No tunnel on a stopped machine') } }
try {
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { readHostRecord, patchHostRecord, hostDirectory } = await import('../../src/services/host/store.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  saveVendorKey('vast', vast.key)
  const recipe = HOST_RECIPES.find(row => row.id === 'qwen38-27b-rtx-pro-6000')!
  assert.ok(recipe)
  const sessionId = 'terminal-state-session'
  const notices = () => readdirSync(join(hostDirectory(), 'notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDirectory(), 'notices', name), 'utf8')) as { words: string })
  let sequence = 8100
  const capture = async (id: string, name: string, resume: boolean): Promise<void> => {
    const React = await import('react')
    const { Box } = await import('../../src/ink.ts')
    const { AppStateProvider } = await import('../../src/state/AppState.tsx')
    const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
    const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
    const columns = 120, rows = 40
    const clock = Date.UTC(2026, 10, 10, 12)
    const now = Date.now
    Date.now = () => clock
    vast.state.pods.get(Number(id)).start_date = clock / 1000
    patchHostRecord(id, { startedAt: new Date(clock).toISOString() })
    const road = createHostRoad({ vendorApiBaseUrls: { vast: vast.baseUrl }, runner, sessionId: sessionId + '-frame-' + name })
    let beats = 0
    let lastResume: boolean | undefined
    const framed: LlmHostRoad = (ask, emit, signal) => road(plan => plan.step === 'door-models' ? Promise.resolve('other') : plan.step === 'where' ? Promise.resolve('pod:vast:' + id) : ask(plan), event => { if (event.host?.id === id) { beats++; lastResume = event.host.canResume } emit(event) }, signal)
    const h = React.createElement
    const mounted = await mountOffscreen(h(AppStateProvider, { children: h(ThemeProvider, { children: h(Box, { width: columns, height: rows }, h(LlmHostDialog, { width: columns - 4, rowBudget: rows - 4, road: framed })) }) }), columns, rows)
    try {
      const until = performance.now() + 5000
      while (performance.now() < until && (beats < 2 || !mounted.screen().includes('Terminate') || mounted.screen().includes('Resume setup') !== lastResume)) await new Promise(resolve => setTimeout(resolve, 20))
      check(name + ': the actual refreshed dialog offers Resume only when available', beats >= 2 && mounted.screen().includes('Resume setup') === resume, mounted.screen())
      if (frames) {
        const text = mounted.screen()
        writeFileSync(join(frames, name + '.txt'), text + '\n')
        const grid = mounted.lines().map((line, y) => Array.from(line.padEnd(columns)).map((c, x) => { const style = mounted.styleAt(x, y); return { c, fg: style?.fg ?? 'default', bg: style?.bg ?? 'default', bold: style?.bold ?? false } }))
        const path = join(frames, name + '.json')
        writeFileSync(path, JSON.stringify({ grid, cols: columns, rows }))
        await gridToPng(path, join(frames, name + '.png'))
      }
    } finally { mounted.unmount(); Date.now = now }
  }
  const controls = async (id: string) => {
    const events: LlmHostEvent[] = []
    let question: LlmHostQuestion | undefined
    const road = createHostRoad({ vendorApiBaseUrls: { vast: vast.baseUrl }, runner, sessionId: sessionId + id, startJob: () => { throw new Error('No setup was selected') } })
    const result = await road(async plan => {
      if (plan.step === 'door-models') return 'other'
      if (plan.step === 'where') return 'pod:vast:' + id
      if (plan.step === 'pod-controls') { question = plan; return 'close' }
      return null
    }, event => events.push(event), new AbortController().signal)
    assert.ok(question, 'the actual host controls were reached')
    const host = events.filter(event => event.host?.id === id).at(-1)?.host
    assert.ok(host)
    return { question, host, result }
  }
  for (const [actual, status] of [['stopped', 'EXITED'], ['exited', 'ERROR']] as const) {
    for (const rejected of [false, true]) {
      const id = String(++sequence)
      vast.state.pods.set(Number(id), { id: Number(id), label: 'terminal-' + id, actual_status: actual, start_date: Date.now() / 1000, dph_total: 1.25 })
      vast.state.logUrl = rejected ? 'https://logs.invalid/private/instance.log?signature=secret' : null
      const queued = queueHostSetup({ id, vendor: 'vast', name: 'terminal-' + id, recipe: recipe.id, recipeRow: recipe, price: 1.25, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: vast.baseUrl, sessionId })
      await runHostJob(id, queued.generation!, { runner, pauseMs: 5, timeoutMs: 500, keepAlive: false })
      const paused = readHostRecord(id)!
      const label = status + (rejected ? ' rejected log' : ' readable log')
      check(label + ': the record retains the observed vendor state', paused.status === status && paused.jobState === 'paused', { status: paused.status, state: paused.jobState })
      check(label + ': the cause retains the vendor state even if the log cannot be read', paused.error?.includes('Pod is ' + status + '.') && (!rejected || paused.error.includes('unexpected log URL')), paused.error)
      check(label + ': the notice never offers Resume on a machine whose controls cannot resume', !paused.error?.includes('Resume') && paused.error?.includes('Terminate in /llmhost'), paused.error)
      check(label + ': billing is stopped or uncertain, never falsely running', status === 'EXITED' ? paused.error?.includes('stopped; disk still bills until Terminate') && !paused.error.includes('/hr still billing') : paused.error?.includes('may still bill'), paused.error)
      check(label + ': one notice carries the same cause without credentials', notices().filter(row => row.words.includes('terminal-' + id)).length === 1 && notices().filter(row => row.words.includes('terminal-' + id)).every(row => row.words.includes(paused.error!) && !row.words.includes(vast.key)))
      patchHostRecord(id, { status: 'RUNNING' })
      const opened = await controls(id)
      check(label + ': freshly read status overrides the stale record on the screen', opened.host.status === status, opened.host)
      check(label + ': event and control rows agree that Resume is unavailable', opened.host.canResume === false && !opened.question.rows?.some(row => row.value === 'resume'), opened.host)
      check(label + ': paused guidance names only the available action', opened.host.step === 'paused · Terminate', opened.host.step)
      check(label + ': neither the Close choice nor its result claims an error-state machine is running', !opened.question.rows?.find(row => row.value === 'close')?.label.includes('running') && !opened.result.words.includes('machine still running'), opened.result.words)
      await capture(id, status.toLowerCase() + (rejected ? '-rejected' : '-readable'), false)
    }
  }
  const id = String(++sequence)
  vast.state.pods.set(Number(id), { id: Number(id), label: 'running-' + id, actual_status: 'running', start_date: Date.now() / 1000, dph_total: 1.25 })
  const queued = queueHostSetup({ id, vendor: 'vast', name: 'running-' + id, recipe: recipe.id, price: 1.25, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: vast.baseUrl, sessionId })
  patchHostRecord(id, { jobState: 'paused', step: 'paused at installing' })
  const running = await controls(queued.id)
  check('a running machine still offers Resume in both the event and the controls', running.host.canResume === true && running.question.rows?.some(row => row.value === 'resume'))
  check('running paused guidance and close wording are unchanged', running.host.step === 'paused · Resume or Terminate' && running.result.words.includes('machine still running'))
  await capture(id, 'running-readable', true)
  await capture(id, 'running-rejected', true)
  const beforeLateResume = readHostRecord(id)!.generation
  let lateStarts = 0
  let choices = 0
  await createHostRoad({ vendorApiBaseUrls: { vast: vast.baseUrl }, runner, sessionId: sessionId + '-late', startJob: () => { lateStarts++ } })(async plan => {
    if (plan.step === 'door-models') return 'other'
    if (plan.step === 'where') return 'pod:vast:' + id
    if (plan.step === 'pod-controls' && choices++ === 0) {
      vast.state.pods.get(Number(id)).actual_status = 'stopped'
      patchHostRecord(id, { status: 'EXITED' })
      return 'resume'
    }
    return null
  }, () => {}, new AbortController().signal)
  check('a Resume selected just as the worker observes EXITED cannot queue another setup', lateStarts === 0 && readHostRecord(id)?.generation === beforeLateResume && readHostRecord(id)?.status === 'EXITED')
  patchHostRecord(id, { status: 'TERMINATED', jobState: 'failed', error: 'termination was verified' })
  vast.state.pods.get(Number(id)).actual_status = 'running'
  const ended = await createHostRoad({ vendorApiBaseUrls: { vast: vast.baseUrl }, runner, sessionId: sessionId + '-ended' })(async plan => plan.step === 'door-models' ? 'other' : plan.step === 'where' ? 'pod:vast:' + id : null, () => {}, new AbortController().signal)
  check('opening an old vendor snapshot never rewrites a verified termination', ended.words === 'termination was verified' && readHostRecord(id)?.status === 'TERMINATED')
  const endingId = String(++sequence)
  vast.state.pods.set(Number(endingId), { id: Number(endingId), label: 'ending-' + endingId, actual_status: 'stopped', start_date: Date.now() / 1000, dph_total: 1.25 })
  const ending = queueHostSetup({ id: endingId, vendor: 'vast', name: 'ending-' + endingId, recipe: recipe.id, price: 1.25, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: vast.baseUrl, sessionId })
  beforePodRead = request => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/api/v0/instances/' + endingId + '/') return
    patchHostRecord(endingId, { status: 'TERMINATED', jobState: 'failed', error: 'termination was verified' })
    beforePodRead = undefined
  }
  await runHostJob(endingId, ending.generation!, { runner, pauseMs: 5, timeoutMs: 500, keepAlive: false })
  const endedRecord = readHostRecord(endingId)!
  check('an in-flight pod read cannot overwrite a verified termination or publish a new pause', endedRecord.status === 'TERMINATED' && endedRecord.jobState === 'failed' && endedRecord.error === 'termination was verified' && !notices().some(row => row.words.includes('ending-' + endingId)))
  check('observing stopped/error states sent no SSH, tunnel, create, stop or terminate', sshCalls.length === 0 && vast.state.creates === 0 && vast.state.stops === 0 && vast.state.deletes === 0)
  check('no request escaped a fixture', escaped.length === 0)
  console.log(`HOST TERMINAL STATE ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failed`)
} finally { globalThis.fetch = nativeFetch; await vast.close(); f.close() }
process.exitCode = failures ? 1 : 0
