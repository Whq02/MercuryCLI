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
} finally {
  delete process.env.MERCURY_FAULT_INJECT
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-daemon-stores-held-save' : `\nFAIL prove-daemon-stores-held-save (${failures})`)
process.exit(failures === 0 ? 0 : 1)
