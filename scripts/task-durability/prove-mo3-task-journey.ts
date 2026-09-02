#!/usr/bin/env bun
// ============================================================================
//  prove-mo3-task-journey — the reported defect surface.
//  Repeated create/update/reset TASK journeys through the REAL task store
//  (src/utils/tasks.ts → substrate publishAtomic → durableAtomicPublish),
//  with the win32 transient-lock class injected at the designed seam.
//
//    §1 create ×3: complete bodies, one notification per mutation;
//    §2 update under clearing contention: win32 absorbs it (one result, ONE
//       notification — no duplicates after a successful retry); POSIX keeps
//       single-attempt semantics (typed failure, ZERO notifications, the
//       complete previous value intact); a concurrent poller NEVER observes
//       partial JSON;
//    §3 reset: epoch bump commits, ids never reused across the reset (no
//       duplicate tasks), a transiently-failing epoch publish leaves the
//       whole-old list (POSIX) or lands after retry (win32);
//    §4 the repeated journey ×3: every observation whole-old-or-whole-new,
//       zero orphan temps, no excessive waiting;
//    §5 watcher-backed stores: a FileStore mutation that retried publishes
//       exactly ONE change emission — and a failed publish emits NOTHING.
//
//  Env is pinned per invocation (MERCURY_CONFIG_DIR → mkdtemp scratch) BEFORE
//  any src import; fixtures are the deterministic MERCURY_FAULT_INJECT seam.
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mooring-mo3-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_TASK_LIST_ID

const IS_WIN = process.platform === 'win32'
let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Dynamic imports AFTER the env pin (config-home resolution memoizes).
const tasks = await import('../../src/utils/tasks.ts')
const { _resetFaultInjectionCountersForTests, isDurableTempName, DurablePublishError } = await import(
  '../../src/substrate/durablePublish.ts'
)
const inject = (spec: string | null): void => {
  if (spec === null) delete process.env.MERCURY_FAULT_INJECT
  else process.env.MERCURY_FAULT_INJECT = spec
  _resetFaultInjectionCountersForTests()
}

const LIST = 'moor-journey'
const dir = tasks.getTasksDir(LIST)
const startedAt = Date.now()
let notifs = 0
const unsubscribe = tasks.onTasksUpdated(() => notifs++)

const bodyFiles = (): string[] => {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  } catch {
    return []
  }
}
const tempsInDir = (): string[] => {
  try {
    return readdirSync(dir).filter(isDurableTempName)
  } catch {
    return []
  }
}
/** Every task body on disk parses as COMPLETE JSON (never torn). */
const allBodiesWhole = (): boolean =>
  bodyFiles().every(f => {
    try {
      JSON.parse(readFileSync(join(dir, f), 'utf8'))
      return true
    } catch {
      return false
    }
  })
const mk = (subject: string) =>
  ({ subject, description: `${subject} body`, status: 'pending', blocks: [], blockedBy: [] }) as const

console.log(`── mo3 task journey — live platform: ${process.platform}`)

// ── §1 create ×3 ────────────────────────────────────────────────────────────
{
  const before = notifs
  const id1 = await tasks.createTask(LIST, mk('one'))
  const id2 = await tasks.createTask(LIST, mk('two'))
  const id3 = await tasks.createTask(LIST, mk('three'))
  ok(id1 === '1' && id2 === '2' && id3 === '3', `§1 sequential ids (${id1},${id2},${id3})`)
  const listed = await tasks.listTasks(LIST)
  ok(listed.length === 3 && allBodiesWhole(), '§1 three complete bodies on disk, all parse whole')
  ok(notifs - before === 3, `§1 exactly one notification per create (${notifs - before})`)
  ok(tempsInDir().length === 0, '§1 zero publish temps left')
}

// ── §2 update under clearing contention + a concurrent poller ───────────────
{
  const taskPath = tasks.getTaskPath(LIST, '1')
  const observations: string[] = []
  /** Sample the raw task file continuously UNTIL the racing operation
   *  settles, plus one final read — deterministic on any host speed. A read
   *  can miss between rename instants on win32 (the REPLACE window, not a
   *  torn write); parse checks below are the law. */
  const sampleDuring = async (op: Promise<unknown>): Promise<void> => {
    let settled = false
    const guarded = op.catch(() => {}).finally(() => {
      settled = true
    })
    do {
      try {
        observations.push(readFileSync(taskPath, 'utf8'))
      } catch {
        /* replace-window miss */
      }
      await new Promise(r => setTimeout(r, 2))
    } while (!settled)
    await guarded
    observations.push(readFileSync(taskPath, 'utf8'))
  }
  inject('rename@1.json:eperm#2')
  const before = notifs
  if (IS_WIN) {
    const update = tasks.updateTask(LIST, '1', { status: 'in_progress' })
    await sampleDuring(update)
    const updated = await update
    ok(updated?.status === 'in_progress', '§2 win32: update landed through the clearing contention')
    ok(notifs - before === 1, `§2 win32: exactly ONE notification after the successful retry (${notifs - before})`)
  } else {
    const update = tasks.updateTask(LIST, '1', { status: 'in_progress' })
    await sampleDuring(update)
    let caught: unknown = null
    try {
      await update
    } catch (e) {
      caught = e
    }
    ok(caught instanceof DurablePublishError && caught.fsCode === 'EPERM', '§2 POSIX: typed publish failure surfaced')
    ok(notifs - before === 0, `§2 POSIX: ZERO notifications for a failed update (${notifs - before})`)
    const kept = await tasks.getTask(LIST, '1')
    ok(kept?.status === 'pending' && kept.subject === 'one', '§2 POSIX: the complete PREVIOUS task is intact')
  }
  inject(null)
  const settled = await tasks.updateTask(LIST, '1', { status: 'in_progress' })
  ok(settled?.status === 'in_progress', '§2 the journey settles at the complete NEW value once the condition clears')
  const whole = observations.every(raw => {
    try {
      const t = JSON.parse(raw) as { subject?: string }
      return t.subject === 'one'
    } catch {
      return false
    }
  })
  ok(whole && observations.length > 0, `§2 concurrent sampler: ${observations.length} observations, every one COMPLETE JSON`)
}

// ── §3 reset: epoch commit, id continuity, transient at the epoch publish ───
{
  ok(await tasks.resetTaskList(LIST), '§3 reset returns true')
  ok((await tasks.listTasks(LIST)).length === 0, '§3 list empty after reset')
  ok((await tasks.readTaskEpoch(LIST)) === 1, '§3 epoch bumped durably')
  const id4 = await tasks.createTask(LIST, mk('four'))
  ok(id4 === '4', `§3 ids continue past the reset — never a duplicate task id (${id4})`)

  inject('rename@.epoch:eperm#1')
  if (IS_WIN) {
    ok(await tasks.resetTaskList(LIST), '§3 win32: reset lands through a transient epoch-publish lock')
    ok((await tasks.readTaskEpoch(LIST)) === 2 && (await tasks.listTasks(LIST)).length === 0, '§3 win32: epoch=2, empty')
  } else {
    let caught: unknown = null
    try {
      await tasks.resetTaskList(LIST)
    } catch (e) {
      caught = e
    }
    ok(caught instanceof DurablePublishError, '§3 POSIX: transiently-failing epoch publish surfaces typed')
    const kept = await tasks.listTasks(LIST)
    ok(
      kept.length === 1 && kept[0]!.subject === 'four' && (await tasks.readTaskEpoch(LIST)) === 1,
      '§3 POSIX: the WHOLE previous list survives an interrupted reset (epoch unmoved)',
    )
    inject(null)
    ok(await tasks.resetTaskList(LIST), '§3 POSIX: reset lands once the condition clears')
    ok((await tasks.readTaskEpoch(LIST)) === 2, '§3 POSIX: epoch=2 after the clean reset')
  }
  inject(null)
}

// ── §4 the repeated journey ×3 ──────────────────────────────────────────────
{
  let maxIdSeen = 4
  for (let cycle = 0; cycle < 3; cycle++) {
    if (IS_WIN) inject(`rename@${5 + cycle * 2}.json:ebusy#1`) // one clearing lock per cycle
    const a = await tasks.createTask(LIST, mk(`c${cycle}-a`))
    const b = await tasks.createTask(LIST, mk(`c${cycle}-b`))
    await tasks.updateTask(LIST, a, { status: 'completed' })
    await tasks.updateTask(LIST, b, { status: 'completed' })
    inject(null)
    const ids = [Number(a), Number(b)]
    ok(
      ids.every(n => n > maxIdSeen),
      `§4 cycle ${cycle}: fresh ids only (${ids.join(',')} > ${maxIdSeen})`,
    )
    maxIdSeen = Math.max(...ids)
    ok(allBodiesWhole(), `§4 cycle ${cycle}: every body whole`)
    ok(await tasks.resetTaskList(LIST), `§4 cycle ${cycle}: reset`)
  }
  ok(tempsInDir().length === 0, '§4 zero unexplained temporary files after 3 full journeys')
  const wall = Date.now() - startedAt
  ok(wall < 30_000, `§4 no excessive waiting — the whole journey took ${wall}ms`)
}

// ── §5 watcher-backed store: one emission per retried publish, none on fail ─
{
  const { defineStore } = await import('../../src/substrate/fileStore.ts')
  type Counter = { n: number }
  const counterStore = defineStore<Counter>({
    name: 'moor-counter',
    path: () => join(scratch, 'stores', 'moor-counter.json'),
    schemaVersion: 1,
    decode: raw =>
      raw !== null && typeof raw === 'object' && typeof (raw as Counter).n === 'number'
        ? { n: (raw as Counter).n }
        : null,
    empty: () => ({ n: 0 }),
    onReadFailure: 'empty',
  })
  const store = counterStore()
  await store.write({ n: 1 })
  let emissions = 0
  const unsub = store.subscribeChanges(() => emissions++, { immediate: false })
  inject('rename@moor-counter.json:eperm#1')
  if (IS_WIN) {
    await store.mutate(c => ({ n: c.n + 1 }))
    inject(null)
    // poll until the change lands (bounded 3s), THEN the grace guards the
    // exactly-once oracle against a late duplicate echo.
    for (const deadline = Date.now() + 3000; emissions < 1 && Date.now() < deadline; ) {
      await new Promise(r => setTimeout(r, 50))
    }
    await new Promise(r => setTimeout(r, 300)) // let any duplicate echo arrive
    ok(emissions === 1, `§5 win32: retried publish fired exactly ONE change (${emissions})`)
    ok((await store.read()).n === 2, '§5 win32: committed value is the new one')
  } else {
    let caught: unknown = null
    try {
      await store.mutate(c => ({ n: c.n + 1 }))
    } catch (e) {
      caught = e
    }
    inject(null)
    await new Promise(r => setTimeout(r, 300))
    ok(caught !== null && emissions === 0, `§5 POSIX: failed publish emitted NOTHING (${emissions})`)
    ok((await store.read()).n === 1, '§5 POSIX: readers keep the whole previous value')
    await store.mutate(c => ({ n: c.n + 1 }))
    for (const deadline = Date.now() + 3000; emissions < 1 && Date.now() < deadline; ) {
      await new Promise(r => setTimeout(r, 50))
    }
    await new Promise(r => setTimeout(r, 300)) // duplicate-echo grace
    ok(emissions === 1, `§5 POSIX: the clean retry emitted exactly once (${emissions})`)
  }
  unsub()
}

unsubscribe()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-mo3-task-journey' : `\nFAIL prove-mo3-task-journey (${failures})`)
process.exit(failures === 0 ? 0 : 1)
