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
} finally {
  delete process.env.MERCURY_FAULT_INJECT
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-daemon-stores-held-save' : `\nFAIL prove-daemon-stores-held-save (${failures})`)
process.exit(failures === 0 ? 0 : 1)
