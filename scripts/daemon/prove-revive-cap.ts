#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'revive-cap-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const dir = join(scratch, 'daemon')
const workspace = join(scratch, 'project')
mkdirSync(workspace)
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const sup = await import('../../src/daemon/concourseSupervisor.ts')
const capacity = (n: number) => saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: n } }))
const target = '00000000-0000-4000-8000-000000000003'
function seed(): void {
  sup.updateConcourseWorkers(records => {
    for (const key of Object.keys(records)) delete records[key]
    for (let n = 1; n <= 3; n++) {
      records[`concourse-w${n}`] = {
        schema: 1,
        runnerId: `concourse-w${n}`,
        sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        workspaceId: workspace,
        isolation: 'shared',
        modelKey: 'fixture-model',
        spawnedAt: 1,
        lastLiveAt: 1,
        ...(n < 3 ? { pid: process.pid } : { parkedAt: 2, parkedBy: 'fixture', parkReason: 'parked for the check' }),
      }
    }
  }, dir)
}
let registrations = 0
const roster = {
  kill: () => false,
  has: () => ({ present: false }),
  registerLongLived: () => { registrations++; return { ok: true, pid: process.pid } },
}
let failed = false
function check(name: string, pass: boolean): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  failed ||= !pass
}
try {
  capacity(2)
  seed()
  const full = sup.reviveConcourseWorker(target, 'fixture', roster, undefined, dir)
  check('a direct re-admission refuses at the existing capacity', full.outcome === 'refused')
  check('a full world never calls the spawn implementation', registrations === 0)
  check('capacity refusal retains parked identity and explanation', sup.readSessionWorkers(dir)['concourse-w3']?.parkReason === 'parked for the check')
  capacity(3)
  seed()
  registrations = 0
  const admitted = sup.reviveConcourseWorker(target, 'fixture', roster, undefined, dir)
  check('operator-provided headroom re-admits the same session', admitted.outcome === 'applied' && registrations === 1)
  check('a successful re-admission clears parked state', sup.readSessionWorkers(dir)['concourse-w3']?.parkedAt === undefined)
  const repeated = sup.reviveConcourseWorker(target, 'fixture', roster, undefined, dir)
  check('repeated re-admission never creates another live worker', repeated.outcome === 'noop' && registrations === 1)
  seed()
  let killed = 0
  let rejected = 0
  const occupied = sup.reviveConcourseWorker(target, 'fixture', {
    kill: () => { killed++; return true },
    has: () => ({ present: true, alive: true }),
    registerLongLived: () => { rejected++; return { ok: false, error: 'a live worker already holds this id' } },
  }, undefined, dir)
  check('a stale record cannot turn a registration refusal into a live-process kill', occupied.outcome === 'refused' && killed === 0 && rejected === 1)

  const childModule = await import('../../src/daemon/headlessRun.ts')
  let spawns = 0
  mock.module('../../src/daemon/headlessRun.ts', () => ({
    ...childModule,
    spawnStreamJsonChild: () => {
      spawns++
      const child = Object.assign(new EventEmitter(), {
        pid: process.pid,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => { throw new Error('a capacity check must not kill a live process') },
      })
      return { child }
    },
  }))
  const { TaskRoster } = await import('../../src/daemon/roster.ts')
  const actual = new TaskRoster({ dir: workspace, breaker: {} as never, maxInflight: 99 })
  const handles = (actual as any).handles as Map<string, any>
  const spec = { cwd: workspace, model: 'fixture-model', effort: 'high', role: 'MERCURY_CONCOURSE_WORKER', agentId: 'fixture' } as never
  handles.set('a', { entry: { short: 'a', state: 'running' } })
  handles.set('b', { entry: { short: 'b', state: 'retiring' } })
  capacity(2)
  const atCap = actual.registerLongLived('c', spec)
  check('registration counts retiring processes until observed exit', !atCap.ok && spawns === 0)
  check('registration reports capacity rather than a failed process spawn', !atCap.ok && atCap.error?.includes('cannot start another worker') === true)
  if (atCap.ok) handles.delete('c')
  handles.get('b').entry.state = 'spawning'
  const reserved = actual.registerLongLived('c', spec)
  check('pending respawns reserve capacity against new admissions', !reserved.ok && spawns === 0)
  if (reserved.ok) handles.delete('c')
  capacity(3)
  const room = actual.registerLongLived('c', spec)
  check('the real registration admits when the configured ceiling permits', room.ok)
  const beforeDuplicate = spawns
  check('the real registration rejects duplicate live identities', !actual.registerLongLived('c', spec).ok && spawns === beforeDuplicate)
  capacity(2)
  handles.get('c').entry.outcome = 'killed'
  const beforeRespawn = spawns
  const revivedPid = (actual as any).spawnLongLived('c')
  check('all respawns recheck capacity after another admission or setting change', revivedPid === undefined && spawns === beforeRespawn)
  check('capacity-blocked respawns have an honest settled outcome', handles.get('c').entry.outcome === 'capacity')
  handles.get('b').entry.outcome = 'ok'
  const beforeFreed = spawns
  check('observed exit frees exactly one registration slot', actual.registerLongLived('d', spec).ok && spawns === beforeFreed + 1)

  const { daemonDir } = await import('../../src/daemon/controlSocket.ts')
  const durable = new TaskRoster({ dir: workspace, breaker: {} as never, maxInflight: 99 })
  const durableHandles = (durable as any).handles as Map<string, any>
  capacity(3)
  sup.updateConcourseWorkers(records => {
    records['concourse-w3'] = { ...sup.readSessionWorkers(dir)['concourse-w3']!, parkedAt: undefined, parkReason: undefined, crash: { at: 1, reason: 'earlier crash', respawning: true } }
  })
  check('durable fixture registers its session worker', durable.registerLongLived('concourse-w3', spec).ok)
  await new Promise<void>(resolve => setImmediate(resolve))
  sup.updateConcourseWorkers(records => { delete records['concourse-w3']!.pid; delete records['concourse-w3']!.procStart })
  durableHandles.get('concourse-w3').entry.outcome = 'crashed'
  durableHandles.set('first', { entry: { state: 'running' } })
  durableHandles.set('second', { entry: { state: 'retiring' } })
  capacity(2)
  const refusedSpawn = (durable as any).spawnLongLived('concourse-w3')
  await new Promise<void>(resolve => setImmediate(resolve))
  const held = sup.readSessionWorkers()['concourse-w3']
  check('capacity refusal durably parks the ended worker with its real reason', refusedSpawn === undefined && held?.parkedAt !== undefined && held.parkReason?.includes('cannot resume yet') === true && held.crash === undefined)
  check('capacity refusal writes under the daemon record directory, not its workspace', existsSync(join(daemonDir(), 'concourse-workers.json')) && !existsSync(join(workspace, 'concourse-workers.json')))
  check('capacity refusal never changes an unrelated record directory', sup.readSessionWorkers(dir)['concourse-w3']?.parkReason === 'parked for the check')
  durableHandles.get('second').entry.outcome = 'ok'
  const restored = sup.reviveConcourseWorker(target, 'fixture', durable)
  await new Promise<void>(resolve => setImmediate(resolve))
  const recovered = sup.readSessionWorkers()['concourse-w3']
  check('a freed slot re-admits the same durable transcript without stale failure state', restored.outcome === 'applied' && recovered?.sessionId === target && recovered.parkedAt === undefined && recovered.crash === undefined)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
