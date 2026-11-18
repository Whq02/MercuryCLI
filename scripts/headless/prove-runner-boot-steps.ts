#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes')
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

await spied('src/substrate/recoveryOrchestrator.ts', ['runBootRecovery'])
await spied('src/services/run/runCoordinator.ts', ['getRunSnapshot', 'reconcileOnResume'])
await spied('src/tasks/LocalAgentTask/launchReceipts.ts', ['reconcileBackgroundLaunchesOnResume'])
await spied('src/cli/headless/restartCarry.ts', ['carryRunnerAcrossRestart'])
await spied('src/tasks/LocalAgentTask/pauseCarry.ts', ['carryPausedCrewmatesOnResume'])
await spied('src/tools/MonitorTool/watchReceipts.ts', ['reconcileWatchesOnResume', 'reconcileBackgroundShellsOnResume'])
await spied('src/tasks/taskLaunchLedger.ts', ['reconcileTaskLaunchesOnResume'])
await spied('src/services/switchboard/sessionReceipts.ts', ['appendSessionReceipt'])
await spied('src/utils/messageQueueManager.ts', ['enqueuePendingNotification'])
await spied('src/utils/log.ts', ['logError'])

const { hydrateResumedRun } = await import('../../src/cli/headless/resumeHydration.ts')
const { createRunnerState } = await import('../../src/cli/headless/runnerPorts.ts')
const { coerceRestartReason } = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { composeRestartLine } = await import('../../src/tools/MonitorTool/watchReceipts.ts')
const { wrapInSystemReminder } = await import('../../src/utils/messages/text.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')

type Ports = Parameters<typeof hydrateResumedRun>[0]
type Scene = { ports: Ports; live: Ports['live']; messages: unknown[]; getAppState: () => unknown; setAppState: () => void; canUseTool: () => void; relaunchContext: () => Promise<unknown>; rows: Array<Record<string, unknown>> }

function scene(reason: string | undefined, messages: unknown[] = [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'the first words' } }]): Scene {
  seen.length = 0
  answers.clear()
  answers.set('getRunSnapshot', () => null)
  answers.set('reconcileBackgroundLaunchesOnResume', () => [])
  answers.set('carryPausedCrewmatesOnResume', async () => [])
  answers.set('reconcileTaskLaunchesOnResume', async () => ({ endedPids: [], orphans: ['an-orphan'], settledTaskIds: ['a-settled-task'] }))
  answers.set('reconcileWatchesOnResume', () => [])
  answers.set('reconcileBackgroundShellsOnResume', () => [])
  answers.set('carryRunnerAcrossRestart', async () => ({ recoveredCommandIds: ['recovered-1'], requeued: 1, relaunched: 0, delivered: 0, stopped: 0 }))
  const live = createRunnerState()
  live.runnerRestartReason = reason
  const state = { tasks: { 'task-1': {} } }
  const getAppState = (): unknown => state
  const setAppState = (): void => {}
  const canUseTool = (): void => {}
  const relaunchContext = async (): Promise<unknown> => ({})
  const rows: Array<Record<string, unknown>> = []
  const ports = { live, messages, getAppState, setAppState, relaunchContext, asks: { createCanUseTool: () => canUseTool }, enqueueRow: (row: Record<string, unknown>) => void rows.push(row), liveScope: () => ({ session_id: 'the-session' }) } as unknown as Ports
  return { ports, live, messages, getAppState, setAppState, canUseTool, relaunchContext, rows }
}

const STEPS = ['runBootRecovery', 'getRunSnapshot', 'reconcileOnResume', 'carryRunnerAcrossRestart', 'reconcileBackgroundLaunchesOnResume', 'carryPausedCrewmatesOnResume', 'reconcileTaskLaunchesOnResume', 'reconcileWatchesOnResume', 'reconcileBackgroundShellsOnResume']

section('§1 the one resume closure: its steps, in their order')
{
  const empty = scene('crash', [])
  await within(hydrateResumedRun(empty.ports))
  check('a conversation with no message hydrates nothing', seen.length === 0, j(names()))

  const crashed = scene('crash')
  await within(hydrateResumedRun(crashed.ports))
  check('O1 both calls sit in hydrateResumedRun, the carry first (the order this proof drives them in): boot recovery, the run reconcile, the restart carry, the launch receipts, the paused crewmates, the task launches, the watches, the background shells', j(names().filter(name => STEPS.includes(name))) === j(STEPS), j(names()))
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
  check(
    'boot recovery is scoped to the session, and the watches and the shells are reconciled against the live task ids with the reason and what the launch ledger settled',
    recovery?.scope === 'session' && recovery.sessionId === getSessionId() && j([...(watches[1] as Set<string>)]) === j(['task-1']) && watches[2] === 'crash' && j(watches[3]) === j(['an-orphan']) && j(watches[4]) === j(['a-settled-task']) && shells[0] === crashed.messages && shells[2] === 'crash' && j(said('reconcileTaskLaunchesOnResume')[0]?.args) === j([String(getSessionId()), {}]),
    `${j(recovery)} · ${j(watches.slice(2))}`,
  )
  check('a crash tells the conversation nothing of its own: no receipt, no pending notification, no row', said('appendSessionReceipt').length === 0 && said('enqueuePendingNotification').length === 0 && crashed.rows.length === 0, j(names()))

  const plain = scene(undefined)
  await within(hydrateResumedRun(plain.ports))
  check('a resume the runner was told no reason for carries nothing across and reconciles the launches under no reason', said('carryRunnerAcrossRestart').length === 0 && said('reconcileBackgroundLaunchesOnResume')[0]?.args[4] === coerceRestartReason(undefined) && j(plain.live.recoveredCommandIds) === j([]) && j(names().filter(name => STEPS.includes(name))) === j(STEPS.filter(name => name !== 'carryRunnerAcrossRestart')), j(names()))

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
  check('a step that throws is logged and does not end the resume: every later step still runs', settled === 'settled' && said('logError').length === 2 && said('logError')[0]?.args[0] === lost && j(names().filter(name => STEPS.includes(name))) === j(STEPS) && j(broken.live.recoveredCommandIds) === j([]), `${String(settled)} · ${j(names())}`)

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

console.log(failures === 0 ? '\nprove-runner-boot-steps: green' : `\nprove-runner-boot-steps: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
