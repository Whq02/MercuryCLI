#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)
const SELF = 'scripts/headless/prove-runner-boot-order.ts'
const LIST = 'src/cli/headless/boot/bootList.ts'

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
  console.log('  [FAIL] the proof ended within its two minutes')
  process.exit(1)
}, 120_000).unref()

const realList = (await import(at(LIST))) as typeof import('../../src/cli/headless/boot/bootList.ts')
const { BOOT_STEPS, runBootSteps } = realList
const { BOOT_ENDS, createRunnerPorts, createRunnerState } = await import('../../src/cli/headless/runnerPorts.ts')
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
  check('a member read before its step has run is refused by name: the member and the step that makes it', driverStep !== undefined && thrown(() => ports.driver) === `the runner's port driver is read before the boot step ${driverStep.name} has made it`, [thrown(() => ports.driver)])
  const early = BOOT_STEPS.flatMap(step => step.makes.map(member => [member, step.name] as const)).filter(([member, step]) => thrown(() => ports[member]) !== `the runner's port ${member} is read before the boot step ${step} has made it`)
  check('…and so is every member the list makes, before the list has run', early.length === 0, early.map(([member, step]) => `${member} of ${step}: ${thrown(() => ports[member])}`))
  const driver = { kick: () => {} } as unknown as Ports['driver']
  if (driverStep !== undefined) give(driverStep, { driver })
  check('what a step makes is read from the ports as the value it made, once the list has given it', ports.driver === driver)
  check('a member no step of the list makes is refused by name, never read as undefined', thrown(() => (ports as unknown as Record<string, unknown>).noSuchMember) === "the runner's port noSuchMember is made by no step of the boot", [thrown(() => (ports as unknown as Record<string, unknown>).noSuchMember)])
  const first = given()
  const born = createRunnerPorts(first, BOOT_STEPS).ports
  check('what the runner is handed at its call is on the ports from the start', born.live === first.live && born.options === first.options && born.inputPrompt === 'the prompt' && born.getAppState === first.getAppState && born.hydrateResumedRun === first.hydrateResumedRun)
  const short = BOOT_STEPS.find(step => step.makes.length > 0)
  check('a step that names a member and does not make it is refused by name', short !== undefined && thrown(() => give(short, {})) === `the boot step ${short.name} names ${short.makes[0]} and did not make it`, [short === undefined ? 'no step makes a member' : thrown(() => give(short, {}))])
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
    [j(trace)],
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
  const realHydration = (await import(at('src/cli/headless/resumeHydration.ts'))) as Record<string, unknown>
  mock.module(at('src/cli/headless/resumeHydration.ts'), () => ({ ...realHydration, hydrateResumedRun: async (ports: unknown): Promise<void> => void hydrated.push(ports) }))
  const { runHeadless } = await import('../../src/cli/run.ts')
  const getAppState = (() => ({})) as Given['getAppState']
  const setAppState: Given['setAppState'] = () => {}
  const commands: Given['commands'] = []
  const tools: Given['tools'] = []
  const agents: Given['agents'] = []
  const options: Given['options'] = { door: 'wire' }
  await runHeadless('the words', getAppState, setAppState, commands, tools, agents, options)
  const call = calls[0]
  check('runHeadless runs BOOT_STEPS itself, once', calls.length === 1 && call?.steps === BOOT_STEPS && typeof call.give === 'function', [`${calls.length} calls`])
  check(
    'the ports it hands the list carry what it was called with, by identity, and a state of its own',
    call !== undefined && call.ports.inputPrompt === 'the words' && call.ports.getAppState === getAppState && call.ports.setAppState === setAppState && call.ports.commands === commands && call.ports.tools === tools && call.ports.agents === agents && call.ports.options === options && call.ports.live.awaitingSessionClaim === false && call.ports.live.turnsRun === 0,
  )
  await call?.ports.hydrateResumedRun()
  check('the resume the claim calls is the one closure, handed these ports', hydrated.length === 1 && hydrated[0] === call?.ports)
  check('before the list has run, the ports refuse a member the list makes', call !== undefined && thrown(() => call.ports.wire).startsWith("the runner's port wire is read before the boot step "), [call === undefined ? '' : thrown(() => call.ports.wire)])
}

section('(5) a notification that arrives while the runner boots is held with the requests and delivered after the boot, in the order it arrived')
{
  const { PassThrough } = await import('node:stream')
  const { createPeer } = await import('../../src/runner/wire/peer.ts')
  const { initializeResultOf } = await import('../../src/cli/headless/runnerMethods.ts')
  const turn = (): Promise<void> => new Promise(done => setTimeout(done, 25))
  const line = (frame: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`
  const hello = { protocol: 1, host: { name: 'proof-host', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }
  const booting = async (answer: 'the boot ends' | 'the boot refuses'): Promise<{ during: string[]; after: string[]; said: string[]; answers: string }> => {
    const input = new PassThrough()
    const output = new PassThrough()
    let answers = ''
    output.on('data', chunk => (answers += String(chunk)))
    const said: string[] = []
    const peer = createPeer({ input, output, side: 'runner', log: text => void said.push(text) })
    let bootSettled: () => void = () => {}
    const bootReady = new Promise<void>(done => (bootSettled = done))
    const order: string[] = []
    let changes = 0
    peer.onRequest('initialize', async () => {
      await bootReady
      order.push('the boot ended')
      if (answer === 'the boot refuses') throw new Error('the boot refused')
      return initializeResultOf(null, { capable: false } as never)
    })
    peer.onNotification('credentials/changed', () => void order.push(`credentials/changed ${++changes}`))
    peer.onRequest('session/send_now', async () => {
      order.push('session/send_now')
      return {} as never
    })
    input.write(line({ method: 'credentials/changed', params: {} }) + line({ id: 1, method: 'initialize', params: hello }) + line({ method: 'credentials/changed', params: {} }) + line({ id: 2, method: 'session/send_now', params: {} }) + line({ method: 'credentials/changed', params: {} }))
    await turn()
    const during = [...order]
    bootSettled()
    await turn()
    const after = [...order]
    peer.close('the proof is done')
    return { during, after, said, answers }
  }
  const booted = await booting('the boot ends')
  check(
    'three credentials/changed sent before initialize, behind it and behind a request reach their arm only after the boot has ended and initialize is answered, each once, in the order they arrived, and the request held with them is served',
    booted.during.length === 0 && booted.after[0] === 'the boot ended' && j(booted.after.filter(name => name.startsWith('credentials/changed'))) === j(['credentials/changed 1', 'credentials/changed 2', 'credentials/changed 3']) && booted.after.includes('session/send_now') && booted.after.length === 5 && !booted.said.some(text => text.includes('failed')),
    [`during the boot: ${j(booted.during)}`, `after it: ${j(booted.after)}`, `the peer said: ${j(booted.said)}`],
  )
  const refused = await booting('the boot refuses')
  check(
    'a boot that refuses initialize delivers none of them: the notifications held behind it are dropped with a line that says so, as the requests held behind it are refused',
    refused.during.length === 0 && j(refused.after) === j(['the boot ended']) && refused.said.filter(text => text.includes('credentials/changed') && text.includes('initialize')).length === 3 && refused.answers.includes('"id":2'),
    [`after it: ${j(refused.after)}`, `the peer said: ${j(refused.said)}`],
  )
}

console.log(failures === 0 ? '\nprove-runner-boot-order: green' : `\nprove-runner-boot-order: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
