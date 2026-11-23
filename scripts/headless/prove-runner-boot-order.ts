#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)
const SELF = 'scripts/headless/prove-runner-boot-order.ts'
const LIST = 'src/daemon/runner/boot/bootList.ts'

const ORDER = [
  'markSessionPosture',
  'warnAtBoot',
  'wireProcess',
  'refuseBadOptions',
  'resolveRequestedModel',
  'takeSessionWriter',
  'refuseClaimlessRowsDoor',
  'openWireDoor',
  'tellMcpNotices',
  'sourceRows',
  'watchMission',
  'loadSession',
  'wireSession',
  'prependFirstPrompt',
  'restoreRecordedModel',
  'recordBootRefusal',
  'bindRelaunch',
  'hydrateColdResume',
  'restoreRecordedAgent',
  'settleBriefs',
  'endOnFailedLoad',
  'restoreFilesAlone',
  'refuseEmptyPrompt',
  'poolTools',
  'seatSession',
  'bindAdvisor',
  'laneMcpChanges',
  'seedReadFileCache',
  'watchRateLimits',
  'bindTurnTools',
  'bindSeatVerbs',
  'armWarm',
  'watchMode',
  'watchSkills',
  'armAgentFreshness',
  'bindTurnInputs',
  'bindIdleAndPark',
  'routeOutput',
  'bindNotificationFrames',
  'watchDrainedFrames',
  'startDriver',
  'watchQueue',
  'watchCrew',
  'nudgeWhenIdle',
  'ownSignals',
  'watchBuildBehind',
  'registerBootCleanup',
  'armLocalWake',
  'catalogueModels',
  'watchLiveMcp',
  'bindInputDoor',
  'kickHeldNotices',
  'openInput',
  'runToEnd',
]

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes — a boot step or the peer never settled; look at runBootSteps in src/daemon/runner/boot/bootList.ts and createPeer in src/daemon/runner-wire/peer.ts')
  process.exit(1)
}, 120_000).unref()

const realList = (await import(at(LIST))) as typeof import('../../src/daemon/runner/boot/bootList.ts')
const { BOOT_STEPS, runBootSteps } = realList
const { BOOT_ENDS, createRunnerPorts, createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
type Ports = Parameters<typeof runBootSteps>[1]
type Step = (typeof BOOT_STEPS)[number]
type Given = Parameters<typeof createRunnerPorts>[0]

section('(1) the order of the boot is behaviour: a step reads what the steps before it made, and writes after what they wrote')
{
  const stands = BOOT_STEPS.map(step => step.name)
  const placeIn = (list: readonly string[]): Map<string, number> => new Map(list.map((name, place) => [name, place + 1]))
  const ran = placeIn(stands)
  const held = placeIn(ORDER)
  const added = stands.filter(name => !held.has(name))
  const dropped = ORDER.filter(name => !ran.has(name))
  const keptHere = stands.filter(name => held.has(name))
  const keptThere = ORDER.filter(name => ran.has(name))
  const firstMoved = keptHere.findIndex((name, place) => keptThere[place] !== name)
  check(
    `BOOT_STEPS of ${LIST} holds the ${ORDER.length} steps this proof names, in this order: ${ORDER.join(' → ')}`,
    added.length === 0 && dropped.length === 0 && firstMoved === -1,
    [
      ...added.map(name => `${name} stands at place ${ran.get(name)} of BOOT_STEPS in ${LIST} and is not in ORDER of ${SELF}: a new step is written into ORDER at the place it runs`),
      ...dropped.map(name => `${name} is in ORDER of ${SELF} at place ${held.get(name)} and no longer in BOOT_STEPS of ${LIST}: put the step back in the list, or delete its name from ORDER if the step is meant to go`),
      ...(firstMoved === -1 ? [] : [`${keptHere[firstMoved]} now runs where ${keptThere[firstMoved]} ran (place ${ran.get(keptHere[firstMoved]!)} of BOOT_STEPS in ${LIST}; ${keptThere[firstMoved]} is at place ${ran.get(keptThere[firstMoved]!)}): the order of the boot is behaviour, so put the pair back as ORDER of ${SELF} has it, or move the names in ORDER if the new order is meant`]),
    ],
  )
  const twice = stands.filter((name, place) => stands.findIndex(other => other === name) !== place)
  check('no step stands twice in the list', twice.length === 0, twice.map(name => `${name} stands more than once in BOOT_STEPS of ${LIST}: a step runs once in a boot`))
  const idle = BOOT_STEPS.filter(step => typeof step.run !== 'function' || !Array.isArray(step.makes)).map(step => step.name)
  check('every step of the list names what it makes and is a function the list can run', idle.length === 0, idle.map(name => `${name} in BOOT_STEPS of ${LIST} has no run function or no makes list`))
  const makers = new Map<string, string[]>()
  for (const step of BOOT_STEPS) for (const member of step.makes) makers.set(member, [...(makers.get(member) ?? []), step.name])
  const shared = [...makers].filter(([, steps]) => steps.length > 1)
  check(`each of the ${makers.size} members the steps make is made by one step`, shared.length === 0, shared.map(([member, steps]) => `${member} is named by ${steps.join(' and ')} in ${LIST}: one step makes a member, the others read it from the ports`))
}

const given = (): Given => ({ live: createRunnerState(), options: {}, inputPrompt: 'the prompt', getAppState: (() => ({})) as Given['getAppState'], setAppState: () => {}, commands: [], tools: [], agents: [], isLocalShellTask: () => false, killTask: async () => undefined, requestShellBackground: () => 0, windowsShellRoadNotice: () => null, hydrateResumedRun: async () => {} })
const thrown = (work: () => unknown): string => {
  try {
    work()
    return 'nothing was thrown'
  } catch (error) {
    return (error as Error).message
  }
}

section('(2) the ports: a member read before the step that makes it fails by a line that names the member and the step')
{
  const driverStep = BOOT_STEPS.find(step => step.makes.includes('driver'))
  const { ports, give } = createRunnerPorts(given(), BOOT_STEPS)
  check('a member read before its step has run is refused by name: the member and the step that makes it', driverStep !== undefined && thrown(() => ports.driver) === `the runner's port driver is read before the boot step ${driverStep.name} has made it`, ['createRunnerPorts in src/daemon/runner/runnerPorts.ts must refuse an early read with this exact sentence', thrown(() => ports.driver)])
  const early = BOOT_STEPS.flatMap(step => step.makes.map(member => [member, step.name] as const)).filter(([member, step]) => thrown(() => ports[member]) !== `the runner's port ${member} is read before the boot step ${step} has made it`)
  check('…and so is every member the list makes, before the list has run', early.length === 0, ['createRunnerPorts in src/daemon/runner/runnerPorts.ts must refuse every member read before its step has run', ...early.map(([member, step]) => `${member} of ${step}: ${thrown(() => ports[member])}`)])
  const driver = { kick: () => {} } as unknown as Ports['driver']
  if (driverStep !== undefined) give(driverStep, { driver })
  check('what a step makes is read from the ports as the value it made, once the list has given it', ports.driver === driver, ['the give function of createRunnerPorts in src/daemon/runner/runnerPorts.ts must store what a step made so the ports return it'])
  check('a member no step of the list makes is refused by name, never read as undefined', thrown(() => (ports as unknown as Record<string, unknown>).noSuchMember) === "the runner's port noSuchMember is made by no step of the boot", ['createRunnerPorts in src/daemon/runner/runnerPorts.ts must refuse an unknown member by name', thrown(() => (ports as unknown as Record<string, unknown>).noSuchMember)])
  const first = given()
  const born = createRunnerPorts(first, BOOT_STEPS).ports
  check('what the runner is handed at its call is on the ports from the start', born.live === first.live && born.options === first.options && born.inputPrompt === 'the prompt' && born.getAppState === first.getAppState && born.hydrateResumedRun === first.hydrateResumedRun, ['createRunnerPorts in src/daemon/runner/runnerPorts.ts must put what the runner is handed on the ports from the start'])
  const short = BOOT_STEPS.find(step => step.makes.length > 0)
  check('a step that names a member and does not make it is refused by name', short !== undefined && thrown(() => give(short, {})) === `the boot step ${short.name} names ${short.makes[0]} and did not make it`, ['the give function of createRunnerPorts in src/daemon/runner/runnerPorts.ts must refuse a step that did not make a member it names', short === undefined ? 'no step makes a member' : thrown(() => give(short, {}))])
}

section('(3) the list runs its steps in order, gives what each made before the next starts, and ends where a step ends the boot')
{
  const trace: string[] = []
  const quiescence = {} as Ports['quiescence']
  const driver = {} as Ports['driver']
  const steps: Step[] = [
    { name: 'first', makes: ['quiescence'], run: () => (trace.push('first'), { quiescence }) },
    { name: 'second', makes: [], run: ports => (trace.push(`second reads ${ports.quiescence === quiescence ? 'what first made' : 'something else'}`), {}) },
    { name: 'third', makes: ['driver'], run: async ports => (trace.push('third'), await Promise.resolve(), trace.push(`third after its wait reads ${thrown(() => ports.driver)}`), { driver }) },
    { name: 'fourth', makes: [], run: ports => (trace.push(`fourth reads ${ports.driver === driver ? 'what third made' : 'something else'}`), BOOT_ENDS) },
    { name: 'fifth', makes: [], run: () => (trace.push('fifth'), {}) },
  ]
  const { ports, give } = createRunnerPorts(given(), steps)
  void Promise.resolve().then(() => trace.push('a turn of the microtask queue'))
  await runBootSteps(steps, ports, give).catch((error: Error) => void trace.push(`the list threw: ${error.message}`))
  check(
    'the steps run in the order of the list; a step that waits for nothing hands on to the next in the same turn; what a step made is on the ports when the next step starts and not before; a step that ends the boot is the last to run',
    j(trace) === j(['first', 'second reads what first made', 'third', 'a turn of the microtask queue', "third after its wait reads the runner's port driver is read before the boot step third has made it", 'fourth reads what third made']),
    ['runBootSteps in src/daemon/runner/boot/bootList.ts must run the steps in list order, give each made member before the next step, and stop at a step that ends the boot', j(trace)],
  )
}

section('(4) the runner runs this list: it builds the ports from what it is handed and hands them to the list, once')
{
  const calls: Array<{ steps: unknown; ports: Ports; give: unknown }> = []
  mock.module(at(LIST), () => ({
    ...realList,
    runBootSteps: async (steps: unknown, ports: Ports, give: unknown): Promise<void> => {
      calls.push({ steps, ports, give })
    },
  }))
  const hydrated: unknown[] = []
  const realHydration = (await import(at('src/daemon/runner/resumeHydration.ts'))) as Record<string, unknown>
  mock.module(at('src/daemon/runner/resumeHydration.ts'), () => ({ ...realHydration, hydrateResumedRun: async (ports: unknown): Promise<void> => void hydrated.push(ports) }))
  const { runHeadless } = await import('../../src/daemon/runner/runHeadless.ts')
  const getAppState = (() => ({})) as Given['getAppState']
  const setAppState: Given['setAppState'] = () => {}
  const commands: Given['commands'] = []
  const tools: Given['tools'] = []
  const agents: Given['agents'] = []
  const options: Given['options'] = { door: 'wire' }
  await runHeadless('the words', getAppState, setAppState, commands, tools, agents, options)
  const call = calls[0]
  check('runHeadless runs BOOT_STEPS itself, once', calls.length === 1 && call?.steps === BOOT_STEPS && typeof call.give === 'function', ['runHeadless in src/daemon/runner/runHeadless.ts must call runBootSteps once with BOOT_STEPS', `${calls.length} calls`])
  check(
    'the ports it hands the list carry what it was called with, by identity, and a state of its own',
    call !== undefined && call.ports.inputPrompt === 'the words' && call.ports.getAppState === getAppState && call.ports.setAppState === setAppState && call.ports.commands === commands && call.ports.tools === tools && call.ports.agents === agents && call.ports.options === options && call.ports.live.awaitingSessionClaim === false && call.ports.live.turnsRun === 0,
    ['runHeadless in src/daemon/runner/runHeadless.ts must build the ports with createRunnerPorts from the very values it was called with'],
  )
  await call?.ports.hydrateResumedRun()
  check('the resume the claim calls is the one closure, handed these ports', hydrated.length === 1 && hydrated[0] === call?.ports, ['runHeadless in src/daemon/runner/runHeadless.ts must hand the same ports to hydrateResumedRun'])
  check('before the list has run, the ports refuse a member the list makes', call !== undefined && thrown(() => call.ports.wire).startsWith("the runner's port wire is read before the boot step "), ['createRunnerPorts in src/daemon/runner/runnerPorts.ts must refuse a member read before the list has run', call === undefined ? '' : thrown(() => call.ports.wire)])
}

section('(5) what arrives while the runner boots is held behind initialize and handed on after the boot, in the order it arrived')
{
  const { PassThrough } = await import('node:stream')
  const { createPeer } = await import('../../src/daemon/runner-wire/peer.ts')
  const { initializeResultOf } = await import('../../src/daemon/runner/runnerMethods.ts')
  const turn = (): Promise<void> => new Promise(done => setTimeout(done, 25))
  const line = (frame: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`
  const hello = { protocol: 1, host: { name: 'proof-host', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  const N = (): string => line({ method: 'credentials/changed', params: {} })
  const INIT = (id = 1): string => line({ id, method: 'initialize', params: hello })
  const R = (id: number, method: string, params: Record<string, unknown> = {}): string => line({ id, method, params })
  const world = (): { write: (text: string) => void; order: string[]; said: string[]; answers: () => string; settleBoot: () => void; refuseNext: () => void; close: () => void } => {
    const input = new PassThrough()
    const output = new PassThrough()
    let answers = ''
    output.on('data', chunk => (answers += String(chunk)))
    const said: string[] = []
    const peer = createPeer({ input, output, side: 'runner', log: text => void said.push(text) })
    let settleBoot: () => void = () => {}
    const bootReady = new Promise<void>(done => (settleBoot = done))
    const order: string[] = []
    let changes = 0
    let refusing = false
    peer.onRequest('initialize', async () => {
      await bootReady
      order.push('the boot ended')
      if (refusing) {
        refusing = false
        throw new Error('the boot refused')
      }
      return initializeResultOf(null, { capable: false } as never)
    })
    peer.onNotification('credentials/changed', () => void order.push(`credentials/changed ${++changes}`))
    for (const method of ['session/send_now', 'session/facts', 'queue/add', 'session/set_mode'] as const) {
      peer.onRequest(method, async () => {
        order.push(method)
        return {} as never
      })
    }
    return { write: text => void input.write(text), order, said, answers: () => answers, settleBoot: () => settleBoot(), refuseNext: () => void (refusing = true), close: () => peer.close('the proof is done') }
  }
  const booting = async (frames: string[], apart: boolean): Promise<{ during: string[]; after: string[]; said: string[] }> => {
    const w = world()
    if (apart) {
      for (const frame of frames) {
        w.write(frame)
        await turn()
      }
    } else {
      w.write(frames.join(''))
      await turn()
    }
    const during = [...w.order]
    w.settleBoot()
    await turn()
    w.close()
    return { during, after: w.order.slice(during.length), said: w.said }
  }
  const oneWrite = await booting([N(), INIT(), N(), R(2, 'session/send_now'), N()], false)
  const apart = await booting([N(), INIT(), N(), R(2, 'session/facts'), N()], true)
  const scoped = await booting([N(), INIT(), N(), R(2, 'queue/add', { type: 'prompt', content: 'words' }), N(), R(3, 'session/set_mode', { mode: 'implement' }), N()], true)
  const quiet = (scene: { during: string[]; said: string[] }): boolean => scene.during.length === 0 && !scene.said.some(text => text.includes('failed') || text.includes('dropped'))
  check(
    'notifications and a request of no scope held behind initialize reach their arms only after the boot has ended and initialize is answered, each once, in the order they arrived: the whole order, in one write (N, initialize, N, session/send_now, N) and 25 ms apart (N, initialize, N, session/facts, N)',
    quiet(oneWrite) && j(oneWrite.after) === j(['the boot ended', 'credentials/changed 1', 'credentials/changed 2', 'session/send_now', 'credentials/changed 3']) && quiet(apart) && j(apart.after) === j(['the boot ended', 'credentials/changed 1', 'credentials/changed 2', 'session/facts', 'credentials/changed 3']),
    ['the peer in src/daemon/runner-wire/peer.ts must hold notifications and requests behind initialize and hand them on in arrival order after the boot', `one write, after the boot: ${j(oneWrite.after)}`, `25 ms apart, after the boot: ${j(apart.after)}`, `the peer said: ${j([...oneWrite.said, ...apart.said])}`],
  )
  check(
    "a request of a scope held with them is handed to its scope's queue in its turn and reaches its arm when that queue lets it, which is behind every notification held with it: the whole order (N, initialize, N, queue/add, N, session/set_mode, N)",
    quiet(scoped) && j(scoped.after) === j(['the boot ended', 'credentials/changed 1', 'credentials/changed 2', 'credentials/changed 3', 'credentials/changed 4', 'queue/add', 'session/set_mode']),
    ['the peer in src/daemon/runner-wire/peer.ts must hand a scoped request to its scope queue behind every held notification', `after the boot: ${j(scoped.after)}`, `the peer said: ${j(scoped.said)}`],
  )
  const refused = world()
  refused.refuseNext()
  refused.write(N() + INIT() + N() + R(2, 'session/facts') + N())
  await turn()
  refused.settleBoot()
  await turn()
  const afterRefusal = [...refused.order]
  refused.write(N())
  await turn()
  const keptWaiting = refused.order.slice(afterRefusal.length)
  refused.write(INIT(3))
  await turn()
  const afterTheNext = refused.order.slice(afterRefusal.length)
  refused.close()
  const refusedRequest = refused.answers().split('\n').filter(text => text !== '').map(text => JSON.parse(text) as { id?: number; error?: { code?: number } }).find(frame => frame.id === 2)
  check(
    'a notification held behind an initialize that is refused is treated as one that arrives just after the refusal: each is kept, none is said to be dropped, and after the next initialize that is answered they reach their arm in the order they arrived (three before the refusal, one after it); the request held behind the refused one is answered -32002',
    j(afterRefusal) === j(['the boot ended']) && keptWaiting.length === 0 && j(afterTheNext) === j(['the boot ended', 'credentials/changed 1', 'credentials/changed 2', 'credentials/changed 3', 'credentials/changed 4']) && !refused.said.some(text => text.includes('dropped')) && refusedRequest?.error?.code === -32002,
    ['the peer in src/daemon/runner-wire/peer.ts must keep notifications held behind a refused initialize and answer the held request -32002', `after the refusal: ${j(afterRefusal)}`, `before the next initialize: ${j(keptWaiting)}`, `after it: ${j(afterTheNext)}`, `the peer said: ${j(refused.said)}`, `the request: ${j(refusedRequest)}`],
  )
}

console.log(failures === 0 ? '\nprove-runner-boot-order: green' : `\nprove-runner-boot-order: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
