#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import '../lib/hermetic.ts'

process.env.MERCURY_OVERLOAD_PROBE_SCALE = '0.001'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const lane = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const utils = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { noteCrewAccountChange } = await import('../../src/utils/crew/crewAccountChange.ts')
const { resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')

const store = { state: { tasks: {} as Record<string, Record<string, unknown>>, speculation: { status: 'idle' }, agentNameRegistry: new Map() } }
const set = ((update: (state: typeof store.state) => typeof store.state) => { store.state = update(store.state) }) as never
const context = { options: { tools: [] } } as never
const count = (): number => utils.armedAutomaticResumeCount()
const armed = (id: string): boolean => utils.automaticResumePending(id)
const settle = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function failedRow(id: string): AbortController {
  const registered = lane.registerAsyncAgent({ agentId: id, description: id, prompt: 'work', setAppState: set })
  lane.failAgentTask(id, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', set, registered.abortController)
  return registered.abortController!
}

function held<T>(): { entered: Promise<boolean>; release: (value: T) => void; port: () => Promise<T>; calls: () => number } {
  let enter!: (reached: boolean) => void
  let release!: (value: T) => void
  let calls = 0
  const entered = new Promise<boolean>(resolve => {
    enter = resolve
    setTimeout(() => resolve(false), 20_000).unref?.()
  })
  const released = new Promise<T>(resolve => { release = resolve })
  return { entered, release, calls: () => calls, port: async () => { calls++; enter(true); return released } }
}

const windowPause = (inMs: number) => ({ why: 'usage limit' as const, words: 'the window is spent', resumesAtMs: Date.now() + inMs })
const overloadPause = { why: 'provider overloaded' as const, words: 'fixture is overloaded' }

section('a crewmate paused on an overloaded provider counts from its arming to its resume, the probe request included')
{
  const id = 'count-overload'
  const registration = failedRow(id)
  const probes = [held<boolean>(), held<boolean>()]
  const resume = held<void>()
  let asked = 0
  utils.armOverloadProbe({ taskId: id, description: id, registration, rootSetAppState: set, toolUseContext: context, model: 'claude-fable-5-1', pause: overloadPause, afterDeath: true, probe: () => probes[asked++]!.port(), resume: () => resume.port() })
  check('armed: one crewmate waits to resume by itself', count() === 1 && armed(id), { count: count(), armed: armed(id) })
  const firstOut = await probes[0]!.entered
  check('while the first probe request is out its timer is spent and the crewmate still counts', firstOut && !armed(id) && count() === 1, { firstOut, armed: armed(id), count: count() })
  probes[0]!.release(false)
  await settle()
  check('an unanswered probe arms the next: one, never two', armed(id) && count() === 1, { armed: armed(id), count: count() })
  const secondOut = await probes[1]!.entered
  check('while the second probe request is out: still one', secondOut && !armed(id) && count() === 1, { secondOut, armed: armed(id), count: count() })
  probes[1]!.release(true)
  const resuming = await resume.entered
  check('the provider answered and the resume is starting: still one', resuming && !armed(id) && count() === 1, { resuming, armed: armed(id), count: count() })
  resume.release()
  await settle()
  check('once the resume has started nothing waits', count() === 0 && resume.calls() === 1, { count: count(), resumes: resume.calls() })
  utils.closeOverloadEpisode(id)
}

section('a crewmate paused on a usage window counts until its resume has started')
{
  const id = 'count-window'
  const registration = failedRow(id)
  const resume = held<void>()
  utils.armBudgetCutResume({ taskId: id, description: id, registration, toolUseContext: context, rootSetAppState: set, delayMs: 20, pause: windowPause(20), resume: () => resume.port() })
  check('armed: one', count() === 1 && armed(id), { count: count(), armed: armed(id) })
  const resuming = await resume.entered
  check('the timer fired and the resume is starting: its entry is gone and the crewmate still counts', resuming && !armed(id) && count() === 1, { resuming, armed: armed(id), count: count() })
  resume.release()
  await settle()
  check('once the resume has started nothing waits', count() === 0, count())
}

section('every road that ends the wait brings the count back to zero')
{
  const stopped = 'count-stopped'
  utils.armBudgetCutResume({ taskId: stopped, description: stopped, registration: failedRow(stopped), toolUseContext: context, rootSetAppState: set, delayMs: 60_000, pause: windowPause(60_000) })
  check('a stop or a manual resume cancels the retry: one, then none', count() === 1 && utils.cancelAutomaticResume(stopped) && count() === 0, count())

  const account = 'count-account'
  const accountResume = held<void>()
  utils.armBudgetCutResume({ taskId: account, description: account, registration: failedRow(account), toolUseContext: context, rootSetAppState: set, delayMs: 60_000, pause: windowPause(60_000), resume: () => accountResume.port() })
  noteCrewAccountChange()
  const accountResuming = await accountResume.entered
  check('a sign-in on another account fires the retry early: one while it starts', accountResuming && !armed(account) && count() === 1, { accountResuming, armed: armed(account), count: count() })
  accountResume.release()
  await settle()
  check('and none once it has started', count() === 0, count())

  const taken = 'count-taken'
  const takenResume = held<void>()
  utils.armBudgetCutResume({ taskId: taken, description: taken, registration: failedRow(taken), toolUseContext: context, rootSetAppState: set, delayMs: 20, pause: windowPause(20), resume: () => takenResume.port() })
  lane.registerAsyncAgent({ agentId: taken, description: taken, prompt: 'work', setAppState: set })
  await settle(120)
  check('a crewmate that runs again under another registration when its timer fires is not resumed, and nothing waits', count() === 0 && takenResume.calls() === 0, { count: count(), resumes: takenResume.calls() })

  const gone = 'count-gone'
  const goneProbe = held<boolean>()
  const goneResume = held<void>()
  const goneRegistration = failedRow(gone)
  utils.armOverloadProbe({ taskId: gone, description: gone, registration: goneRegistration, rootSetAppState: set, toolUseContext: context, model: 'claude-fable-5-1', pause: overloadPause, afterDeath: true, probe: () => goneProbe.port(), resume: () => goneResume.port() })
  const goneOut = await goneProbe.entered
  lane.unpauseAgentTask(gone, set, goneRegistration)
  goneProbe.release(true)
  await settle()
  check('a probe that comes back to a row no longer paused resumes nothing and leaves nothing waiting', goneOut && count() === 0 && goneResume.calls() === 0, { goneOut, count: count(), resumes: goneResume.calls() })
  utils.closeOverloadEpisode(gone)
}

section('two crewmates, one armed and one firing, are two')
{
  const waiting = 'count-pair-armed'
  const firing = 'count-pair-firing'
  const resume = held<void>()
  utils.armBudgetCutResume({ taskId: waiting, description: waiting, registration: failedRow(waiting), toolUseContext: context, rootSetAppState: set, delayMs: 60_000, pause: windowPause(60_000) })
  utils.armBudgetCutResume({ taskId: firing, description: firing, registration: failedRow(firing), toolUseContext: context, rootSetAppState: set, delayMs: 20, pause: windowPause(20), resume: () => resume.port() })
  check('both armed: two', count() === 2, count())
  const resuming = await resume.entered
  check('one resume starting, one timer armed: two', resuming && armed(waiting) && !armed(firing) && count() === 2, { resuming, count: count() })
  resume.release()
  await settle()
  check('the started one no longer counts', count() === 1, count())
  utils.cancelAutomaticResume(waiting)
  check('and the cancelled one neither', count() === 0, count())
}

resetCommandQueue()
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
