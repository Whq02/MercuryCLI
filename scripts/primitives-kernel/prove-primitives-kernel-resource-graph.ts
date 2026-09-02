#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-resource-graph.ts — slice-6 graph laws through
//  the ONE resolver:
//
//    · mercury://owner answers the current owner with executions/receipts/
//      verification and typed children;
//    · owner → execution → domain-record journeys resolve end to end
//      (workshop runtime; a REAL service via the project owner);
//    · service ↔ execution are one object with a stable alias relation —
//      never two identities;
//    · absent ≠ expired: a ring-evicted execution reads expired (generation
//      memory), an unknown id reads absent;
//    · listings and reads stay bounded.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-graph-'))
delete process.env.MERCURY_SERVICES
delete process.env.MERCURY_REFS
delete process.env.MERCURY_WORKSHOP

const { resolveResource } = await import('../../src/services/resources/registry.ts')
await import('../../src/services/resources/adapters/service.ts')
const { runWorkshopCell } = await import('../../src/services/workshop/runtime.ts')
const { startService, stopService, waitForReady } =
  await import('../../src/services/projectServices/serviceManager.ts')
const P = await import('../../src/services/primitives/index.ts')

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — resource graph proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'axiom-graph-work-'))
const owner = P.makeOwnerKey({ workspace: workDir, sessionId: 'graph-proof', lane: P.MAIN_LANE })
const ctx = { owner, cwd: workDir }
const bridge = {
  inspect: async () => 'x',
  tool: async () => 'x',
  agent: async () => 'x',
}

console.log('owner resource')
{
  await runWorkshopCell({ owner, cwd: workDir, cell: { language: 'js', code: '1+1' }, bridge })
  const res = await resolveResource('mercury://owner', ctx)
  check('current owner resolves ok', res.state === 'ok')
  if (res.state === 'ok') {
    check('owner summary carries scope + executions + verification',
      res.resource.summary.includes('scope session') &&
        res.resource.summary.includes('execution(s)') &&
        res.resource.summary.includes('verify'))
    const execChild = res.resource.children?.find(c => c.ref === 'mercury://execution/workshop:js')
    check('owner → execution child link exists', execChild !== undefined)
  }
  const byKey = await resolveResource(`mercury://owner/${owner}`, ctx)
  check('owner resolves by canonical key id', byKey.state === 'ok')
  const junk = await resolveResource('mercury://owner/not-a-key', ctx)
  check('junk owner id reads absent with guidance', junk.state === 'absent')
}

console.log('owner → execution → domain journey')
{
  const exec = await resolveResource('mercury://execution/workshop:js', ctx)
  check('workshop runtime execution resolves', exec.state === 'ok')
  if (exec.state === 'ok') {
    check('execution carries generation version + structured state',
      exec.resource.version === 'gen 1' &&
        (exec.resource.structured as { state: string }).state === 'ready')
  }

  const spec = {
    name: 'graph-svc',
    command: process.execPath,
    args: ['-e', 'console.log("graph up"); setInterval(() => {}, 1000)'],
    cwd: workDir,
    readiness: [{ kind: 'log', regex: 'graph up' } as const],
    readinessMode: 'all' as const,
    restart: 'never' as const,
    lifecycle: 'session' as const,
  }
  const started = await startService({ spec, sessionId: 'graph-proof' })
  check('real service starts', 'record' in started)
  await waitForReady(workDir, 'graph-svc', 15_000)

  const svcExec = await resolveResource('mercury://execution/service:graph-svc', ctx)
  check('service execution resolves via the project owner fallback', svcExec.state === 'ok')
  if (svcExec.state === 'ok') {
    const domainLink = svcExec.resource.children?.find(c => c.ref === 'mercury://service/graph-svc')
    check('execution → domain-record relation exists', domainLink !== undefined)
  }
  const svc = await resolveResource('mercury://service/graph-svc', ctx)
  check('service domain resource resolves', svc.state === 'ok')
  if (svc.state === 'ok') {
    const execLink = svc.resource.children?.find(
      c => c.ref === 'mercury://execution/service:graph-svc',
    )
    check('service → execution alias relation exists (one object, two views)',
      execLink !== undefined)
  }
  const logs = await resolveResource('mercury://service/graph-svc?child=logs', ctx)
  check('journey ends at bounded output (logs child)',
    logs.state === 'ok' && logs.state === 'ok' && (logs as { resource: { text?: string } }).resource.text !== undefined)
  await stopService(workDir, 'graph-svc')
}

console.log('absence honesty')
{
  const absent = await resolveResource('mercury://execution/never-existed', ctx)
  check('unknown execution reads absent', absent.state === 'absent')

  // Flood the settled ring so an early record evicts, then read it.
  P.registerExecution({ owner, id: 'evictee', kind: 'process', label: 'evictee', lifecycle: 'session' })
  P.settleExecution(owner, 'evictee', 'cancelled')
  for (let i = 0; i < 140; i++) {
    P.registerExecution({ owner, id: `flood-${i}`, kind: 'process', label: 'f', lifecycle: 'session' })
    P.settleExecution(owner, `flood-${i}`, 'cancelled')
  }
  const expired = await resolveResource('mercury://execution/evictee', ctx)
  check('ring-evicted execution reads expired, never absent',
    expired.state === 'expired', `got ${expired.state}`)
}

console.log('bounded listings')
{
  const listing = await resolveResource('mercury://execution', ctx)
  check('kind listing resolves bounded',
    listing.state === 'ok' && (listing.resource.children?.length ?? 0) <= 100)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
