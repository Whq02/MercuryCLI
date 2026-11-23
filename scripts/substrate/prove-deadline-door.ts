#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const DRIVER = `
import { pathToFileURL } from 'node:url'
const [door, mode] = process.argv.slice(2)
const { withDeadline, pollUntil, armInactivityDeadline } = await import(pathToFileURL(door).href)
const never = () => new Promise(() => {})
if (mode === 'loose') {
  void withDeadline(never(), 60_000, () => 'late', { unref: true })
  void pollUntil(() => undefined, 30_000, 60_000, () => 'late', { unref: true })
} else if (mode === 'held') {
  void withDeadline(never(), 60_000, () => 'late')
} else {
  const timers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
  const since = t0 => Math.round(performance.now() - t0)
  const settle = async promise => {
    try {
      return { value: await promise }
    } catch (error) {
      return { error: error?.name, message: error?.message, cause: error?.cause?.message }
    }
  }
  const out = { base: timers() }
  {
    let during = -1
    const work = new Promise(done => setImmediate(() => { during = timers(); done(7) }))
    const t0 = performance.now()
    const got = await settle(withDeadline(work, 60_000, () => 'late'))
    out.workWins = { got, during: during - out.base, after: timers() - out.base, ms: since(t0) }
  }
  {
    const work = new Promise((_, fail) => setImmediate(() => fail(Object.assign(new Error('the work failed'), { name: 'WorkError' }))))
    const got = await settle(withDeadline(work, 60_000, () => 'late'))
    out.workFails = { got, after: timers() - out.base }
  }
  {
    const t0 = performance.now()
    const got = await settle(withDeadline(never(), 150, () => 'fallback'))
    out.limitValue = { got, ms: since(t0), after: timers() - out.base }
  }
  {
    const t0 = performance.now()
    const got = await settle(withDeadline(never(), 150, () => { throw Object.assign(new Error('the work exceeded its 150ms deadline'), { name: 'SiteError' }) }))
    out.limitError = { got, ms: since(t0), after: timers() - out.base }
  }
  {
    let fail
    const work = new Promise((_, rejecter) => { fail = rejecter })
    const got = await settle(withDeadline(work, 50, () => 'fallback'))
    fail(new Error('a rejection after the limit'))
    await new Promise(turn => setImmediate(turn))
    out.lateWork = { got, after: timers() - out.base }
  }
  {
    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('the user pressed Esc')), 40)
    const t0 = performance.now()
    const got = await settle(withDeadline(never(), 60_000, () => 'late', { signal: ac.signal }))
    out.abortRejects = { got, ms: since(t0), after: timers() - out.base }
  }
  {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const t0 = performance.now()
    const got = await settle(withDeadline(never(), 60_000, () => 'late', { signal: ac.signal, onAbort: () => 'stopped' }))
    out.abortValue = { got, ms: since(t0), after: timers() - out.base }
  }
  {
    const ac = new AbortController()
    ac.abort()
    const t0 = performance.now()
    const got = await settle(withDeadline(never(), 60_000, () => 'late', { signal: ac.signal }))
    out.abortedBefore = { got, ms: since(t0), after: timers() - out.base }
  }
  {
    let during = -1
    const work = new Promise(done => setImmediate(() => { during = timers(); done('worked') }))
    const got = await settle(withDeadline(work, Infinity, () => 'late'))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const t0 = performance.now()
    const stopped = await settle(withDeadline(never(), Infinity, () => 'late', { signal: ac.signal }))
    out.noLimit = { got, during: during - out.base, stopped, ms: since(t0), after: timers() - out.base }
  }
  {
    const deadline = armInactivityDeadline({ seam: 'a planted read', limitMs: 120 })
    const first = await settle(deadline.within(new Promise(done => setImmediate(() => done('chunk')))))
    deadline.touch()
    const t0 = performance.now()
    const hold = setTimeout(() => {}, 10_000)
    const second = await settle(deadline.within(never()))
    clearTimeout(hold)
    deadline.cancel()
    out.within = { got: { value: first.value, error: second.error, message: second.message }, ms: since(t0), after: timers() - out.base }
  }
  {
    let looks = 0
    const t0 = performance.now()
    const got = await settle(pollUntil(() => (++looks === 3 ? 'found' : undefined), 30, 60_000, () => 'late'))
    out.pollFound = { got, looks, ms: since(t0), after: timers() - out.base }
  }
  {
    let looks = 0
    const t0 = performance.now()
    const got = await settle(pollUntil(() => { looks++; return undefined }, 300, 350, () => 'fallback'))
    out.pollLimit = { got, looks, ms: since(t0), after: timers() - out.base }
  }
  {
    let looks = 0
    const t0 = performance.now()
    const got = await settle(pollUntil(() => { looks++; return undefined }, left => Math.min(300, left), 350, () => 'fallback'))
    out.pollCut = { got, looks, ms: since(t0), after: timers() - out.base }
  }
  {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const t0 = performance.now()
    const got = await settle(pollUntil(() => undefined, 10_000, Infinity, () => 'late', { signal: ac.signal }))
    out.pollAbort = { got, ms: since(t0), after: timers() - out.base }
  }
  console.log(JSON.stringify(out))
}
`

console.log('============================================================')
console.log(' The deadline door: withDeadline and pollUntil in src/platform/async/deadline.ts')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'deadline-door-'))
try {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, '../../src/platform/async/deadline.ts')], target: 'node', format: 'esm', outdir: join(scratch, 'built') })
  check('deadline.ts and the modules it imports build for Node', built.success && built.outputs.length === 1, built.logs.map(String).join(' | ') + ' — fix the import or syntax error the build log names, in src/platform/async/deadline.ts or a module it imports')
  const door = built.outputs[0]?.path ?? ''
  const driver = join(scratch, 'driver.mjs')
  writeFileSync(driver, DRIVER)
  const node = nodeBinPath()
  const ran = spawnSync(node, [driver, door, 'waits'], { encoding: 'utf8', timeout: 60_000 })
  const line = (ran.stdout ?? '').trim().split('\n').at(-1) ?? ''
  type Got = { value?: unknown; error?: string; message?: string; cause?: string }
  type Row = { got: Got; ms: number; after: number; during: number; looks: number }
  let out: Record<string, Row> = {}
  try {
    out = JSON.parse(line) as Record<string, Row>
  } catch {
    check('the waits ran under Node and printed their readings', false, `status ${ran.status ?? ran.signal}: ${(ran.stderr ?? '').trim().slice(-400)} — the driver under Node threw before printing its JSON; read the stderr above and fix withDeadline, pollUntil or armInactivityDeadline in src/platform/async/deadline.ts`)
  }
  const row = (name: string): Row => out[name] ?? ({ got: {}, ms: -1, after: -1, during: -1, looks: -1 } as Row)
  const doorFixes: Record<string, string> = {
    workWins: 'withDeadline in src/platform/async/deadline.ts must resolve with the work value and clear its own timer when the work settles first',
    workFails: 'withDeadline in src/platform/async/deadline.ts must reject with the work failure and clear its timer',
    limitValue: 'withDeadline in src/platform/async/deadline.ts must settle with the caller fallback at the limit and clear its timer',
    limitError: 'withDeadline in src/platform/async/deadline.ts must reject with the error its fallback throws at the limit and clear its timer',
    lateWork: 'withDeadline in src/platform/async/deadline.ts must swallow a rejection of the work that arrives after the limit and leave no timer',
    abortRejects: 'withDeadline in src/platform/async/deadline.ts must reject with an AbortError carrying the signal reason on abort and clear its timer',
    abortValue: 'withDeadline in src/platform/async/deadline.ts must settle with the onAbort value on abort and clear its timer',
    abortedBefore: 'withDeadline in src/platform/async/deadline.ts must reject with an AbortError at once for a signal already aborted',
    noLimit: 'withDeadline in src/platform/async/deadline.ts must arm no timer for an Infinity limit and still honour an abort',
    within: 'the within method of armInactivityDeadline in src/platform/async/deadline.ts must pass a work that settles in time and reject with DeadlineExceededError after the silence',
    pollFound: 'pollUntil in src/platform/async/deadline.ts must end on the look that returns a value, after one period per pause, and clear its timer',
    pollLimit: 'pollUntil in src/platform/async/deadline.ts must make its last look at the first pause that reaches the limit, then settle with the fallback',
    pollCut: 'pollUntil in src/platform/async/deadline.ts must let a period function cut the last pause to the time left, so the last look lands at the limit',
    pollAbort: 'pollUntil in src/platform/async/deadline.ts must reject with an AbortError at once on abort and clear its timer',
  }
  const said = (name: string): string => `${JSON.stringify(out[name] ?? null)} — ${doorFixes[name] ?? ''}`

  section('withDeadline: the work wins, and no timer of the wait is left behind')
  check('the work that settles first gives its value, and while it ran the wait held one timer of its own', row('workWins').got.value === 7 && row('workWins').during === 1, said('workWins'))
  check('the moment the work settles, the active timers are what they were before the wait (process.getActiveResourcesInfo)', row('workWins').after === 0, said('workWins'))
  check('a work that fails first rejects with its own failure, and leaves no timer', row('workFails').got.error === 'WorkError' && row('workFails').after === 0, said('workFails'))

  section("withDeadline: the limit wins, and the caller's outcome arrives at the limit")
  check('at the limit the wait settles with the value the caller gives (150 ms limit, the work never settles)', row('limitValue').got.value === 'fallback' && row('limitValue').ms >= 149 && row('limitValue').ms < 1150 && row('limitValue').after === 0, said('limitValue'))
  check("at the limit the wait rejects with the caller's own error and words", row('limitError').got.error === 'SiteError' && row('limitError').got.message === 'the work exceeded its 150ms deadline' && row('limitError').ms >= 149 && row('limitError').ms < 1150 && row('limitError').after === 0, said('limitError'))
  check('a work that fails after the limit changes nothing and is not an unhandled rejection', row('lateWork').got.value === 'fallback' && row('lateWork').after === 0, said('lateWork'))

  section('withDeadline: an abort ends the wait at once')
  check('an abort 40 ms into a 60 s wait rejects with an AbortError that carries the reason, and clears the timer', row('abortRejects').got.error === 'AbortError' && row('abortRejects').got.cause === 'the user pressed Esc' && row('abortRejects').ms < 1040 && row('abortRejects').after === 0, said('abortRejects'))
  check('a caller that answers an abort with a value gets that value', row('abortValue').got.value === 'stopped' && row('abortValue').ms < 1040 && row('abortValue').after === 0, said('abortValue'))
  check('a signal aborted before the wait ends it before it begins', row('abortedBefore').got.error === 'AbortError' && row('abortedBefore').ms < 1000 && row('abortedBefore').after === 0, said('abortedBefore'))
  const noLimit = out.noLimit as (Row & { stopped?: Got }) | undefined
  check('a limit of Infinity arms no timer: the work alone settles the wait, and an abort alone ends it', noLimit?.got.value === 'worked' && noLimit.during === 0 && noLimit.stopped?.error === 'AbortError' && noLimit.ms < 1040 && noLimit.after === 0, said('noLimit'))

  section("the inactivity deadline's within: a work raced against its expiry inside the door")
  check('within gives the value of a work that settles in time, and rejects with the deadline\'s own error after its silence', row('within').got.value === 'chunk' && row('within').got.error === 'DeadlineExceededError' && /^a planted read: no progress for 120ms/.test(row('within').got.message ?? '') && row('within').ms >= 100 && row('within').ms < 1150 && row('within').after === 0, said('within'))

  section('pollUntil: a look that nothing can announce, bounded and cancellable')
  check('the poll ends on the look that finds, after two waits of its period, and leaves no timer', row('pollFound').got.value === 'found' && row('pollFound').looks === 3 && row('pollFound').ms >= 55 && row('pollFound').after === 0, said('pollFound'))
  check("at its limit the poll settles with the caller's value, after whole pauses: its last look is the first one at or past the limit (300 ms pauses, a 350 ms limit: looks at 0, 300 and 600)", row('pollLimit').got.value === 'fallback' && row('pollLimit').looks === 3 && row('pollLimit').ms >= 599 && row('pollLimit').ms < 1600 && row('pollLimit').after === 0, said('pollLimit'))
  check('a pause the caller cuts to what is left makes its last look at the limit (looks at 0, 300 and 350)', row('pollCut').got.value === 'fallback' && row('pollCut').looks === 3 && row('pollCut').ms >= 349 && row('pollCut').ms < 590 && row('pollCut').after === 0, said('pollCut'))
  check('an abort 40 ms into a 10 s period ends the poll at once with an AbortError', row('pollAbort').got.error === 'AbortError' && row('pollAbort').ms < 1040 && row('pollAbort').after === 0, said('pollAbort'))

  section('a timer asked not to hold the process does not hold it')
  const t0 = performance.now()
  const loose = spawnSync(node, [driver, door, 'loose'], { encoding: 'utf8', timeout: 20_000 })
  const looseMs = Math.round(performance.now() - t0)
  check('a process whose only pending waits are unref (a 60 s deadline and a 30 s poll) exits by itself', loose.error === undefined && loose.status === 0 && looseMs < 15_000, `status ${loose.status ?? loose.signal} after ${looseMs} ms ${(loose.stderr ?? '').trim().slice(-300)} — the unref option of withDeadline and pollUntil in src/platform/async/deadline.ts must unref the timers it arms`)
  const held = spawnSync(node, [driver, door, 'held'], { encoding: 'utf8', timeout: 3_000 })
  check('the same deadline without unref holds the process (the control: it is still running when stopped at 3 s)', (held.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', `status ${held.status ?? held.signal} ${String(held.error ?? '')} — without unref, withDeadline in src/platform/async/deadline.ts must leave its timer referenced so the process stays alive`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-deadline-door: green' : `\nprove-deadline-door: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
