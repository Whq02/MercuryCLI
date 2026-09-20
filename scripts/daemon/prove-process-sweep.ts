#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const owner = join(import.meta.dir, '../../src/daemon/processSweep.ts')
assert.ok(existsSync(owner), 'Mercury has one process classifier, not a parent-pid sweep')
const { classifyMercuryProcess, sameSweepIdentity, processSweepCounts, processSweepLine }: typeof import('../../src/daemon/processSweep.ts') = await import(owner)
import type { ProcessSweepFacts, ProcessSweepRead } from '../../src/daemon/processSweep.ts'

let checks = 0
const check = (label: string, run: () => void): void => {
  run()
  checks++
  console.log(`[PASS] ${label}`)
}
const reads = (): ProcessSweepFacts['liveness'] => ({ terminal: false, registration: false, owner: false, session: false, work: false, schedules: false, persistence: false })
const facts = (kind: ProcessSweepFacts['kind'] = 'window'): ProcessSweepFacts => ({
  process: { pid: 401, ppid: 1, exe: '/opt/mercury/vendor/node/bin/node', args: ['/opt/mercury/mercury.mjs'], startedAtMs: 1_000, user: '1000', terminal: 'pts/3' },
  platform: 'linux',
  kind,
  startToken: 'process-birth-401',
  registrationId: 'registered-401',
  ownership: true,
  sameUser: true,
  sameHome: true,
  self: false,
  state: 'S',
  liveness: reads(),
  closed: kind === 'window' ? 'terminal-gone' : kind === 'runner' ? 'session-ended' : kind === 'daemon' ? 'owner-gone' : null,
  graceElapsed: true,
})
const classify = (f: ProcessSweepFacts): string => classifyMercuryProcess(f).classification

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  for (const kind of ['window', 'daemon', 'runner'] as const) {
    check(`${platform}: the ${kind}'s own closure and all negative liveness reads identify stale`, () => {
      const f = facts(kind)
      f.platform = platform
      if (platform === 'win32') f.process.terminal = 'session:2;console:none'
      assert.equal(classify(f), 'stale')
    })
    for (const signal of Object.keys(reads()) as Array<keyof ProcessSweepFacts['liveness']>) {
      check(`${platform}: a live ${signal} protects the ${kind}, even beside every other failed read`, () => {
        const f = facts(kind)
        f.platform = platform
        f.liveness[signal] = true
        assert.equal(classify(f), 'running')
      })
      check(`${platform}: an unknown ${signal} never becomes evidence to end the ${kind}`, () => {
        const f = facts(kind)
        f.platform = platform
        f.liveness[signal] = null
        assert.equal(classify(f), 'cannot-end')
      })
    }
  }
}
for (const name of Object.keys(reads()) as Array<keyof ProcessSweepFacts['liveness']>) {
  check(`an omitted ${name} read is unknown, not negative evidence`, () => {
    const f = facts()
    delete (f.liveness as Partial<ProcessSweepFacts['liveness']>)[name]
    assert.equal(classify(f), 'cannot-end')
  })
  check(`an undefined ${name} read is unknown, not negative evidence`, () => {
    const f = facts()
    ;(f.liveness as Record<string, unknown>)[name] = undefined
    assert.equal(classify(f), 'cannot-end')
  })
  check(`a non-enumerable live ${name} read still protects the process`, () => {
    const f = facts()
    Object.defineProperty(f.liveness, name, { value: true, enumerable: false })
    assert.equal(classify(f), 'running')
  })
  check(`an unreadable ${name} never admits a stale verdict`, () => {
    const f = facts()
    Object.defineProperty(f.liveness, name, { get() { throw new Error('unreadable') } })
    assert.equal(classify(f), 'cannot-end')
  })
}
check('empty and whitespace-only cockpit registrations prove no identity', () => {
  for (const id of ['', '   ']) {
    const f = facts()
    f.registrationId = id
    const result = classifyMercuryProcess(f)
    assert.equal(result.classification, 'cannot-end')
    assert.equal(sameSweepIdentity(result, result), false)
  }
})
check('a failed liveness read never hides another positive read', () => {
  const f = facts()
  Object.defineProperty(f.liveness, 'owner', { get() { throw new Error('unreadable') } })
  f.liveness.session = true
  assert.equal(classify(f), 'running')
})
check('unknown self-identity cannot authorize an ending', () => {
  for (const value of [undefined, null, '', 'false', 0, 1]) {
    const f = facts()
    ;(f as unknown as Record<string, unknown>).self = value
    assert.equal(classify(f), 'cannot-end')
  }
})
check('a blank birth token never establishes signal identity', () => {
  for (const token of ['', '  ', '\t']) {
    const f = facts()
    f.startToken = token
    const result = classifyMercuryProcess(f)
    assert.equal(result.classification, 'cannot-end')
    assert.equal(sameSweepIdentity(result, result), false)
  }
})
check('only explicit elapsed grace admits ending', () => {
  for (const value of [undefined, null, 'false', 'true', 1]) {
    const f = facts('daemon')
    ;(f as unknown as Record<string, unknown>).graceElapsed = value
    assert.equal(classify(f), 'cannot-end')
  }
  const f = facts('daemon')
  f.graceElapsed = false
  assert.equal(classify(f), 'running')
})
check('an invalid process identity cannot appear endable or compare signal-safe', () => {
  for (const patch of [{ user: '' }, { user: '  ' }, { exe: '  ' }, { startedAtMs: Infinity }, { startedAtMs: NaN }, { startedAtMs: -1 }]) {
    const f = facts()
    Object.assign(f.process, patch)
    const result = classifyMercuryProcess(f)
    assert.equal(result.classification, 'cannot-end')
    assert.equal(sameSweepIdentity(result, result), false)
  }
})
check('kind and platform changes invalidate reviewed identity', () => {
  const a = classifyMercuryProcess(facts())
  const b = structuredClone(a)
  b.kind = 'daemon'
  assert.equal(sameSweepIdentity(a, b), false)
  b.kind = a.kind
  b.platform = 'darwin'
  assert.equal(sameSweepIdentity(a, b), false)
})
check('tmux, screen and reparented terminal windows remain running', () => {
  for (const parent of [0, 1, 123, 999]) {
    const f = facts()
    f.process.ppid = parent
    f.liveness.terminal = true
    assert.equal(classify(f), 'running')
  }
})
check('a parent pid alone never makes a Mercury stale', () => {
  for (const parent of [0, 1, 123]) {
    const f = facts()
    f.process.ppid = parent
    f.closed = null
    assert.equal(classify(f), 'cannot-end')
  }
})
check('a window without its own registration is not safe to end', () => {
  const f = facts()
  f.registrationId = null
  assert.equal(classify(f), 'cannot-end')
})
check('another user is not ours even if a forged closure names the pid', () => {
  const f = facts()
  f.sameUser = false
  assert.equal(classify(f), 'not-ours')
})
check('a different config home is left running, never selected by this home', () => {
  const f = facts()
  f.sameHome = false
  assert.equal(classify(f), 'running')
})
check('an unproved home cannot become a stale home', () => {
  const f = facts()
  f.sameHome = null
  assert.equal(classify(f), 'cannot-end')
})
check('a title resembling Mercury never proves executable ownership', () => {
  const f = facts()
  f.process.args = ['mercury']
  f.ownership = null
  assert.equal(classify(f), 'cannot-end')
  f.ownership = false
  assert.equal(classify(f), 'not-ours')
})
check('an unreadable owner identity does not end an owned daemon', () => {
  const f = facts('daemon')
  f.liveness.owner = null
  assert.equal(classify(f), 'cannot-end')
})
check('a booting or draining daemon is protected until the whole allowance elapses', () => {
  for (const grace of [false, null] as ProcessSweepRead[]) {
    const f = facts('daemon')
    f.graceElapsed = grace
    assert.notEqual(classify(f), 'stale')
  }
})
check('explicit and persistent daemons are running, including those with no sessions', () => {
  const f = facts('daemon')
  f.closed = null
  f.liveness.persistence = true
  assert.equal(classify(f), 'running')
})
check('warm runners and a runner with a live seat cannot be selected', () => {
  const f = facts('runner')
  f.liveness.session = true
  assert.equal(classify(f), 'running')
  f.liveness.session = false
  f.liveness.work = true
  assert.equal(classify(f), 'running')
})
check('a stopped, parked or ended record does not override live session work', () => {
  const f = facts('runner')
  f.liveness.work = true
  assert.equal(classify(f), 'running')
})
check('a closure belonging to another kind is never admitted', () => {
  const f = facts('daemon')
  f.closed = 'terminal-gone'
  assert.equal(classify(f), 'cannot-end')
})
check('an absent process birth identity never authorizes an ending', () => {
  const f = facts('runner')
  f.startToken = null
  assert.equal(classify(f), 'cannot-end')
})
check('the sweeping process protects itself', () => {
  const f = facts()
  f.self = true
  assert.equal(classify(f), 'running')
})
check('a kernel wait does not override a live terminal or session', () => {
  for (const state of ['U', 'D']) {
    const f = facts()
    f.state = state
    f.liveness.terminal = true
    assert.equal(classify(f), 'running')
  }
})
check('the identity comparison rejects pid reuse and executable or registration changes', () => {
  const a = classifyMercuryProcess(facts())
  assert.equal(sameSweepIdentity(a, structuredClone(a)), true)
  for (const field of ['pid', 'exe', 'startedAtMs', 'user'] as const) {
    const b = structuredClone(a)
    ;(b.process as Record<string, unknown>)[field] = typeof b.process[field] === 'number' ? Number(b.process[field]) + 1 : `${b.process[field]}-changed`
    assert.equal(sameSweepIdentity(a, b), false)
  }
  for (const field of ['startToken', 'registrationId'] as const) {
    const b = structuredClone(a)
    b[field] = 'changed'
    assert.equal(sameSweepIdentity(a, b), false)
  }
})
check('unidentified rows do not compare as a signal-safe identity', () => {
  const f = facts()
  f.startToken = null
  const a = classifyMercuryProcess(f)
  assert.equal(sameSweepIdentity(a, a), false)
})
check('a revived target no longer belongs to the reviewed stale list', () => {
  const before = classifyMercuryProcess(facts('runner'))
  const f = facts('runner')
  f.liveness.session = true
  const after = classifyMercuryProcess(f)
  assert.equal(sameSweepIdentity(before, after), true)
  assert.equal(after.classification, 'running')
})
check('counts and lines preserve all four classes and the actual pid and terminal', () => {
  const all = [facts(), facts(), facts(), facts()].map((f, i) => {
    if (i === 1) f.liveness.terminal = true
    if (i === 2) f.liveness.registration = null
    if (i === 3) f.sameUser = false
    return classifyMercuryProcess(f)
  })
  assert.deepEqual(processSweepCounts(all), { running: 1, stale: 1, 'cannot-end': 1, 'not-ours': 1 })
  const line = processSweepLine(all[0]!, 61_000)
  assert.match(line, /pid 401/)
  assert.match(line, /pts\/3/)
  assert.match(line, /1m/)
})
console.log(`process sweep: ${checks} checks passed`)
