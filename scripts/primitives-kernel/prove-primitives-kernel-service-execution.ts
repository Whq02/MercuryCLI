#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-service-execution.ts — slice-3 projection laws,
//  proved with REAL child processes through the PRODUCTION service manager:
//
//    · one canonical execution registration per start (exactly once);
//    · the plane mirrors starting → ready → stopping → stopped;
//    · restart mints a new plane generation;
//    · explicit stop settles 'stopped' (never failed);
//    · a killed process reconciles honestly (record + plane agree on
//      failed, via the DOMAIN's pid+start-token truth);
//    · a plane-side requestStop drives the REAL stop ladder;
//    · at every step, the service record and the plane record agree
//      (serviceExecutionDrift) — no silent disagreement;
//    · readiness stays domain-owned (the plane holds no readiness state).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-svc-'))
delete process.env.MERCURY_SERVICES

const {
  readRecord,
  reconcileRecord,
  restartService,
  startService,
  stopService,
  waitForReady,
} = await import('../../src/services/projectServices/serviceManager.ts')
const {
  serviceExecutionDrift,
  serviceExecutionId,
  serviceExecutionOwner,
} = await import('../../src/services/projectServices/executionProjection.ts')
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
  console.log('\n❌ TIMEOUT — service execution proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'axiom-svc-work-'))
const NODE = process.execPath
const SESSION = 'axiom-svc-session'
const owner = serviceExecutionOwner(workDir)
const execId = serviceExecutionId('axiom-web')

const registrations: number[] = []
const unsubscribe = P.subscribeExecutionEvents(e => {
  if (e.event.type === 'registered' && e.event.record.spec.id === execId) {
    registrations.push(e.event.record.generation)
  }
})

const spec = {
  name: 'axiom-web',
  command: NODE,
  args: ['-e', 'console.log("axiom up"); setInterval(() => {}, 1000)'],
  cwd: workDir,
  readiness: [{ kind: 'log', regex: 'axiom up' } as const],
  readinessMode: 'all' as const,
  restart: 'never' as const,
  lifecycle: 'session' as const,
}

function drift(): boolean {
  const record = readRecord(workDir, 'axiom-web')
  if (!record) return false
  const d = serviceExecutionDrift(workDir, record)
  return d !== null && d.agree
}

console.log('start → ready journey')
{
  const started = await startService({ spec, sessionId: SESSION })
  check('service starts', 'record' in started)
  const planeRec = P.getExecution(owner, execId)
  check('canonical execution registered exactly once at start',
    registrations.length === 1 && planeRec?.generation === 1)
  check('plane mirrors starting with pid identity',
    planeRec?.state === 'starting' && planeRec.externalIdentity?.pid !== undefined)
  check('record/plane agree at start', drift())

  const ready = await waitForReady(workDir, 'axiom-web', 15_000)
  check('readiness reached (domain truth)', ready.ready)
  const readyRec = P.getExecution(owner, execId)
  check('plane mirrors ready', readyRec?.state === 'ready')
  check('plane holds NO readiness detail (domain-owned)',
    readyRec !== undefined && !('readiness' in readyRec) &&
      readyRec.spec.metadata?.name === 'axiom-web')
  check('record/plane agree at ready', drift())
}

console.log('restart mints a new generation')
{
  const restarted = await restartService(workDir, 'axiom-web', SESSION)
  check('restart succeeds', 'record' in restarted)
  const planeRec = P.getExecution(owner, execId)
  check('plane generation is 2', planeRec?.generation === 2)
  check('registrations: exactly one per start', registrations.length === 2)
  check('record/plane agree after restart', drift())
}

console.log('explicit stop settles stopped')
{
  const stopped = await stopService(workDir, 'axiom-web')
  check('stop succeeds', 'record' in stopped && stopped.record.state === 'stopped')
  const planeRec = P.getExecution(owner, execId)
  check('plane settles stopped (never failed) on explicit stop',
    planeRec?.state === 'stopped' && planeRec.settledAt !== undefined)
  check('record/plane agree after stop', drift())
}

console.log('killed process reconciles honestly')
{
  const started = await startService({ spec, sessionId: SESSION })
  check('third start (gen 3)', 'record' in started && P.getExecution(owner, execId)?.generation === 3)
  const record = readRecord(workDir, 'axiom-web')
  const pid = record?.pid
  check('live pid recorded', typeof pid === 'number')
  if (typeof pid === 'number') {
    process.kill(pid, 'SIGKILL')
    // Give the exit handler a beat, then reconcile from the process table.
    await new Promise(r => setTimeout(r, 400))
    const reconciled = reconcileRecord(workDir, 'axiom-web')
    check('record downgrades to failed/stopped from process truth',
      reconciled !== null && (reconciled.state === 'failed' || reconciled.state === 'stopped'))
    const planeRec = P.getExecution(owner, execId)
    check('plane settles with the record', planeRec !== undefined &&
      P.isTerminalExecutionState(planeRec.state))
    check('record/plane agree after kill+reconcile', drift())
  }
}

console.log('plane-side requestStop drives the real stop ladder')
{
  await startService({ spec, sessionId: SESSION })
  const before = P.getExecution(owner, execId)
  check('fourth start live (gen 4)', before?.generation === 4 && before.state === 'starting')
  P.requestStopExecution(owner, execId)
  // The domain's stop ladder is async; poll for settlement.
  const deadline = Date.now() + 10_000
  let settled = false
  while (Date.now() < deadline) {
    const rec = P.getExecution(owner, execId)
    if (rec && P.isTerminalExecutionState(rec.state)) {
      settled = true
      break
    }
    await new Promise(r => setTimeout(r, 150))
  }
  const record = readRecord(workDir, 'axiom-web')
  check('plane stop request settles the execution', settled)
  check('the REAL service stopped (record terminal, explicit)',
    record !== null && record.state === 'stopped' && record.explicitStop)
  check('record/plane agree after plane-driven stop', drift())
}

unsubscribe()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
