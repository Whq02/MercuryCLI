#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-stores-held-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
for (const dir of [HOME, DAEMON_DIR]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_FAULT_INJECT

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return cond()
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const publish = await import('../../src/platform/substrate/durablePublish.ts')
const collisions = await import('../../src/daemon/concourse-workers/collisions.ts')
const dispatch = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
const { makeConcourseControl } = await import('../../src/daemon/run/concourseControl.ts')

function holdFile(file: string, forMs: number | null): ReturnType<typeof setTimeout> | null {
  process.env.MERCURY_FAULT_INJECT = `rename@${file}:eperm`
  publish._resetFaultInjectionCountersForTests()
  return forMs === null ? null : setTimeout(() => { delete process.env.MERCURY_FAULT_INJECT }, forMs)
}

try {
  console.log('§1 collisions (concourse-collisions.json)')
  {
    const timer = holdFile('concourse-collisions.json', 900)
    let threw = ''
    try {
      collisions.recordCollisionEvidence(
        {
          schema: 1,
          kind: 'exclusive-overlap',
          workspaceId: '/tmp/ws-1',
          holders: [{ workerId: 'w-1', isolation: 'exclusive' }],
          observedAt: Date.now(),
          detail: 'held-save-proof',
        },
        DAEMON_DIR,
      )
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    const landed = await until(
      () => collisions.readCollisionEvidence(DAEMON_DIR).some(r => r.detail === 'held-save-proof'),
      4_500,
    )
    if (timer !== null) clearTimeout(timer)
    delete process.env.MERCURY_FAULT_INJECT
    check(
      'recordCollisionEvidence does not throw while concourse-collisions.json is held',
      threw === '',
      `${threw} — ride out DurablePublishError via rideOutHeldFile in src/daemon/concourse-workers/collisions.ts`,
    )
    check(
      'collision row lands on disk once the 900ms hold clears',
      landed,
      'row never appeared on disk — ride out DurablePublishError via rideOutHeldFile in src/daemon/concourse-workers/collisions.ts',
    )
  }

  console.log('§2 applied-ops ledger (concourse-control-ops.json)')
  {
    const rideOp = (dispatch as Record<string, unknown>).recordConcourseControlOpRidingOut as
      | ((rec: { clientOpId: string; action: string; sessionId: string; outcome: 'applied'; atMs: number }, dir?: string) => Promise<void>)
      | undefined
    check(
      'recordConcourseControlOpRidingOut is exported from concourseDispatch.ts',
      typeof rideOp === 'function',
      'export recordConcourseControlOpRidingOut using rideOutHeldFile in src/daemon/concourse-workers/concourseDispatch.ts',
    )
    if (typeof rideOp === 'function') {
      const timer = holdFile('concourse-control-ops.json', 900)
      let threw = ''
      try {
        await rideOp({ clientOpId: 'op-ride-1', action: 'park', sessionId: 's-1', outcome: 'applied', atMs: Date.now() }, DAEMON_DIR)
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error)
      } finally {
        if (timer !== null) clearTimeout(timer)
        delete process.env.MERCURY_FAULT_INJECT
      }
      check('recordConcourseControlOpRidingOut rides out a 900ms hold', threw === '' && dispatch.readConcourseControlOps(DAEMON_DIR)['op-ride-1']?.action === 'park', threw || JSON.stringify(dispatch.readConcourseControlOps(DAEMON_DIR)))
    }

    const noDispatch = Object.assign(async () => ({ ok: false as const, error: 'none' }), { withdraw: async () => false })
    const control = makeConcourseControl({ roster: null } as Parameters<typeof makeConcourseControl>[0], { concourseDispatchHandler: noDispatch as Parameters<typeof makeConcourseControl>[1]['concourseDispatchHandler'] })
    const timer = holdFile('concourse-control-ops.json', 900)
    const reply = await control({ action: 'park', sessionId: '00000000-dddd-4000-8000-000000000001', by: 'operator', clientOpId: 'op-control-ride-1' })
    if (timer !== null) clearTimeout(timer)
    delete process.env.MERCURY_FAULT_INJECT
    check(
      'concourseControl settle rides out a 900ms held concourse-control-ops.json without saying not recorded',
      reply.outcome === 'refused' && !(reply.detail ?? '').includes('not recorded') && dispatch.readConcourseControlOps(DAEMON_DIR)['op-control-ride-1'] !== undefined,
      `${JSON.stringify(reply)} — await recordConcourseControlOpRidingOut in src/daemon/run/concourseControl.ts`,
    )
  }

  console.log('§3 dispatch ledger (concourse-dispatches.json)')
  {
    const handler = dispatch.makeConcourseDispatchHandler({
      dir: DAEMON_DIR,
      admit: async () => ({ ok: true, runnerId: 'w-disp-1', sessionId: '00000000-dddd-4000-8000-00000000d001' }),
      deliver: async () => true,
    })
    const timer1 = holdFile('concourse-dispatches.json', 900)
    let dispatched: { ok: boolean; state?: string } | null = null
    let threw1 = ''
    try {
      dispatched = await handler({
        clientMessageId: 'cm-held-ride-1',
        prompt: 'hello held dispatch',
        workspaceDir: SCRATCH,
      })
      await dispatch.flushDeferredDispatchPublishes()
    } catch (error) {
      threw1 = error instanceof Error ? error.message : String(error)
    } finally {
      if (timer1 !== null) clearTimeout(timer1)
      delete process.env.MERCURY_FAULT_INJECT
    }
    check(
      'dispatch handler rides out a 900ms held concourse-dispatches.json and lands working on disk',
      threw1 === '' && dispatched?.ok === true && dispatch.readConcourseDispatches(DAEMON_DIR)['cm-held-ride-1']?.state === 'working',
      `${threw1 || JSON.stringify(dispatched)} — ride out publishDispatches via rideOutHeldFile in src/daemon/concourse-workers/concourseDispatch.ts`,
    )

    const holdHandler = dispatch.makeConcourseDispatchHandler({
      dir: DAEMON_DIR,
      admit: async () => ({ ok: false, code: 'runtime-ceiling', error: 'seat full' }),
      deliver: async () => false,
    })
    await holdHandler({
      clientMessageId: 'cm-held-withdraw-1',
      prompt: 'queued row to withdraw',
      workspaceDir: SCRATCH,
    })
    const timer2 = holdFile('concourse-dispatches.json', 900)
    let withdrew = false
    let threw2 = ''
    try {
      withdrew = dispatch.withdrawConcourseDispatch('cm-held-withdraw-1', DAEMON_DIR)
    } catch (error) {
      threw2 = error instanceof Error ? error.message : String(error)
    }
    const withdrawLanded = await until(
      () => dispatch.readConcourseDispatches(DAEMON_DIR)['cm-held-withdraw-1']?.state === 'failed',
      4_500,
    )
    if (timer2 !== null) clearTimeout(timer2)
    delete process.env.MERCURY_FAULT_INJECT
    check(
      'withdrawConcourseDispatch rides out a 900ms held concourse-dispatches.json without throwing',
      threw2 === '' && withdrew && withdrawLanded,
      `${threw2 || `withdrew=${withdrew} landed=${withdrawLanded}`} — use publishDispatchesOrHold via rideOutHeldFile in src/daemon/concourse-workers/concourseDispatch.ts`,
    )
  }

  console.log('§4 box schedules (saturn-box-schedules.json)')
  {
    const box = await import('../../src/daemon/saturn/saturnBoxSchedules.ts')
    const submission = {
      when: { kind: 'every' as const, cron: '*/10 * * * *' },
      action: {
        kind: 'birth' as const,
        birth: { prompt: 'hello box held save', workspaceDir: SCRATCH, modelKey: 'claude-sonnet-5', presence: 'headless' as const },
      },
    }
    const deps = {
      deriveAccount: () => ({ ok: true as const, account: { family: 'anthropic', source: 'api-key' as const } }),
      mintId: () => 'a1b2c3d4',
    }
    const timer1 = holdFile('saturn-box-schedules.json', 900)
    let added: { ok: boolean; id?: string; reason?: string } | null = null
    let threw1 = ''
    try {
      added = box.addBoxSchedule(submission, 'operator:test', deps, DAEMON_DIR)
    } catch (error) {
      threw1 = error instanceof Error ? error.message : String(error)
    }
    const addLanded = await until(
      () => box.readBoxSchedules(DAEMON_DIR).schedules.some(s => s.id === 'a1b2c3d4'),
      4_500,
    )
    if (timer1 !== null) clearTimeout(timer1)
    delete process.env.MERCURY_FAULT_INJECT
    check(
      'addBoxSchedule rides out a 900ms held saturn-box-schedules.json without throwing and lands the minted id',
      threw1 === '' && added?.ok === true && added.id === 'a1b2c3d4' && addLanded,
      `${threw1 || JSON.stringify({ added, addLanded })} — ride out DurablePublishError via rideOutHeldFile in src/daemon/saturn/saturnBoxSchedules.ts`,
    )

    if (addLanded) {
      const timer2 = holdFile('saturn-box-schedules.json', 900)
      let pausedOutcome = ''
      let threw2 = ''
      try {
        pausedOutcome = box.setBoxSchedulePaused('a1b2c3d4', true, DAEMON_DIR)
      } catch (error) {
        threw2 = error instanceof Error ? error.message : String(error)
      }
      const pauseLanded = await until(
        () => box.readBoxSchedules(DAEMON_DIR).schedules.find(s => s.id === 'a1b2c3d4')?.paused === true,
        4_500,
      )
      if (timer2 !== null) clearTimeout(timer2)
      delete process.env.MERCURY_FAULT_INJECT
      check(
        'setBoxSchedulePaused rides out a 900ms held saturn-box-schedules.json without throwing',
        threw2 === '' && pausedOutcome === 'applied' && pauseLanded,
        `${threw2 || `outcome=${pausedOutcome} landed=${pauseLanded}`} — ride out DurablePublishError via rideOutHeldFile in src/daemon/saturn/saturnBoxSchedules.ts`,
      )
    }
  }

  console.log('§5 storeLock timeout (plain busy sentence + path and wait logged)')
  {
    const { readFileSync, utimesSync, writeFileSync } = await import('node:fs')
    const { withDaemonStoreLock } = await import('../../src/daemon/concourse-workers/storeLock.ts')
    const dbg = await import('../../src/platform/logs/debugLog.ts')
    const prevNodeEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    dbg.enableDebugLogging()
    const dbgPath = dbg.getDebugLogPath()
    const target = join(DAEMON_DIR, 'lock-busy-probe.json')
    writeFileSync(target, '{}\n')
    const lockDir = `${target}.lock`
    const ownerPath = `${lockDir}.owner`
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(ownerPath, `${process.pid}\n`)
    const origNow = Date.now
    const baseNow = origNow()
    const futureSec = (baseNow + 120_000) / 1000
    utimesSync(lockDir, futureSec, futureSec)
    let calls = 0
    Date.now = () => {
      calls++
      return calls === 1 ? baseNow : baseNow + 60_000
    }
    let caught: Error | null = null
    try {
      withDaemonStoreLock('the session records', target, DAEMON_DIR, () => {})
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error))
    } finally {
      Date.now = origNow
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
      rmSync(lockDir, { recursive: true, force: true })
      rmSync(ownerPath, { force: true })
    }
    await dbg.flushDebugLogs()
    const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
    check(
      'storeLock timeout throws plain busy sentence and logs path and wait ms to debug log',
      caught !== null &&
        caught.name === 'SessionRecordsLockError' &&
        caught.message === "the daemon's session records were busy — try again" &&
        dbgText.includes(target) &&
        dbgText.includes('another writer held its lock'),
      `err=${caught ? `${caught.name}: ${caught.message}` : 'none'} dbg=${dbgText.slice(-250)}`,
    )

    const dispatchTarget = join(DAEMON_DIR, 'dispatch-lock-busy-probe.json')
    writeFileSync(dispatchTarget, '{}\n')
    const dispatchLockDir = `${dispatchTarget}.lock`
    const dispatchOwnerPath = `${dispatchLockDir}.owner`
    mkdirSync(dispatchLockDir, { recursive: true })
    writeFileSync(dispatchOwnerPath, `${process.pid}\n`)
    const baseNow2 = origNow()
    const futureSec2 = (baseNow2 + 120_000) / 1000
    utimesSync(dispatchLockDir, futureSec2, futureSec2)
    let calls2 = 0
    Date.now = () => {
      calls2++
      return calls2 === 1 ? baseNow2 : baseNow2 + 60_000
    }
    let caughtDispatch: Error | null = null
    try {
      withDaemonStoreLock('the dispatch ledger', dispatchTarget, DAEMON_DIR, () => {})
    } catch (error) {
      caughtDispatch = error instanceof Error ? error : new Error(String(error))
    } finally {
      Date.now = origNow
      rmSync(dispatchLockDir, { recursive: true, force: true })
      rmSync(dispatchOwnerPath, { force: true })
    }
    check(
      'storeLock timeout on the dispatch ledger keeps its own name, path and wait sentence',
      caughtDispatch !== null &&
        caughtDispatch.name === 'SessionRecordsLockError' &&
        caughtDispatch.message.startsWith(`the dispatch ledger at ${dispatchTarget} were not updated: another writer held its lock for `),
      `err=${caughtDispatch ? `${caughtDispatch.name}: ${caughtDispatch.message}` : 'none'} — keep non-session-records storeLock timeout sentence unchanged in src/daemon/concourse-workers/storeLock.ts`,
    )
  }
} finally {
  delete process.env.MERCURY_FAULT_INJECT
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-daemon-stores-held-save' : `\nFAIL prove-daemon-stores-held-save (${failures})`)
process.exit(failures === 0 ? 0 : 1)
