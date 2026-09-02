#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot, guardWrite, waitUntil } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-task-stall')
const t = checker()

const { acquirePidLockWithRetry, PidLockBusyError, probePidLock } = await import(
  '../../src/substrate/pidLock.ts'
)

const CHILD_SRC = `
;(globalThis).MACRO = { VERSION: '1.0.0' }
const { acquirePidLock } = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src', 'substrate', 'pidLock.ts'))})
const [, , lockPath, readyPath] = process.argv
const got = await acquirePidLock(lockPath, 'stall-child', { liveness: 'assume-alive' })
if (!got.held) process.exit(2)
require('node:fs').writeFileSync(readyPath, String(process.pid))
setInterval(() => {}, 60_000)
`
const childScript = guardWrite(root, join(root, 'stall-child.mjs'))
writeFileSync(childScript, CHILD_SRC)

const lockPath = join(root, 'locks', 'tasks.lock')
mkdirSync(join(root, 'locks'), { recursive: true })
const readyPath = join(root, 'child-ready')

const child = spawn('bun', [childScript, lockPath, readyPath], { stdio: 'ignore' })
const ready = await waitUntil(() => existsSync(readyPath), { tries: 600, everyMs: 10 })

t.section('§1 — a stalled-but-alive holder is never stolen from')
{
  t.check('(premise) the child holder acquired and reported ready', ready && child.pid !== undefined)
  process.kill(child.pid!, 'SIGSTOP')
  let busy: unknown = null
  try {
    await acquirePidLockWithRetry(lockPath, 'contender', {
      liveness: 'assume-alive',
      retries: 6,
      minTimeoutMs: 5,
      maxTimeoutMs: 40,
    })
  } catch (e) {
    busy = e
  }
  t.check('the contender exhausted its budget into the typed busy error', busy instanceof PidLockBusyError)
  t.check(
    'the busy error names the LIVE holder pid (never stolen from)',
    busy instanceof PidLockBusyError && busy.holderPid === child.pid,
    busy instanceof PidLockBusyError ? `holderPid=${busy.holderPid}` : String(busy),
  )
  const holder = await probePidLock(lockPath, { liveness: 'assume-alive' })
  t.check('the stopped holder still owns the record', holder?.pid === child.pid)
}

t.section('§2 — a dead holder reclaims on confirmed death')
{
  process.kill(child.pid!, 'SIGKILL')
  await waitUntil(() => {
    try {
      process.kill(child.pid!, 0)
      return false
    } catch {
      return true
    }
  })
  const got = await acquirePidLockWithRetry(lockPath, 'contender', {
    liveness: 'assume-alive',
    retries: 10,
    minTimeoutMs: 5,
    maxTimeoutMs: 50,
  })
  t.check('the contender acquired after the holder died', typeof got.release === 'function')
  await got.release()
}

t.section('§3 — legacy artifacts stay inert')
{
  const legacySeed = join(root, 'locks', 'legacy-seed.lock')
  writeFileSync(guardWrite(root, legacySeed), '')
  const got = await acquirePidLockWithRetry(legacySeed, 'migrator', {
    liveness: 'assume-alive',
    retries: 10,
    minTimeoutMs: 5,
    maxTimeoutMs: 50,
  })
  t.check('a pre-migration EMPTY lock file reclaims through the confirmed clobber', typeof got.release === 'function')
  await got.release()
  const body = join(root, 'locks', 'task-7.json')
  writeFileSync(guardWrite(root, body), '{}')
  mkdirSync(join(root, 'locks', 'task-7.json.lock'), { recursive: true })
  const sib = await acquirePidLockWithRetry(`${body}.pidlock`, 'migrator', {
    liveness: 'assume-alive',
    retries: 5,
    minTimeoutMs: 5,
    maxTimeoutMs: 40,
  })
  t.check('a legacy .lock DIRECTORY never touches the .pidlock sibling', typeof sib.release === 'function')
  await sib.release()
}

t.section('§4 — the migrated task operations work end-to-end')
{
  const tasks = await import('../../src/utils/tasks.ts')
  const id = await tasks.createTask('cairn-stall-proof', {
    subject: 'stall proof task',
    description: 'created under the pid-liveness mutex',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  t.check('createTask succeeded under the new mutex', typeof id === 'string' && id.length > 0, String(id))
  const updated = await tasks.updateTask('cairn-stall-proof', id, { status: 'in_progress' } as never)
  t.check('updateTask succeeded under the per-task .pidlock sibling', updated !== null)
}

t.section('§5 — same-process contenders mutually exclude (the close review\'s material find)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/tasks.ts'), 'utf8')
  t.check(
    'tasks mints a per-acquisition owner (never a process-scoped one)',
    src.includes('tasks-${process.pid}-${++taskLockSeq}'),
  )
  const lockPath2 = join(root, 'locks', 'same-process.lock')
  const a = await acquirePidLockWithRetry(lockPath2, 'proc-acq-1', {
    liveness: 'assume-alive',
    retries: 3,
    minTimeoutMs: 5,
    maxTimeoutMs: 20,
  })
  let blocked: unknown = null
  try {
    await acquirePidLockWithRetry(lockPath2, 'proc-acq-2', {
      liveness: 'assume-alive',
      retries: 3,
      minTimeoutMs: 5,
      maxTimeoutMs: 20,
    })
  } catch (e) {
    blocked = e
  }
  t.check('a second in-process acquirer BLOCKS while the first holds (never co-admitted)', blocked instanceof PidLockBusyError)
  await a.release()
  const b = await acquirePidLockWithRetry(lockPath2, 'proc-acq-2', {
    liveness: 'assume-alive',
    retries: 10,
    minTimeoutMs: 5,
    maxTimeoutMs: 40,
  })
  t.check('after the first releases, the second acquires cleanly', typeof b.release === 'function')
  await b.release()
}

t.finish('prove-task-lock-stall')
