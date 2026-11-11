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
const MEMBER_PID = 2_147_000_002
const BORN = 'Tue Nov 10 11:59:11 2026'
const ANOTHER_BIRTH = 'Tue Nov 10 11:59:12 2026'
const instant = (ms: number): string => new Date(ms).toISOString()
type AfterTerm = 'the same process, still alive' | 'another process under the same pid' | 'a pid whose birth cannot be read' | 'gone'
type Member =
  | 'none'
  | 'outlives the ask'
  | 'leaves at the ask'
  | 'its pid goes to another process after the ask'
  | 'its birth cannot be read after the grace'
  | 'its pid went to another process born in the second of the listing'
  | 'the runner is replaced while its tree is read'
  | 'the runner cannot be read after its tree is read'
  | 'this process stands in its tree'
let afterTerm: AfterTerm = 'gone'
let birth: string | null = BORN
let alive = true
let probes: Array<string | null> = []
let signals: Array<{ signal: string; birth: string | null; pid: number }> = []
let member: Member = 'none'
let memberAlive = false
let listedBirth = ''
let memberBirth: string | null = null
let memberProbes = 0
let memberProbesAtAsk = -1

const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
const real = { isProcessAlive: ownerWatch.isProcessAlive, getProcessStartTokenAsync: ownerWatch.getProcessStartTokenAsync }
mock.module('../../src/daemon/ownerWatch.ts', () => ({
  ...ownerWatch,
  isProcessAlive: (pid: number) => (pid === STAND_IN_PID ? alive : pid === MEMBER_PID ? memberAlive : real.isProcessAlive(pid)),
  getProcessStartTokenAsync: async (pid: number, like?: string | null) => {
    if (pid !== STAND_IN_PID) return real.getProcessStartTokenAsync(pid, like)
    probes.push(birth)
    return birth
  },
}))
let treeListings: number[] = []
mock.module('../../src/daemon/processTree.ts', () => ({
  readProcessTreeUnder: async (pid: number) => {
    treeListings.push(pid)
    if (member === 'this process stands in its tree') return null
    if (member === 'the runner is replaced while its tree is read') birth = ANOTHER_BIRTH
    if (member === 'the runner cannot be read after its tree is read') birth = null
    return member !== 'none' ? [{ pid: MEMBER_PID, birth: listedBirth }] : []
  },
  readProcessBirth: async (pid: number) => {
    if (pid !== MEMBER_PID) throw new Error(`this proof reads the birth of no real process, and was asked for ${pid}`)
    memberProbes++
    return memberBirth
  },
}))
const processGroup = await import('../../src/utils/processGroup.ts')
mock.module('../../src/utils/processGroup.ts', () => ({
  ...processGroup,
  endProcessTree: async (pid: number, signal: string) => {
    if (pid !== STAND_IN_PID && pid !== MEMBER_PID && pid !== process.pid) throw new Error(`this proof signals no real process, and was asked to end ${pid}`)
    if (signals.length === 0) memberProbesAtAsk = memberProbes
    signals.push({ signal, birth: pid === STAND_IN_PID ? birth : pid === MEMBER_PID ? memberBirth : null, pid })
    if (pid === process.pid) return { ended: 0, survivors: [] }
    if (pid === MEMBER_PID) {
      memberAlive = false
      return { ended: 1, survivors: [] }
    }
    if (signal === 'SIGTERM') {
      if (afterTerm === 'gone') alive = false
      if (afterTerm === 'another process under the same pid') birth = ANOTHER_BIRTH
      if (afterTerm === 'a pid whose birth cannot be read') birth = null
      if (member === 'leaves at the ask') memberAlive = false
      if (member === 'its pid goes to another process after the ask') memberBirth = instant(Date.now() - 30_000)
      if (member === 'its birth cannot be read after the grace') memberBirth = null
    }
    if (signal === 'SIGKILL') alive = false
    return { ended: alive ? 0 : 1, survivors: [...(alive ? [pid] : []), ...(memberAlive ? [MEMBER_PID] : [])] }
  },
}))
const sup = await import('../../src/daemon/concourseWorkers.ts')
const dir = process.env.MERCURY_DAEMON_DIR!
const now = Date.now()

type Swept = { ended: string[]; signals: string[]; struck: Array<string | null>; probes: number; toMember: string[]; memberProbes: number; memberProbesAtAsk: number; memberAlive: boolean }
async function sweepWhen(scene: AfterTerm, n: number, tree: Member = 'none'): Promise<Swept> {
  afterTerm = scene
  birth = BORN
  alive = true
  probes = []
  signals = []
  member = tree
  memberAlive = tree !== 'none'
  listedBirth = instant(Date.now() - 120_000)
  memberBirth = tree === 'none' ? null : tree === 'its pid went to another process born in the second of the listing' ? instant(Math.floor(Date.now() / 1000) * 1000) : listedBirth
  memberProbes = 0
  memberProbesAtAsk = -1
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
  const toRunner = signals.filter(s => s.pid === STAND_IN_PID)
  return { ended: ended.map(e => e.runnerId), signals: toRunner.map(s => s.signal), struck: toRunner.map(s => s.birth), probes: probes.length, toMember: signals.filter(s => s.pid === MEMBER_PID).map(s => s.signal), memberProbes, memberProbesAtAsk, memberAlive }
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

console.log("E3 what outlives the ask in the runner's tree is ended after the grace")
{
  const orphan = await sweepWhen('gone', 5, 'outlives the ask')
  check('the runner leaves at the ask and a process under it does not: after the grace that process is killed (red before: left running, the runner listed as ended)', j(orphan.signals) === j(['SIGTERM']) && j(orphan.toMember) === j(['SIGKILL']) && !orphan.memberAlive && j(orphan.ended) === j(['concourse-w5']), j(orphan))
  const both = await sweepWhen('the same process, still alive', 6, 'outlives the ask')
  check('the runner and a process under it both outlive the ask: each is killed', j(both.signals) === j(['SIGTERM', 'SIGKILL']) && j(both.toMember) === j(['SIGKILL']) && !both.memberAlive && j(both.ended) === j(['concourse-w6']), j(both))
  const left = await sweepWhen('gone', 7, 'leaves at the ask')
  check('one that leaves at the ask is sent nothing more', left.toMember.length === 0 && !left.memberAlive && j(left.ended) === j(['concourse-w7']), j(left))
}

console.log('E4 a process under the runner is struck only as the process the listing read: its birth comes with the listing, in the same read, and is read once more before the kill')
{
  const bound = await sweepWhen('gone', 8, 'outlives the ask')
  check('nothing reads its birth between the listing and the ask (red before: a second read after the listing, to the second, said who it was)', bound.memberProbesAtAsk === 0, j(bound))
  check('the one that is killed was read once more, before the kill, and was the process the listing read', bound.memberProbes === 1 && j(bound.toMember) === j(['SIGKILL']), j(bound))
  const recycled = await sweepWhen('gone', 9, 'its pid goes to another process after the ask')
  check('its pid went to another process after the ask: not struck', recycled.toMember.length === 0 && recycled.memberAlive, j(recycled))
  const lost = await sweepWhen('gone', 10, 'its birth cannot be read after the grace')
  check('its birth cannot be read after the grace: not struck', lost.toMember.length === 0 && lost.memberAlive, j(lost))
  const handed = await sweepWhen('gone', 11, 'its pid went to another process born in the second of the listing')
  check("its pid went to another process born in the listing's own second: the birth the listing read is not that one, and it is not struck (red before: read after the listing, such a birth passed for the listed process's)", handed.toMember.length === 0 && handed.memberAlive && handed.memberProbes === 1, j(handed))
  check('the runner is listed as ended in all three: its own process is gone', j([recycled.ended, lost.ended, handed.ended]) === j([['concourse-w9'], ['concourse-w10'], ['concourse-w11']]))
}

console.log('E6 the runner is bound after its tree has been read and before the ask: a pid that changed hands while the tree was read is not asked to leave')
{
  const replaced = await sweepWhen('the same process, still alive', 13, 'the runner is replaced while its tree is read')
  check('the pid went to another process while the tree was read: no signal at all, to it or to what stood under it', replaced.signals.length === 0 && replaced.toMember.length === 0 && replaced.probes === 1 && replaced.memberAlive && replaced.ended.length === 0, j(replaced))
  const unreadable = await sweepWhen('the same process, still alive', 14, 'the runner cannot be read after its tree is read')
  check('its birth cannot be read before the ask: no signal at all, nothing claimed', unreadable.signals.length === 0 && unreadable.toMember.length === 0 && unreadable.probes === 1 && unreadable.memberAlive && unreadable.ended.length === 0, j(unreadable))
  const steady = await sweepWhen('gone', 15, 'outlives the ask')
  check('a runner that is still itself is read once before the ask, whatever stands under it: the listing is one read and nothing follows it but that look', steady.probes === 1 && (await sweepWhen('gone', 16)).probes === 1, j(steady))
}

console.log("E7 a runner in whose tree or group this process stands is not this process's to end")
{
  const above = await sweepWhen('the same process, still alive', 17, 'this process stands in its tree').catch(error => ({ threw: String(error) }))
  check('the listing says so, and then no birth is read, no signal goes to the runner or to what stands under it, and it is not claimed as ended', !('threw' in above) && above.probes === 0 && above.signals.length === 0 && above.toMember.length === 0 && above.memberAlive && above.ended.length === 0, j(above))
}

console.log('E5 a record that names this process or pid 1 is no runner to end: its tree is never listed and nothing is signalled')
{
  const ownBirth = await real.getProcessStartTokenAsync(process.pid)
  for (const [pid, procStart] of [[process.pid, ownBirth ?? BORN], [1, BORN], [0, BORN]] as Array<[number, string]>) {
    member = 'outlives the ask'
    memberAlive = true
    listedBirth = instant(Date.now() - 120_000)
    memberBirth = listedBirth
    memberProbes = 0
    signals = []
    treeListings = []
    sup.updateConcourseWorkers(workers => {
      for (const id of Object.keys(workers)) delete workers[id]
      workers['concourse-w20'] = { schema: 1, runnerId: 'concourse-w20', sessionId: '00000000-dddd-4000-8000-000000000020', workspaceId: SCRATCH, isolation: 'exclusive', modelKey: 'claude-sonnet-5', spawnedAt: now - 60_000, lastLiveAt: now - 1_000, pid, procStart } as ConcourseWorkerRecordV1
    }, dir)
    const ended = await sup.endRunnersLeftWithoutHost(() => false, dir, { graceMs: 0 })
    check(`a record whose pid is ${pid === process.pid ? 'this process' : pid}: no listing, no probe of what stands under it, no signal, nothing claimed (red before for this process: its own child was killed)`, treeListings.length === 0 && memberProbes === 0 && signals.length === 0 && memberAlive && ended.length === 0, j({ treeListings, memberProbes, signals, ended }))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-hostless-escalation-rebinds: ALL LAWS HOLD' : `\nprove-hostless-escalation-rebinds: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
