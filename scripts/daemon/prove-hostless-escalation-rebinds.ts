#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'hostless-escalation-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const STAND_IN_PID = 2_147_000_001
const BORN = 'Tue Nov 10 11:59:11 2026'
const ANOTHER_BIRTH = 'Tue Nov 10 11:59:12 2026'
type AfterTerm = 'the same process, still alive' | 'another process under the same pid' | 'a pid whose birth cannot be read' | 'gone'
let afterTerm: AfterTerm = 'gone'
let birth: string | null = BORN
let alive = true
let probes: Array<string | null> = []
let signals: Array<{ signal: string; birth: string | null }> = []

const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
mock.module('../../src/daemon/ownerWatch.ts', () => ({
  ...ownerWatch,
  isProcessAlive: (pid: number) => (pid === STAND_IN_PID ? alive : ownerWatch.isProcessAlive(pid)),
  getProcessStartTokenAsync: async (pid: number, like?: string | null) => {
    if (pid !== STAND_IN_PID) return ownerWatch.getProcessStartTokenAsync(pid, like)
    probes.push(birth)
    return birth
  },
}))
const processGroup = await import('../../src/utils/processGroup.ts')
mock.module('../../src/utils/processGroup.ts', () => ({
  ...processGroup,
  endProcessTree: async (pid: number, signal: string) => {
    if (pid !== STAND_IN_PID) throw new Error(`this proof signals no real process, and was asked to end ${pid}`)
    signals.push({ signal, birth })
    if (signal === 'SIGTERM') {
      if (afterTerm === 'gone') alive = false
      if (afterTerm === 'another process under the same pid') birth = ANOTHER_BIRTH
      if (afterTerm === 'a pid whose birth cannot be read') birth = null
    }
    if (signal === 'SIGKILL') alive = false
    return { ended: alive ? 0 : 1, survivors: alive ? [pid] : [] }
  },
}))
const sup = await import('../../src/daemon/concourseWorkers.ts')
const dir = process.env.MERCURY_DAEMON_DIR!
const now = Date.now()

async function sweepWhen(scene: AfterTerm, n: number): Promise<{ ended: string[]; signals: string[]; struck: Array<string | null>; probes: number }> {
  afterTerm = scene
  birth = BORN
  alive = true
  probes = []
  signals = []
  const runnerId = `concourse-w${n}`
  sup.updateConcourseWorkers(workers => {
    for (const id of Object.keys(workers)) delete workers[id]
    workers[runnerId] = {
      schema: 1,
      runnerId,
      sessionId: `00000000-dddd-4000-8000-${String(n).padStart(12, '0')}`,
      workspaceId: SCRATCH,
      isolation: 'exclusive',
      modelKey: 'claude-sonnet-5',
      spawnedAt: now - 60_000,
      lastLiveAt: now - 1_000,
      pid: STAND_IN_PID,
      procStart: BORN,
    } as ConcourseWorkerRecordV1
  }, dir)
  const ended = await sup.endRunnersLeftWithoutHost(() => false, dir, { graceMs: 0 })
  return { ended: ended.map(e => e.runnerId), signals: signals.map(s => s.signal), struck: signals.map(s => s.birth), probes: probes.length }
}

console.log('E1 the runner left without a host is asked to leave only as the process its record names, and is struck again only while it is still that process')
{
  const left = await sweepWhen('gone', 1)
  check('it leaves at the first ask: one signal, and it is listed as ended', j(left.signals) === j(['SIGTERM']) && j(left.ended) === j(['concourse-w1']), j(left))
  const stubborn = await sweepWhen('the same process, still alive', 2)
  check('still the same process after the grace: its birth is read again, then it is killed and listed', j(stubborn.signals) === j(['SIGTERM', 'SIGKILL']) && stubborn.probes === 2 && j(stubborn.struck) === j([BORN, BORN]) && j(stubborn.ended) === j(['concourse-w2']), j(stubborn))
}

console.log('E2 a pid that is no longer that process after the grace is never struck')
{
  const recycled = await sweepWhen('another process under the same pid', 3)
  check('the pid went to another process while the runner left: no second signal reaches it (red before: SIGKILL went to the process born later)', j(recycled.signals) === j(['SIGTERM']) && recycled.probes === 2, j(recycled))
  check('…and the runner, which is gone, is listed as ended', j(recycled.ended) === j(['concourse-w3']), j(recycled))
  const unreadable = await sweepWhen('a pid whose birth cannot be read', 4)
  check('a birth that cannot be read is not proof: no second signal, and the runner is not claimed ended', j(unreadable.signals) === j(['SIGTERM']) && unreadable.probes === 2 && unreadable.ended.length === 0, j(unreadable))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hostless-escalation-rebinds: ALL LAWS HOLD' : `\nprove-hostless-escalation-rebinds: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
