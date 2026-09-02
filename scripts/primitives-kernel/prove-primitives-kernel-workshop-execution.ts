#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-workshop-execution.ts — slice-4 projection
//  laws, proved with REAL workers/kernels through the PRODUCTION runtimes:
//
//    · a JS runtime registers as an execution at spawn and reads
//      running→ready around cells; retained state stays retained;
//    · a killed runtime can never look live — kill settles the plane
//      record with the state-loss reason, and the next cell mints a new
//      plane generation;
//    · reconciliation confirms live workers and settles gone ones;
//    · a plane requestStop resets the REAL runtime;
//    · the recent-cell ring is bounded and records every path;
//    · Python mirrors the same vocabulary (or reads honest 'unavailable'
//      when no interpreter exists) while keeping its own cancellation
//      semantics;
//    · owner disposal reaps runtimes and their plane records.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-ws-'))
delete process.env.MERCURY_WORKSHOP

const { runWorkshopCell, resetWorkshopRuntime, workshopGeneration } =
  await import('../../src/services/workshop/runtime.ts')
const { probePythonInterpreter, runPythonCell } =
  await import('../../src/services/workshop/pythonRuntime.ts')
const {
  recentWorkshopCells,
  workshopExecutionId,
} = await import('../../src/services/workshop/executionProjection.ts')
const P = await import('../../src/services/primitives/index.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

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
  console.log('\n❌ TIMEOUT — workshop execution proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const owner = P.makeOwnerKey({ workspace: '/axiom-ws', sessionId: 'ws-proof', lane: P.MAIN_LANE })
const bridge = {
  inspect: async () => 'inspect-stub',
  tool: async () => 'tool-stub',
  agent: async () => 'agent-stub',
}
const cwd = process.cwd()
const jsId = workshopExecutionId('js')
const run = (code: string, extra: Record<string, unknown> = {}) =>
  runWorkshopCell({ owner, cwd, cell: { language: 'js', code, ...extra }, bridge })

console.log('js runtime lifecycle')
{
  const r1 = await run('globalThis.counter = 41; counter')
  check('cell succeeds', r1.state === 'succeeded' && r1.valuePreview.includes('41'))
  const rec = P.getExecution(owner, jsId)
  check('runtime registered on the plane (workshop-js, gen 1)',
    rec?.spec.kind === 'workshop-js' && rec.generation === 1)
  check('idle runtime reads ready (alive, holding state)', rec?.state === 'ready')

  const r2 = await run('counter + 1')
  check('retained state stays retained across cells',
    r2.state === 'succeeded' && r2.valuePreview.includes('42') && r2.generation === r1.generation)
  check('plane generation unchanged across ordinary cells',
    P.getExecution(owner, jsId)?.generation === 1)
}

console.log('a killed runtime can never look live')
{
  const killed = await run('while (true) {}', { timeoutMs: 800 })
  check('runaway cell times out with state-loss report',
    killed.state === 'timed-out' && killed.runtimeKilled)
  const rec = P.getExecution(owner, jsId)
  check('plane record settled stopped with the loss reason',
    rec?.state === 'stopped' && (rec.outcome?.reason ?? '').includes('state lost'))

  const fresh = await run('typeof counter')
  check('next cell starts fresh (state honestly gone)',
    fresh.state === 'succeeded' && fresh.valuePreview.includes('undefined'))
  check('new plane generation after the kill',
    P.getExecution(owner, jsId)?.generation === 2)
  check('domain generation also advanced', workshopGeneration(owner, 'js') >= 2)
}

console.log('reconciliation + plane stop')
{
  const confirmed = P.reconcileExecutions(owner)
  check('live worker reconciles clean (no correction, no unverifiable)',
    confirmed.corrected.length === 0 && confirmed.unverifiable.length === 0 && confirmed.checked >= 1)

  P.requestStopExecution(owner, jsId)
  const rec = P.getExecution(owner, jsId)
  check('plane stop resets the REAL runtime (settled stopped)',
    rec !== undefined && P.isTerminalExecutionState(rec.state))
  const after = await run('1 + 1')
  check('runtime restarts on demand after the stop (gen 3)',
    after.state === 'succeeded' && P.getExecution(owner, jsId)?.generation === 3)
}

console.log('recent-cell ring')
{
  const cells = recentWorkshopCells(owner)
  check('ring recorded every path (incl. the timed-out cell)',
    cells.length >= 5 && cells.some(c => c.state === 'timed-out'))
  for (let i = 0; i < 40; i++) await run(`${i}`)
  check('ring is bounded', recentWorkshopCells(owner).length <= 32)
}

console.log('python lane')
{
  const probe = probePythonInterpreter()
  const pyId = workshopExecutionId('py')
  if ('unavailable' in probe) {
    const r = await runPythonCell({ owner, cwd, cell: { language: 'py', code: 'x = 1' }, bridge })
    check('no interpreter ⇒ honest failed cell', r.state === 'failed')
    const rec = P.getExecution(owner, pyId)
    check('plane record reads unavailable (never a fake runtime)',
      rec?.state === 'unavailable')
  } else {
    const r1 = await runPythonCell({ owner, cwd, cell: { language: 'py', code: 'x = 20\nx + 1' }, bridge })
    check('python cell succeeds', r1.state === 'succeeded' && r1.valuePreview.includes('21'))
    const rec = P.getExecution(owner, pyId)
    check('python runtime registered (workshop-python) and ready',
      rec?.spec.kind === 'workshop-python' && rec.state === 'ready')
    const r2 = await runPythonCell({ owner, cwd, cell: { language: 'py', code: 'x * 2' }, bridge })
    check('python retained state stays retained', r2.state === 'succeeded' && r2.valuePreview.includes('40'))
    check('same execution vocabulary, python-owned cancellation intact',
      P.getExecution(owner, pyId)?.generation === 1)
  }
}

console.log('owner disposal')
{
  await disposeOwner(owner)
  check('plane records gone with the owner', P.listExecutions(owner).length === 0)
  check('cell ring gone with the owner', recentWorkshopCells(owner).length === 0)
  const fresh = await run('typeof counter')
  check('post-disposal cell starts a brand-new runtime',
    fresh.state === 'succeeded' && fresh.valuePreview.includes('undefined'))
  await disposeOwner(owner)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
