#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-ev-'))

const P = await import('../../src/engine/runtime-kernel/index.ts')
const { observeToolTerminal } = await import('../../src/engine/run-owner/effectObserver.ts')
const { recordEvidence } = await import('../../src/platform/verification/verificationState.ts')
const { resolveResource } = await import('../../src/integrations/resources/registry.ts')
const { disposeOwner } = await import('../../src/engine/run-owner/ownerLifecycle.ts')
const { startService, stopService, waitForReady } =
  await import('../../src/tools/engines/project-services/serviceManager.ts')
const { serviceExecutionOwner } = await import('../../src/tools/engines/project-services/executionProjection.ts')
const { buildAgentResultEnvelope } = await import('../../src/crew/agent-results/normalize.ts')
const { processOwnerForLane } = await import('../../src/engine/run-owner/resolveOwner.ts')

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
  console.log('\n❌ TIMEOUT — evidence plane proof exceeded 120s; look at startService and waitForReady in src/tools/engines/project-services/serviceManager.ts, the real child ev-svc may never reach readiness')
  process.exit(1)
}, 120_000)
guard.unref?.()

const workDir = mkdtempSync(join(tmpdir(), 'axiom-ev-work-'))
const owner = P.makeOwnerKey({ workspace: workDir, sessionId: 'ev-proof', lane: P.MAIN_LANE })

console.log('wired producers')
{
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: 'tu-ev',
    input: { file_path: `${workDir}/a.ts` },
    ok: true,
    durationMs: 2,
    cwd: workDir,
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: [`${workDir}/a.ts`],
      evidence: 'proof',
      startedAt: 1,
      completedAt: 2,
    },
  })
  const change = P.evidenceFor(owner).find(r => r.kind === 'change')
  check('mutation receipt yields observed change evidence',
    change !== undefined && change.origin === 'observed',
    'a succeeded mutation seen by observeToolTerminal must add an observed change record to the evidence ring in src/engine/runtime-kernel/evidencePlane.ts')
  check('change evidence references receipt AND transaction',
    change !== undefined &&
      change.refs.some(r => r.startsWith('mercury://receipt/')) &&
      change.refs.some(r => r.startsWith('mercury://transaction/')),
    'the change evidence must list a mercury://receipt/ ref and a mercury://transaction/ ref in its refs')

  P.registerExecution({ owner, id: 'job1', kind: 'process', label: 'job1', lifecycle: 'session' })
  P.transitionExecution(owner, 'job1', 'starting')
  P.settleExecution(owner, 'job1', 'succeeded', { outcome: { code: 0 } })
  const exec = P.evidenceFor(owner).find(r => r.kind === 'execution' && r.claim.includes('job1'))
  check('execution settlement yields observed execution evidence',
    exec !== undefined && exec.refs.includes('mercury://execution/job1'),
    'settleExecution must add an observed execution evidence record whose refs include mercury://execution/job1')

  recordEvidence(workDir, { command: 'bun run typecheck', ok: true, scope: 'typecheck', coverage: 'strict tsc' }, owner)
  const checkEv = P.evidenceFor(owner).find(r => r.kind === 'check' && r.claim.includes('strict tsc'))
  check('verification row yields observed check evidence',
    checkEv !== undefined && checkEv.claim.includes('green'),
    'recordEvidence in src/platform/verification/verificationState.ts must add an observed check evidence record whose claim names the coverage and reads green')

  recordEvidence(workDir, { command: 'bun run typecheck', ok: false, scope: 'typecheck', coverage: 'strict tsc' }, owner)
  const all = P.evidenceFor(owner).filter(r => r.kind === 'check' && r.claim.includes('strict tsc'))
  check('repeat observation supersedes (never silently replaces)',
    all.length === 2 && all[0]!.state === 'superseded' && all[1]!.state === 'present' &&
      all[1]!.claim.includes('RED'),
    'a second observation of the same check must mark the first record superseded and add a present record reading RED, see recordCanonicalEvidence in src/engine/runtime-kernel/evidencePlane.ts')
}

console.log('service readiness evidence (real child)')
{
  const spec = {
    name: 'ev-svc',
    command: process.execPath,
    args: ['-e', 'console.log("ev up"); setInterval(() => {}, 1000)'],
    cwd: workDir,
    readiness: [{ kind: 'log', regex: 'ev up' } as const],
    readinessMode: 'all' as const,
    restart: 'never' as const,
    lifecycle: 'session' as const,
  }
  await startService({ spec, sessionId: 'ev-proof' })
  await waitForReady(workDir, 'ev-svc', 15_000)
  const projectOwnerKey = serviceExecutionOwner(workDir)
  const readiness = P.evidenceFor(projectOwnerKey).find(
    r => r.kind === 'check' && r.claim.includes('ev-svc readiness met'),
  )
  check('readiness evidence exists on the project owner',
    readiness !== undefined && readiness.origin === 'observed',
    'when a service becomes ready, an observed check record reading ev-svc readiness met must land on the owner from serviceExecutionOwner in src/tools/engines/project-services/executionProjection.ts')
  check('readiness evidence points at the execution',
    readiness !== undefined && readiness.refs.includes('mercury://execution/service:ev-svc'),
    'the readiness record must list mercury://execution/service:ev-svc in its refs')
  await stopService(workDir, 'ev-svc')
}

console.log('origin + integrity laws')
{
  const declared = P.recordCanonicalEvidence({
    owner,
    kind: 'check',
    origin: 'declared',
    claim: 'the agent SAYS it ran the gate',
  })
  check('declared origin is preserved', P.evidenceById(owner, declared.id)?.origin === 'declared',
    'change recordCanonicalEvidence or evidenceById in src/engine/runtime-kernel/evidencePlane.ts to keep the origin given by the caller')
  try {
    P.recordCanonicalEvidence({ owner, kind: 'observation', origin: 'derived', claim: 'derived orphan' })
    check('derived without sources refused', false,
      'change recordCanonicalEvidence in src/engine/runtime-kernel/evidencePlane.ts to throw EvidenceIntegrityError for origin derived with no refs')
  } catch (e) {
    check('derived without sources refused', e instanceof P.EvidenceIntegrityError,
      'recordCanonicalEvidence in src/engine/runtime-kernel/evidencePlane.ts must throw EvidenceIntegrityError, not another error')
  }
  const derived = P.recordCanonicalEvidence({
    owner,
    kind: 'observation',
    origin: 'derived',
    claim: 'derived with sources',
    refs: [`mercury://evidence/${declared.id}`],
  })
  check('derived with named sources accepted', derived.origin === 'derived',
    'change recordCanonicalEvidence in src/engine/runtime-kernel/evidencePlane.ts to accept origin derived when refs are given')
}

console.log('expiry honesty')
{
  const early = P.recordCanonicalEvidence({
    owner, kind: 'observation', origin: 'observed', claim: 'early record',
  })
  for (let i = 0; i < 300; i++) {
    P.recordCanonicalEvidence({ owner, kind: 'observation', origin: 'observed', claim: `flood ${i}` })
  }
  const ctx = { owner, cwd: workDir }
  const expired = await resolveResource(`mercury://evidence/${early.id}`, ctx)
  check('ring-evicted evidence reads expired, never absent', expired.state === 'expired',
    'change the evidence resolver behind resolveResource (src/integrations/resources/registry.ts) to answer expired for an id that left the ring')
  const absent = await resolveResource('mercury://evidence/ev-never', ctx)
  check('unknown evidence reads absent', absent.state === 'absent',
    'change the evidence resolver behind resolveResource (src/integrations/resources/registry.ts) to answer absent for an id never recorded')
  const listing = await resolveResource('mercury://evidence', ctx)
  check('listing bounded', listing.state === 'ok' && (listing.resource.children?.length ?? 0) <= 50,
    'change the mercury://evidence listing behind resolveResource (src/integrations/resources/registry.ts) to return state ok with at most 50 children')
}

console.log('envelope evidence refs (additive, deterministic)')
{
  const agentId = 'ag-ev-1'
  const lane = processOwnerForLane(agentId)
  observeToolTerminal({
    owner: lane,
    toolName: 'Edit',
    toolUseId: 'tu-lane',
    input: { file_path: `${workDir}/lane.ts` },
    ok: true,
    durationMs: 2,
    cwd: workDir,
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: [`${workDir}/lane.ts`],
      evidence: 'proof',
      startedAt: 1,
      completedAt: 2,
    },
  })
  const build = () =>
    buildAgentResultEnvelope({
      agentId,
      status: 'completed',
      finalText:
        'done. <mercury-envelope>{"summary":"did the thing","checks":["never-ran-check"]}</mercury-envelope>',
    })
  const env1 = await build()
  const env2 = await build()
  check('envelope carries observed evidence refs',
    (env1.evidenceRefs?.length ?? 0) > 0 &&
      env1.evidenceRefs!.every(r => r.startsWith('mercury://evidence/')),
    'change buildAgentResultEnvelope in src/crew/agent-results/normalize.ts to fill evidenceRefs with mercury://evidence/ refs of the agent lane evidence')
  check('normalisation stays deterministic',
    JSON.stringify(env1.evidenceRefs) === JSON.stringify(env2.evidenceRefs),
    'buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must return the same evidenceRefs on every call with the same input')
  check('declared check that never ran stays unknown (never observed)',
    env1.checks.find(c => c.name === 'never-ran-check')?.state === 'unknown',
    'buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must mark a declared check with no observed run as unknown')
  check('observed changed paths intact (existing contract preserved)',
    env1.changedPaths.includes(`${workDir}/lane.ts`),
    'buildAgentResultEnvelope in src/crew/agent-results/normalize.ts must keep the observed changed paths of the agent lane')
  await disposeOwner(lane)
}

console.log('owner disposal')
{
  await disposeOwner(owner)
  check('disposal clears the evidence ring', P.evidenceFor(owner).length === 0,
    'the evidence ring in src/engine/runtime-kernel/evidencePlane.ts must register for disposeOwner (src/engine/run-owner/ownerLifecycle.ts) so disposal clears it')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
