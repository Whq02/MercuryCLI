#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { dirname, join, resolve } from 'node:path'
import type { FoldStatusV1 } from '../../src/engine/compaction/foldStatus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const WHERE_TO_LOOK = 'change the boot step this check names in its own file under src/daemon/runner/boot/ (BOOT_STEPS in bootList.ts lists them), or the resume closure hydrateResumedRun in src/daemon/runner/resumeHydration.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${WHERE_TO_LOOK}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes — a boot step or a resume step never settled: find the last section printed above and look in its step file under src/daemon/runner/boot/ or in hydrateResumedRun of src/daemon/runner/resumeHydration.ts')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[] }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)
const names = (): string[] => seen.map(call => call.name)

async function spied(rel: string, wanted: string[]): Promise<void> {
  const real = (await import(at(rel))) as Record<string, unknown>
  const wrapped = Object.fromEntries(
    wanted.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args })
        return answers.get(name)?.(...args)
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
}

async function watched(rel: string, wanted: string[]): Promise<void> {
  const real = { ...((await import(at(rel))) as Record<string, unknown>) }
  const wrapped = Object.fromEntries(
    wanted.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args })
        const answer = answers.get(name)
        return answer !== undefined ? answer(...args) : (real[name] as (...given: unknown[]) => unknown)(...args)
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
}

await spied('src/platform/substrate/recoveryOrchestrator.ts', ['runBootRecovery'])
await spied('src/engine/run/runCoordinator.ts', ['getRunSnapshot', 'reconcileOnResume'])
await spied('src/engine/tasks/local-agent/launchReceipts.ts', ['reconcileBackgroundLaunchesOnResume'])
await spied('src/daemon/runner/restartCarry.ts', ['carryRunnerAcrossRestart'])
await spied('src/engine/tasks/local-agent/pauseCarry.ts', ['carryPausedCrewmatesOnResume'])
await spied('src/tools/monitor/watchReceipts.ts', ['reconcileWatchesOnResume', 'reconcileBackgroundShellsOnResume'])
await spied('src/engine/tasks/taskLaunchLedger.ts', ['reconcileTaskLaunchesOnResume'])
await spied('src/daemon/switchboard/sessionReceipts.ts', ['appendSessionReceipt'])
await spied('src/daemon/runner/messageQueueManager.ts', ['enqueuePendingNotification'])
await spied('src/platform/logs/errorLog.ts', ['logError'])

await watched('src/daemon/runner/agentFreshness.ts', ['armRunnerAgentFreshness'])
await watched('src/platform/settings-faults/faultNotices.ts', ['currentSettingsFaults', 'untoldSettingsFaults'])
await watched('src/platform/text/hiddenCharacterFindings.ts', ['currentHiddenCharacterLines', 'untoldHiddenCharacterLines'])
await watched('src/integrations/event-hooks/hooksConfigSnapshot.ts', ['hooksSkippedForTrustLine'])
await watched('src/integrations/mcp/serverConfigs.ts', ['mcpServersSkippedForTrustLine'])
await watched('src/tools/kit/toolList.ts', ['toolsWithheldByDeny'])
await watched('src/daemon/runner/messageQueueManager.ts', ['subscribeToCommandQueue', 'getCommandQueue'])
await watched('src/daemon/runner/sdkEventQueue.ts', ['subscribeRows', 'drainRows'])
await watched('src/platform/processes/cleanupRegistry.ts', ['registerCleanup'])
await watched('src/engine/task-framework/tasks.ts', ['onTasksUpdated'])
await watched('src/permissions/guards/mission.ts', ['subscribeActiveMission', 'rearmMissionFromCard'])
await watched('src/integrations/samples/store.ts', ['subscribeSampleChanges'])
await watched('src/sessions/resume/sessionRestore.ts', ['restoreConversationModel'])
await watched('src/daemon/runner/model.ts', ['resolveHeadlessModel'])
await watched('src/daemon/runner/resume.ts', ['emitLoadError', 'loadInitialMessages'])
await watched('src/platform/processes/gracefulShutdown.ts', ['gracefulShutdownSync'])
await watched('src/models/roads/local/localWarm.ts', ['armLocalWarm'])
await watched('src/engine/system-prompt/systemPromptParts.ts', ['buildSideQuestionFallbackParams'])
await watched('src/platform/logs/runPhases.ts', ['noteRunPhase'])
await watched('src/platform/logs/activityLedger.ts', ['noteHeadlessActivity'])
await watched('src/daemon/runner/wireStdoutGuard.ts', ['installWireStdoutGuard'])
await watched('src/platform/processes/process.ts', ['registerProcessOutputErrorHandlers'])
await watched('src/sessions/transcripts/sessionStorage.ts', ['saveSessionModel'])
await watched('src/daemon/switchboard/sessionReceipts.ts', ['settleClearModel'])
await watched('src/sessions/transcripts/writer.ts', ['recordTranscript'])
await watched('src/permissions/guards/wardsGuard.ts', ['registerWardsGuard'])
await watched('src/crew/crewmates/identity.ts', ['bootCrewIdentity'])
await watched('src/platform/storage/boxLock.ts', ['refreshBoxReading'])
await watched('src/daemon/saturn/sessionScheduleBridge.ts', ['registerLocalWakeSink'])
{
  const real = (await import(at('src/platform/settings/changeDetector.ts'))) as { settingsChangeDetector: Record<string, unknown> }
  mock.module(at('src/platform/settings/changeDetector.ts'), () => ({
    ...real,
    settingsChangeDetector: {
      ...real.settingsChangeDetector,
      subscribe: (...args: unknown[]): (() => void) => {
        seen.push({ name: 'settingsChangeDetector.subscribe', args })
        return () => {}
      },
    },
  }))
}

const { hydrateResumedRun } = await import('../../src/daemon/runner/resumeHydration.ts')
const { BOOT_ENDS, createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { BOOT_STEPS } = await import('../../src/daemon/runner/boot/bootList.ts')
const { coerceRestartReason } = await import('../../src/engine/tasks/local-agent/launchReceipts.ts')
const { composeRestartLine } = await import('../../src/tools/monitor/watchReceipts.ts')
const { wrapInSystemReminder } = await import('../../src/engine/message-shapes/text.ts')
const { getEngineModelOverride, getSessionId, setEngineModelOverride } = await import('../../src/boot/process-state/processState.ts')
const { getCwd } = await import('../../src/platform/files/cwd.ts')
const { compactionRow } = await import('../../src/engine/rows/project.ts')
const { bootModelRefusalLine } = await import('../../src/daemon/runner/model.ts')
const { priorTurnCount } = await import('../../src/daemon/runner/claimSession.ts')
const { getEngineModel, parseUserSpecifiedModel } = await import('../../src/models/catalogue/engineModel.ts')
const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
const { modelSupportsEffort } = await import('../../src/models/facts/capabilities.ts')
const { resolveEffortTruth } = await import('../../src/models/effort/effort.ts')
const { getTranscriptPath } = await import('../../src/sessions/transcripts/paths.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

type Ports = Parameters<typeof hydrateResumedRun>[0]
type LaunchReconcile = Awaited<ReturnType<typeof import('../../src/engine/tasks/taskLaunchLedger.ts').reconcileTaskLaunchesOnResume>>
type CarryOutcome = Awaited<ReturnType<typeof import('../../src/daemon/runner/restartCarry.ts').carryRunnerAcrossRestart>>
type Scene = { ports: Ports; live: Ports['live']; messages: unknown[]; getAppState: () => unknown; setAppState: () => void; canUseTool: () => void; relaunchContext: () => Promise<unknown>; rows: Array<Record<string, unknown>>; launches: LaunchReconcile }

function scene(reason: string | undefined, messages: unknown[] = [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'the first words' } }]): Scene {
  seen.length = 0
  answers.clear()
  const launches: LaunchReconcile = {
    endedPids: [],
    orphans: [{ record: { v: 1, taskId: 'an-orphan', kind: 'monitor', toolUseId: 'toolu_orphan', description: 'an orphaned watch', command: 'tail -f a.log', persistent: false, outputPath: null, pid: null, startToken: null, armedAt: 1 }, process: 'gone' }],
    settledTaskIds: new Set(['a-settled-task']),
  }
  const carried: CarryOutcome = { recoveredCommandIds: ['recovered-1'], requeued: 1, relaunched: 0, delivered: 0, stopped: 0, row: null }
  answers.set('getRunSnapshot', () => null)
  answers.set('reconcileBackgroundLaunchesOnResume', () => [])
  answers.set('carryPausedCrewmatesOnResume', async () => [])
  answers.set('reconcileTaskLaunchesOnResume', async () => launches)
  answers.set('reconcileWatchesOnResume', () => [])
  answers.set('reconcileBackgroundShellsOnResume', () => [])
  answers.set('carryRunnerAcrossRestart', async () => carried)
  const live = createRunnerState()
  live.runnerRestartReason = reason
  const state = { tasks: { 'task-1': {} } }
  const getAppState = (): unknown => state
  const setAppState = (): void => {}
  const canUseTool = (): void => {}
  const relaunchContext = async (): Promise<unknown> => ({})
  const rows: Array<Record<string, unknown>> = []
  const ports = { live, messages, getAppState, setAppState, relaunchContext, asks: { createCanUseTool: () => canUseTool }, enqueueRow: (row: Record<string, unknown>) => void rows.push(row), liveScope: () => ({ session_id: 'the-session' }) } as unknown as Ports
  return { ports, live, messages, getAppState, setAppState, canUseTool, relaunchContext, rows, launches }
}

const STEPS = ['runBootRecovery', 'getRunSnapshot', 'reconcileOnResume', 'carryRunnerAcrossRestart', 'reconcileBackgroundLaunchesOnResume', 'carryPausedCrewmatesOnResume', 'reconcileTaskLaunchesOnResume', 'reconcileWatchesOnResume', 'reconcileBackgroundShellsOnResume']
const closure = (): string[] => names().filter(name => STEPS.includes(name))

section('§1 the one resume closure: its steps, in their order')
{
  const empty = scene('crash', [])
  await within(hydrateResumedRun(empty.ports))
  check('a conversation with no message hydrates nothing', seen.length === 0, j(names()))

  const crashed = scene('crash')
  await within(hydrateResumedRun(crashed.ports))
  check('O1 both calls sit in hydrateResumedRun, the carry first (the order this proof drives them in): boot recovery, the run reconcile, the restart carry, the launch receipts, the paused crewmates, the task launches, the watches, the background shells', j(closure()) === j(STEPS), j(names()))
  const launches = said('reconcileBackgroundLaunchesOnResume')[0]?.args ?? []
  check(
    'the runner reconciles inside the one resume closure both roads share, carrying the restart reason',
    launches[0] === crashed.messages && launches[1] === crashed.getAppState && launches[2] === crashed.setAppState && typeof launches[3] === 'number' && Math.abs((launches[3] as number) - Date.now()) < 5_000 && launches[4] === coerceRestartReason('crash') && launches[4] === 'crash',
    j(launches.slice(3)),
  )
  const carry = said('carryRunnerAcrossRestart')[0]?.args[0] as Record<string, unknown> | undefined
  check(
    'the restart carry is handed the reason, the conversation, the runner\'s own permission road and its relaunch context, and the ids it recovered land on the state',
    carry?.reason === 'crash' && carry.messages === crashed.messages && carry.getAppState === crashed.getAppState && carry.setAppState === crashed.setAppState && carry.canUseTool === crashed.canUseTool && carry.relaunchContext === crashed.relaunchContext && j(crashed.live.recoveredCommandIds) === j(['recovered-1']),
    `${j(Object.keys(carry ?? {}))} · ${j(crashed.live.recoveredCommandIds)}`,
  )
  const recovery = said('runBootRecovery')[0]?.args[0] as Record<string, unknown> | undefined
  const watches = said('reconcileWatchesOnResume')[0]?.args ?? []
  const shells = said('reconcileBackgroundShellsOnResume')[0]?.args ?? []
  const ledgerAsk = said('reconcileTaskLaunchesOnResume')[0]?.args ?? []
  check(
    'boot recovery is scoped to the session, and the watches and the shells are reconciled against the live task ids with the reason and with the very orphans and settled ids the launch ledger answered',
    recovery?.scope === 'session' && recovery.sessionId === getSessionId() && j([...(watches[1] as Set<string>)]) === j(['task-1']) && watches[2] === 'crash' && watches[3] === crashed.launches.orphans && watches[4] === crashed.launches.settledTaskIds && shells[0] === crashed.messages && shells[2] === 'crash' && shells[3] === crashed.launches.orphans && shells[4] === crashed.launches.settledTaskIds && ledgerAsk[0] === String(getSessionId()) && ledgerAsk[1] === watches[1],
    `${j(recovery)} · ${j(watches.slice(2))}`,
  )
  check('a crash tells the conversation nothing of its own: no receipt, no pending notification, no row', said('appendSessionReceipt').length === 0 && said('enqueuePendingNotification').length === 0 && crashed.rows.length === 0, j(names()))

  const plain = scene(undefined)
  await within(hydrateResumedRun(plain.ports))
  check('a resume the runner was told no reason for carries nothing across and reconciles the launches under no reason', said('carryRunnerAcrossRestart').length === 0 && said('reconcileBackgroundLaunchesOnResume')[0]?.args[4] === coerceRestartReason(undefined) && j(plain.live.recoveredCommandIds) === j([]) && j(closure()) === j(STEPS.filter(name => name !== 'carryRunnerAcrossRestart')), j(names()))

  const standing = scene('stop')
  answers.set('getRunSnapshot', () => ({ standing: true }))
  await within(hydrateResumedRun(standing.ports))
  check('a run whose snapshot stands is not reconciled again, and the steps after it still run', said('reconcileOnResume').length === 0 && said('carryRunnerAcrossRestart').length === 1 && said('reconcileBackgroundShellsOnResume').length === 1, j(names()))
}

section('§2 a step that fails is logged and the next step runs; an update or an end is told once')
{
  const broken = scene('crash')
  const lost = new Error('the recovery store is unreadable')
  answers.set('runBootRecovery', async () => Promise.reject(lost))
  answers.set('carryRunnerAcrossRestart', async () => Promise.reject(new Error('the carry failed')))
  const settled = await within(hydrateResumedRun(broken.ports).then(() => 'settled', () => 'threw'))
  check('a step that throws is logged and does not end the resume: every later step still runs', settled === 'settled' && said('logError').length === 2 && said('logError')[0]?.args[0] === lost && j(closure()) === j(STEPS) && j(broken.live.recoveredCommandIds) === j([]), `${String(settled)} · ${j(names())}`)

  const updated = scene('update')
  await within(hydrateResumedRun(updated.ports))
  const receipt = said('appendSessionReceipt')[0]?.args[2] as { kind?: string; by?: string; summary?: string; details?: Record<string, unknown> } | undefined
  const notice = said('enqueuePendingNotification')[0]?.args[0] as Record<string, unknown> | undefined
  const line = receipt?.summary ?? ''
  check(
    'a restart for an update is told once: a runner-restart receipt with the reason and the counts, a notification that rides the next words, and a warning row, all three with the one line',
    receipt?.kind === 'runner-restart' && receipt.by === 'runner' && receipt.details?.reason === 'update' && receipt.details.watches === 0 && receipt.details.shells === 0 && line !== '' && line === composeRestartLine({ reason: 'update', build: String(receipt.details.build), watches: [], shells: [] }) && said('appendSessionReceipt')[0]?.args[1] === String(getSessionId()) && j(notice) === j({ value: wrapInSystemReminder(line), mode: 'task-notification', priority: 'next', ridesNextWords: true }) && updated.rows.length === 1 && updated.rows[0]!.type === 'notice' && updated.rows[0]!.level === 'warning' && updated.rows[0]!.text === line && updated.rows[0]!.session_id === 'the-session',
    `${j(receipt)} · ${j(notice)} · ${j(updated.rows)}`,
  )
  const ended = scene('ended')
  await within(hydrateResumedRun(ended.ports))
  check('…and so is a runner that had ended', said('appendSessionReceipt').length === 1 && said('enqueuePendingNotification').length === 1 && ended.rows.length === 1)
}

type BootPorts = Parameters<(typeof BOOT_STEPS)[number]['run']>[0]
type Made = Partial<BootPorts>
const CALLED = ['hydrateColdResume', 'wireSession', 'warnAtBoot', 'wireProcess', 'loadSession', 'poolTools', 'sourceRows', 'watchMission', 'restoreRecordedModel', 'seatSession', 'catalogueModels', 'armWarm', 'armAgentFreshness', 'watchQueue', 'bindNotificationFrames', 'registerBootCleanup', 'armLocalWake']
const stepOf = (name: string): (typeof BOOT_STEPS)[number] => {
  if (!CALLED.includes(name)) throw new Error(`${name} is not among the steps this proof says it calls`)
  return BOOT_STEPS.find(candidate => candidate.name === name) ?? { name, makes: [], run: () => ({}) }
}
const handed = (step: string, members: object): BootPorts =>
  new Proxy(members, {
    get: (target, member) => {
      if (member in target) return (target as Record<PropertyKey, unknown>)[member]
      if (typeof member === 'symbol' || member === 'then') return undefined
      throw new Error(`the step ${step} read ports.${member}, which this scene does not hand it`)
    },
  }) as unknown as BootPorts
const ran = (name: string, members: object): Promise<Made | typeof BOOT_ENDS | typeof UNSETTLED> => within(Promise.resolve().then(() => stepOf(name).run(handed(name, members))))
const madeOf = (result: Made | typeof BOOT_ENDS | typeof UNSETTLED): Made => (result === BOOT_ENDS || result === UNSETTLED ? {} : result)
function fresh(): void {
  seen.length = 0
  answers.clear()
  answers.set('gracefulShutdownSync', () => undefined)
  answers.set('emitLoadError', () => undefined)
}

section('§3 the cold road: the boot reads the restart reason, wires the session it carries, and runs the one resume closure')
{
  const absent = CALLED.filter(name => !BOOT_STEPS.some(step => step.name === name))
  check(`BOOT_STEPS of src/daemon/runner/boot/bootList.ts holds the ${CALLED.length} steps this proof calls, each by its name`, absent.length === 0, `${absent.join(', ')} left the list: put the step back, or move its checks with what it did`)
  for (const options of [{ resume: 'the-session' }, { continue: true }]) {
    const resumed = scene('crash')
    await ran('hydrateColdResume', { ...(resumed.ports as object), options })
    check(`the cold road (${'resume' in options ? '--resume' : '--continue'}) runs the one resume closure, handed the runner's own ports`, j(closure()) === j(STEPS) && said('reconcileBackgroundLaunchesOnResume')[0]?.args[0] === resumed.messages && said('carryRunnerAcrossRestart').length === 1, j(names()))
  }
  const cold = scene('crash')
  await ran('hydrateColdResume', { ...(cold.ports as object), options: {} })
  check('a run that resumes nothing does not run the resume closure', seen.length === 0, j(names()))

  const wired = async (members: { worker: boolean; awaiting: boolean; peer: unknown; reason?: string }): Promise<{ live: BootPorts['live']; made: Made; setAppState: () => void }> => {
    fresh()
    answers.set('registerWardsGuard', () => undefined)
    answers.set('rearmMissionFromCard', () => undefined)
    answers.set('bootCrewIdentity', async () => undefined)
    answers.set('refreshBoxReading', async () => undefined)
    const live = createRunnerState()
    live.awaitingSessionClaim = members.awaiting
    const setAppState = (): void => {}
    if (members.reason === undefined) delete process.env.MERCURY_RUNNER_RESTART_REASON
    else process.env.MERCURY_RUNNER_RESTART_REASON = members.reason
    const made = madeOf(await ran('wireSession', { isConcourseWorker: members.worker, live, peer: members.peer, setAppState }))
    delete process.env.MERCURY_RUNNER_RESTART_REASON
    return { live, made, setAppState }
  }
  const sid = String(getSessionId())
  const worker = await wired({ worker: true, awaiting: false, peer: null, reason: 'crash' })
  const armed = { wards: said('registerWardsGuard').map(call => call.args), mission: said('rearmMissionFromCard').map(call => call.args), crew: said('bootCrewIdentity').map(call => call.args), box: said('refreshBoxReading').length }
  check('WR the runner reads the restart reason at boot and keeps it on its state for the reconciliation', worker.live.runnerRestartReason === 'crash', String(worker.live.runnerRestartReason))
  check(
    'the print path registers the wards guard too: a worker that carries its session arms the wards guard, the mission and the crew identity under that session at boot, and reads the box',
    armed.wards.length === 1 && armed.wards[0]![0] === worker.setAppState && armed.wards[0]![1] === sid && j(armed.mission) === j([[{ cardSessionId: sid, armSessionId: sid }]]) && j(armed.crew) === j([[{ sessionId: sid, worktreeRef: getCwd() }]]) && armed.box === 1 && worker.made.releaseQueueUntilClaimed === null && worker.live.mcpInitialized === true,
    j(armed),
  )
  const held: string[] = []
  const release = (): void => {}
  const waiting = await wired({ worker: true, awaiting: true, peer: { holdScope: (scope: string) => (held.push(scope), release) } })
  const armedAtBoot = said('registerWardsGuard').length
  await within(waiting.made.armSessionRunnerWiring?.('the-claimed-session') ?? Promise.resolve())
  check(
    'the runner holds queue/add from its boot while it awaits a claim: it holds the queue scope of its peer once and hands the release on for the claim, arms nothing under a session it does not have, and the wiring it hands on arms under the claimed id',
    j(held) === j(['queue']) && waiting.made.releaseQueueUntilClaimed === release && armedAtBoot === 0 && waiting.live.mcpInitialized === false && waiting.live.runnerRestartReason === undefined && j(said('registerWardsGuard').map(call => call.args[1])) === j(['the-claimed-session']),
    `${j(held)} · ${armedAtBoot} · ${j(said('registerWardsGuard').map(call => call.args[1]))}`,
  )
  const unheld: string[] = []
  const plain = await wired({ worker: false, awaiting: false, peer: { holdScope: (scope: string) => (unheld.push(scope), release) } })
  check('a runner that carries its session holds no scope, and one that is no worker arms no wiring and reads no box', unheld.length === 0 && plain.made.releaseQueueUntilClaimed === null && said('registerWardsGuard').length === 0 && said('refreshBoxReading').length === 0, j(names()))
}

section('§4 the boot\'s warnings, its stamps and the session it loads')
{
  const written = async (door: 'wire' | undefined, notice: string | null, set: () => void): Promise<string[]> => {
    fresh()
    for (const name of ['currentSettingsFaults', 'untoldSettingsFaults', 'currentHiddenCharacterLines', 'untoldHiddenCharacterLines', 'toolsWithheldByDeny']) answers.set(name, () => [])
    answers.set('hooksSkippedForTrustLine', () => null)
    answers.set('mcpServersSkippedForTrustLine', () => null)
    set()
    const lines: string[] = []
    const real = process.stderr.write
    process.stderr.write = ((chunk: unknown): boolean => (lines.push(String(chunk)), true)) as typeof process.stderr.write
    try {
      await ran('warnAtBoot', { getAppState: () => ({ toolPermissionContext: {} }), options: door === undefined ? {} : { door }, windowsShellRoadNotice: () => notice })
    } finally {
      process.stderr.write = real
    }
    return lines
  }
  const noticed = await written(undefined, 'the shell road notice', () => {})
  const quiet = await written(undefined, null, () => {})
  const onWire = await written('wire', 'the shell road notice', () => answers.set('hooksSkippedForTrustLine', () => 'the hooks were skipped'))
  const onPrint = await written(undefined, null, () => answers.set('hooksSkippedForTrustLine', () => 'the hooks were skipped'))
  check('the headless boot notice of the Windows shell road is one stderr line, on both doors, and a road with no notice writes nothing', j(noticed) === j(['the shell road notice\n']) && quiet.length === 0 && j(onWire) === j(['the shell road notice\n']) && onPrint.length === 1 && onPrint[0]!.endsWith(' the hooks were skipped\n'), `${j(noticed)} · ${j(quiet)} · ${j(onWire)} · ${j(onPrint)}`)

  fresh()
  for (const name of ['noteRunPhase', 'noteHeadlessActivity']) answers.set(name, () => undefined)
  performance.mark('cli_entry')
  const entry = performance.getEntriesByName('cli_entry')[0]?.startTime
  const process1 = madeOf(await ran('wireProcess', { inputPrompt: 'the words', options: {}, setAppState: () => {} }))
  const processStamps = said('noteRunPhase').map(call => call.args)
  const activity = said('noteHeadlessActivity').map(call => call.args[0])
  const subscribed = said('settingsChangeDetector.subscribe').length

  fresh()
  for (const name of ['noteRunPhase', 'installWireStdoutGuard']) answers.set(name, () => undefined)
  const firstWords = { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'the first words' } }
  const answer = { messages: [firstWords], resumedSessionId: 'the-resumed-session' }
  answers.set('loadInitialMessages', async () => answer)
  const loadLive = createRunnerState()
  const loadSet = (): void => {}
  const load = madeOf(await ran('loadSession', { live: loadLive, options: { outputFormat: 'rows', resume: 'the-session' }, setAppState: loadSet, wire: false }))
  const loadOrder = names().filter(name => ['installWireStdoutGuard', 'noteRunPhase', 'loadInitialMessages'].includes(name))
  const loadStamps = said('noteRunPhase').map(call => call.args)
  const loadAsk = said('loadInitialMessages')[0]?.args ?? []
  await ran('loadSession', { live: createRunnerState(), options: { outputFormat: 'rows' }, setAppState: loadSet, wire: true })
  const wireAsk = said('loadInitialMessages')[1]?.args ?? []

  fresh()
  for (const name of ['noteRunPhase', 'registerProcessOutputErrorHandlers']) answers.set(name, () => undefined)
  const canUse = (): void => {}
  const own = { name: 'Read' }
  const keptTool = { name: 'mcp__files__kept' }
  const deniedTool = { name: 'mcp__files__denied' }
  const pool = madeOf(await ran('poolTools', { asks: { createCanUseTool: () => canUse }, getAppState: () => ({ toolPermissionContext: { alwaysDenyRules: { userSettings: ['mcp__files__denied'] } }, mcp: { tools: [keptTool, deniedTool] } }), tools: [own] }))
  const poolOrder = names().filter(name => ['registerProcessOutputErrorHandlers', 'noteRunPhase'].includes(name))
  const poolStamps = said('noteRunPhase').map(call => call.args)

  check(
    'the boot stamps graph_load (backdated to cli_entry) and cli_parse where the process is wired, invocation_resolution before the session is loaded, and config_auth once the tool pool stands',
    typeof entry === 'number' && j(processStamps) === j([['graph_load', entry], ['cli_parse']]) && j(loadStamps) === j([['invocation_resolution']]) && j(loadOrder) === j(['installWireStdoutGuard', 'noteRunPhase', 'loadInitialMessages']) && j(poolStamps) === j([['config_auth']]) && j(poolOrder) === j(['registerProcessOutputErrorHandlers', 'noteRunPhase']),
    `${j(processStamps)} · ${j(loadOrder)} ${j(loadStamps)} · ${j(poolOrder)} ${j(poolStamps)}`,
  )
  check('the process is wired once: the run is noted as a print run for a prompt given in words, and the settings watcher is subscribed', process1.streamingInput === false && j(activity) === j(['print']) && subscribed === 1, `${j(activity)} · ${subscribed}`)
  check(
    'the session is loaded through the one loader with the run\'s own options, in the print format on the rows door and as text on the wire, and what it answers is the conversation the runner holds',
    loadAsk[0] === loadSet && (loadAsk[1] as { outputFormat?: string; resume?: string })?.outputFormat === 'rows' && (loadAsk[1] as { resume?: string })?.resume === 'the-session' && (wireAsk[1] as { outputFormat?: string })?.outputFormat === 'text' && load.loaded === answer && load.messages === answer.messages && loadLive.resumeOf === 'the-resumed-session' && loadLive.turnsRun === priorTurnCount(answer.messages as never),
    j(loadAsk[1]),
  )
  check('the tool pool is the tools the run was given and the MCP tools no deny rule names, and the permission road is the ask host\'s own', j(pool.sessionTools) === j([own, keptTool]) && pool.sessionTools?.[0] === (own as never) && pool.sessionTools?.[1] === (keptTool as never) && pool.canUseTool === (canUse as never), j(pool.sessionTools))
}

section('§5 the rows the boot sources: the fold, the mission, the samples, and a recorded model that is refused')
{
  fresh()
  const live = createRunnerState()
  const sourced = madeOf(await ran('sourceRows', { io: { outbound: { enqueue: () => {} } }, live, options: {}, peer: null }))
  const fold: FoldStatusV1 = { schema: 1, trigger: 'auto', startedAtMs: 1, stages: ['summarising'], stage: 'summarising', fill: 0.5, summaryTokens: 10, summaryCapTokens: 100, attempt: 1 }
  const scope = sourced.liveScope?.()
  const row = sourced.statusRowOf?.({ compacting: fold })
  check("the runner relays the fold's stamp as a compaction row: the status the compact service stamps under the compacting key comes back as the row compactionRow makes of it under the live scope", scope !== undefined && row !== null && row !== undefined && j(row) === j(compactionRow(scope, fold)) && (row as { type?: string }).type === 'compaction' && scope.session_id === getSessionId() && live.openFold !== null, j(row))

  fresh()
  for (const name of ['onTasksUpdated', 'subscribeActiveMission', 'subscribeSampleChanges']) answers.set(name, () => () => {})
  const rows: Array<Record<string, unknown>> = []
  const mission = madeOf(await ran('watchMission', { enqueueRow: (made: Record<string, unknown>) => void rows.push(made), liveScope: () => ({ session_id: 'the-session' }) }))
  const onTasks = said('onTasksUpdated')[0]?.args[0] as (() => void) | undefined
  const onMission = said('subscribeActiveMission')[0]?.args[0] as (() => void) | undefined
  const onSamples = said('subscribeSampleChanges')[0]?.args[0] as (() => void) | undefined
  onTasks?.()
  onMission?.()
  onTasks?.()
  const atOnce = rows.length
  await pause(150)
  const afterMission = rows.map(made => made.type)
  onSamples?.()
  onSamples?.()
  await pause(150)
  check(
    'the runner writes the mission row on every task write and every mission change through one debounced writer: both subscriptions hold the same function, and three changes inside its 50 ms make one mission_updated row under the live scope',
    onTasks !== undefined && onTasks === onMission && atOnce === 0 && j(afterMission) === j(['mission_updated']) && rows[0]!.session_id === 'the-session' && typeof (mission.missionGuard as { subscribeActiveMission?: unknown } | undefined)?.subscribeActiveMission === 'function',
    j(rows),
  )
  check('F6d the runner writes the samples row on every change, debounced: two changes inside its 50 ms make one samples_updated row', onSamples !== undefined && j(rows.map(made => made.type)) === j(['mission_updated', 'samples_updated']) && rows[1]?.session_id === 'the-session', j(rows))

  const restored = async (recorded: string | null, resolveModel: () => Promise<string>, members: { wire: boolean; options: Record<string, unknown> }): Promise<{ result: Made | typeof BOOT_ENDS | typeof UNSETTLED; live: BootPorts['live']; rows: Array<Record<string, unknown>>; override: unknown; messages: unknown[] }> => {
    fresh()
    setEngineModelOverride(undefined)
    answers.set('restoreConversationModel', () => recorded)
    answers.set('resolveHeadlessModel', resolveModel)
    const state = createRunnerState()
    const made: Array<Record<string, unknown>> = []
    const messages: unknown[] = []
    const result = await ran('restoreRecordedModel', { enqueueRow: (one: Record<string, unknown>) => void made.push(one), live: state, liveScope: () => ({ session_id: 'the-session' }), loaded: { messages, model: 'the-recorded-setting' }, messages, options: members.options, wire: members.wire })
    const override = getEngineModelOverride()
    setEngineModelOverride(undefined)
    return { result, live: state, rows: made, override, messages }
  }
  const refusing = async (): Promise<string> => Promise.reject(new Error('no endpoint is configured'))
  const print = await restored('compat/lane/model', refusing, { wire: false, options: { resume: 'the-session', outputFormat: 'rows' } })
  const printSaid = { load: said('emitLoadError').map(call => call.args), exit: said('gracefulShutdownSync').map(call => call.args), asked: said('restoreConversationModel')[0]?.args[0] as { messages?: unknown; model?: unknown } | undefined }
  check(
    'the retention site refuses a recorded compat route the resolver refuses, never another provider: on the print door the boot ends there with one load error that names the model and the reason, and exit 1',
    print.result === BOOT_ENDS && j(printSaid.load) === j([["The resumed session's model 'compat/lane/model' is not usable: no endpoint is configured", 'rows']]) && j(printSaid.exit) === j([[1]]) && print.rows.length === 0 && print.live.bootModel === undefined && printSaid.asked?.messages === print.messages && printSaid.asked?.model === 'the-recorded-setting',
    j(printSaid),
  )
  const wire = await restored('compat/lane/model', refusing, { wire: true, options: { continue: true } })
  check(
    '…and on the wire door the runner boots on that route with the refusal kept for the facts and the claim, and ends nothing',
    wire.result !== BOOT_ENDS && wire.result !== UNSETTLED && wire.live.bootModel === parseUserSpecifiedModel('compat/lane/model') && wire.override === wire.live.bootModel && wire.live.bootModelRefusal === bootModelRefusalLine(String(wire.live.bootModel), 'no endpoint is configured') && said('gracefulShutdownSync').length === 0 && said('emitLoadError').length === 0 && wire.rows.length === 0,
    `${String(wire.live.bootModel)} · ${String(wire.live.bootModelRefusal)}`,
  )
  const other = await restored('some-retired-model', refusing, { wire: false, options: { resume: 'the-session' } })
  check(
    'the retention site skips a recorded model of another kind that the resolver refuses and enqueues the notice naming the fallback',
    other.result !== BOOT_ENDS && other.result !== UNSETTLED && other.rows.length === 1 && other.rows[0]!.type === 'notice' && other.rows[0]!.level === 'warning' && other.rows[0]!.text === `The resumed session's model 'some-retired-model' is not usable (no endpoint is configured) — this run uses ${getEngineModel()} instead.` && other.live.bootModel === undefined && other.override === undefined && said('gracefulShutdownSync').length === 0,
    j(other.rows),
  )
  const taken = await restored('the-recorded-model', async () => 'the-resolved-model', { wire: false, options: { resume: 'the-session' } })
  const named = await restored('the-recorded-model', async () => 'the-resolved-model', { wire: false, options: { resume: 'the-session', userSpecifiedModel: 'another-model' } })
  const cold = await restored('the-recorded-model', async () => 'the-resolved-model', { wire: false, options: {} })
  const coldAsked = said('restoreConversationModel').length
  check('a recorded model the resolver takes becomes the boot model; a model the caller named is not replaced by the record, and a run that resumes nothing reads no record', taken.live.bootModel === 'the-resolved-model' && taken.override === 'the-resolved-model' && named.live.bootModel === undefined && cold.live.bootModel === undefined && coldAsked === 0)
}

section('§6 the seat: the clear model, the catalogue, the warm, the freshness seam')
{
  const seated = async (members: { worker: boolean; awaiting: boolean; bootModel?: string; row: unknown }): Promise<{ live: BootPorts['live']; made: Made; messages: unknown[]; commands: unknown[]; agents: unknown[]; thinkingConfig: unknown; hooks: string[] }> => {
    fresh()
    answers.set('saveSessionModel', () => undefined)
    answers.set('settleClearModel', () => members.row)
    answers.set('recordTranscript', async () => undefined)
    const live = createRunnerState()
    live.awaitingSessionClaim = members.awaiting
    live.bootModel = members.bootModel
    const messages: unknown[] = []
    const commands = [{ name: 'a-command' }]
    const agents = [{ agentType: 'an-agent' }]
    const thinkingConfig = { type: 'disabled' }
    const hooks: string[] = []
    const made = madeOf(await ran('seatSession', { agents, asks: { setOnControlRequestSent: () => void hooks.push('sent'), setOnControlRequestResolved: () => void hooks.push('resolved') }, commands, isConcourseWorker: members.worker, live, messages, options: { thinkingConfig } }))
    return { live, made, messages, commands, agents, thinkingConfig, hooks }
  }
  const clearRow = { type: 'system', uuid: 'the-clear-row' }
  const born = await seated({ worker: true, awaiting: false, bootModel: 'the-boot-model', row: clearRow })
  const settle = said('settleClearModel').map(call => call.args)
  const saved = said('saveSessionModel').map(call => call.args)
  const recorded = said('recordTranscript').map(call => call.args)
  check(
    'C3 the runner compares the inherited model with its effective model on a cold boot: a worker that carries its session settles the clear model once, under its transcript home and its session, against the model it boots on, and lands the row it is answered in the conversation and on the transcript',
    settle.length === 1 && settle[0]![0] === dirname(getTranscriptPath()) && settle[0]![1] === String(getSessionId()) && settle[0]![2] === 'the-boot-model' && born.messages.length === 1 && born.messages[0] === clearRow && recorded.length === 1 && (recorded[0]![0] as unknown[])[0] === clearRow && recorded[0]![2] === born.messages,
    j({ settle, recorded: recorded.length }),
  )
  check(
    'the seat is set from the boot: the model the run boots on is saved and active, the commands, the agents and the thinking setting the run was given are the live ones, both ask hooks are set, and the memory of received ids is bounded and the map of interrupts is empty',
    j(saved) === j([['the-boot-model']]) && born.live.activeModel === 'the-boot-model' && born.live.activeCommands === (born.commands as never) && born.live.activeAgents === (born.agents as never) && born.live.thinkingConfig === (born.thinkingConfig as never) && j(born.hooks) === j(['sent', 'resolved']) && born.made.interruptOutcomes instanceof Map && born.made.receivedUuids?.has('never-seen') === false && (born.made.receivedUuids?.add('seen-once'), born.made.receivedUuids?.has('seen-once')) === true,
    j({ saved, hooks: born.hooks }),
  )
  const unclaimed = await seated({ worker: true, awaiting: true, row: null })
  const settledAtBoot = said('settleClearModel').length
  unclaimed.made.settleClearBirth?.()
  const settledByClaim = said('settleClearModel').map(call => call.args[2])
  const noWorker = await seated({ worker: false, awaiting: false, row: clearRow })
  check('…a worker that awaits its claim settles nothing at boot and hands the same settling on for the claim, which compares against the engine\'s model when no model was named; a run that is no worker settles nothing', settledAtBoot === 0 && j(settledByClaim) === j([getEngineModel()]) && unclaimed.messages.length === 0 && noWorker.messages.length === 0 && said('settleClearModel').length === 0, j({ settledAtBoot, settledByClaim }))

  fresh()
  const catalogue = (madeOf(await ran('catalogueModels', {})).modelInfos ?? []) as Array<{ value: string; display_name?: string; supports_effort?: boolean; supported_effort_levels?: string[] }>
  const options = getModelOptions()
  const off = catalogue.filter(info => {
    const resolved = parseUserSpecifiedModel(info.value) ?? info.value
    return modelSupportsEffort(resolved) ? info.supports_effort !== true || j(info.supported_effort_levels) !== j([...resolveEffortTruth(resolved, undefined).selectable]) : info.supported_effort_levels !== undefined
  })
  check(
    "print: the catalogue lists the owner's stops per model: one entry for each model option under its label, the stops resolveEffortTruth gives for a model that takes an effort, and none for a model that takes none",
    catalogue.length > 0 && j(catalogue.map(info => [info.value, info.display_name])) === j(options.map(option => [option.value, option.label])) && catalogue.some(info => info.supports_effort === true) && off.length === 0,
    j(off),
  )

  fresh()
  const disarmWarm = (): void => {}
  answers.set('armLocalWarm', () => disarmWarm)
  answers.set('buildSideQuestionFallbackParams', () => 'the bundle')
  const warmLive = createRunnerState()
  warmLive.activeCommands = [{ name: 'a-command' }] as never
  warmLive.activeAgents = [{ agentType: 'an-agent' }] as never
  warmLive.thinkingConfig = { type: 'disabled' } as never
  const state = { mcp: { clients: [{ name: 'a-server' }] } }
  const tools = [{ name: 'Read' }]
  const cache = { the: 'cache' }
  const warmMessages: unknown[] = []
  const getAppState = (): unknown => state
  const setAppState = (): void => {}
  const assembled: unknown[] = []
  await ran('armWarm', { assembleTools: (from: unknown) => (assembled.push(from), tools), getAppState, getReadFileCache: () => cache, live: warmLive, messages: warmMessages, options: { systemPrompt: 'the brief', appendSystemPrompt: 'and more' }, setAppState })
  const arming = said('armLocalWarm').map(call => call.args)
  const bundleOf = arming[0]?.[0] as (() => unknown) | undefined
  const seat = arming[0]?.[1] as { live?: () => boolean } | undefined
  const idle = seat?.live?.()
  warmLive.inFlightAbort = new AbortController()
  const inTurn = seat?.live?.()
  warmLive.inFlightAbort = null
  warmLive.awaitingSessionClaim = true
  const unclaimedSeat = seat?.live?.()
  const bundle = bundleOf?.()
  const asked = said('buildSideQuestionFallbackParams')[0]?.args[0] as Record<string, unknown> | undefined
  check(
    'the runner arms the local warm ONCE with the side-question fallback bundle (the same prompt and tool assembly a turn uses) and the seat liveness: live while the session is claimed and no turn is in flight',
    arming.length === 1 && bundle === 'the bundle' && asked !== undefined && asked.tools === tools && assembled.length === 1 && assembled[0] === state && asked.commands === warmLive.activeCommands && asked.mcpClients === state.mcp.clients && asked.messages === warmMessages && asked.readFileState === cache && asked.getAppState === getAppState && asked.setAppState === setAppState && asked.customSystemPrompt === 'the brief' && asked.appendSystemPrompt === 'and more' && asked.thinkingConfig === warmLive.thinkingConfig && asked.agents === warmLive.activeAgents && idle === true && inTurn === false && unclaimedSeat === false,
    j({ arming: arming.length, keys: Object.keys(asked ?? {}), idle, inTurn, unclaimedSeat }),
  )

  fresh()
  const disarm = (): void => {}
  answers.set('armRunnerAgentFreshness', () => disarm)
  const freshLive = createRunnerState()
  const roster = [{ agentType: 'the-first' }]
  const reloaded = [{ agentType: 'the-second' }]
  freshLive.activeAgents = roster as never
  const freshness = madeOf(await ran('armAgentFreshness', { live: freshLive }))
  const seam = said('armRunnerAgentFreshness')[0]?.args[0] as { cwd: () => string; getActive: () => unknown; setActive: (agents: unknown) => void } | undefined
  const readFirst = seam?.getActive()
  seam?.setActive(reloaded)
  check(
    'the runner arms the agent freshness seam once over the live roster binding: the seam reads the roster the state holds at that moment and writes the state, and the step hands on the seam\'s own disarm',
    said('armRunnerAgentFreshness').length === 1 && readFirst === roster && freshLive.activeAgents === (reloaded as never) && seam?.getActive() === reloaded && seam?.cwd() === getCwd() && freshness.disarmAgentFreshness === disarm,
    j(names()),
  )
}

section('§7 the queue, the cleanup and the local wake')
{
  fresh()
  const stopDrain = (): void => {}
  answers.set('subscribeRows', () => stopDrain)
  answers.set('drainRows', () => [])
  let queue: Array<Record<string, unknown>> = []
  answers.set('getCommandQueue', () => queue)
  answers.set('subscribeToCommandQueue', () => () => {})
  const live = createRunnerState()
  let running = false
  let startsOnKick = false
  let kicks = 0
  const announced: unknown[][] = []
  const driver = {
    isRunning: () => running,
    kick: () => {
      kicks++
      if (startsOnKick) running = true
    },
  }
  const watching = madeOf(await ran('watchQueue', { driver, emitCommandNotifications: (commands: unknown[]) => void announced.push(commands), enqueueRow: () => {}, isMainThreadCommand: (command: { agentId?: string }) => command.agentId === undefined, live }))
  const onQueue = said('subscribeToCommandQueue')[0]?.args[0] as (() => void) | undefined
  const mine = { value: 'a notice', mode: 'task-notification' }
  const theirs = { value: "an agent's line", mode: 'prompt', agentId: 'a-1' }
  queue = [mine, theirs]
  onQueue?.()
  const beforeTheSession = { kicks, announced: announced.length }
  live.sessionInitialized = true
  onQueue?.()
  const idle = { kicks, announced: announced.length, first: announced[0]?.length, same: announced[0]?.[0] === mine }
  startsOnKick = true
  onQueue?.()
  const started = { kicks, announced: announced.length }
  const abort = new AbortController()
  live.inFlightAbort = abort
  queue = [{ value: 'now', mode: 'prompt', priority: 'now' }]
  onQueue?.()
  check(
    "lock: the idle kick speaks a notice's frame through the one announcer: once the session has started and no turn runs, a queued main-thread command kicks the driver, and if no turn starts the runner announces the main thread's commands, and only those, through the ports' emitCommandNotifications; a turn that starts is left to announce its own",
    said('subscribeToCommandQueue').length === 1 && beforeTheSession.kicks === 0 && beforeTheSession.announced === 0 && idle.kicks === 1 && idle.announced === 1 && idle.first === 1 && idle.same && started.kicks === 2 && started.announced === 1 && watching.stopSdkDrain === stopDrain && abort.signal.aborted,
    j({ beforeTheSession, idle, started }),
  )
  const frames = madeOf(await ran('bindNotificationFrames', {}))
  check('the announcer keeps one memory of what it has spoken: the boot makes one WeakSet and hands it on as announcedNotifications, beside the three doors that read it', frames.announcedNotifications instanceof WeakSet && typeof frames.emitCommandNotifications === 'function' && typeof frames.emitTaskNotificationFrames === 'function' && typeof frames.retireQueuedCommands === 'function')

  fresh()
  const cleanups: Array<() => Promise<void>> = []
  answers.set('registerCleanup', (fn: unknown) => (cleanups.push(fn as () => Promise<void>), () => {}))
  const order: string[] = []
  const stop = (name: string) => (): void => void order.push(name)
  const cleanupLive = createRunnerState()
  cleanupLive.buildBehindConfirm = setTimeout(() => order.push('the confirm timer fired'), 40)
  const floor = setInterval(() => order.push('the floor timer fired'), 40)
  const cleanup = madeOf(await ran('registerBootCleanup', { buildBehindFloor: floor, driver: { isRunning: () => false, phase: () => 'idle' }, getAppState: () => ({ tasks: {} }), idleNudge: { stop: stop('idleNudge.stop') }, live: cleanupLive, releaseHookRows: stop('releaseHookRows'), stopHostNotices: stop('stopHostNotices'), stopParty: stop('stopParty'), swarmLead: { stop: stop('swarmLead.stop') }, swarmResumes: { stop: stop('swarmResumes.stop') } }))
  const registered = cleanups.length
  await within(cleanups[0]?.() ?? Promise.resolve())
  await pause(150)
  clearInterval(floor)
  check(
    'N6 the nudge stops with the runner: the boot registers one cleanup that clears both build-behind timers, releases the hook rows and stops the idle nudge, the host notices, the party, the swarm lead and the swarm resumes, in that order',
    registered === 1 && j(order) === j(['releaseHookRows', 'idleNudge.stop', 'stopHostNotices', 'stopParty', 'swarmLead.stop', 'swarmResumes.stop']) && typeof cleanup.registerCleanup === 'function',
    j(order),
  )

  fresh()
  answers.set('registerLocalWakeSink', () => undefined)
  const wakeLive = createRunnerState()
  const wakeDriver = { kick: () => {}, isRunning: () => false }
  await ran('armLocalWake', { driver: wakeDriver, live: wakeLive, streamingInput: false })
  const oneShot = said('registerLocalWakeSink').length
  await ran('armLocalWake', { driver: wakeDriver, live: wakeLive, streamingInput: true })
  check("the boot arms the local wake: the step hands its ports to the door's arming, which registers the session's one sink for streaming input and none for a one-shot run", oneShot === 0 && said('registerLocalWakeSink').length === 1 && typeof said('registerLocalWakeSink')[0]?.args[0] === 'function', j(names()))
}

console.log(failures === 0 ? '\nprove-runner-boot-steps: green' : `\nprove-runner-boot-steps: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
