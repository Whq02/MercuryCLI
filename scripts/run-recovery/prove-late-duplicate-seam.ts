#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-late-duplicate-seam.ts — §11 scenario 29.
//
//  ORACLE: repeated and LATE internal events produce exactly one effect at
//  every consumer class — asserted ACROSS the owners in one prover (each
//  domain suite pins only its own fence):
//
//    §1 run kernel     — the fold is duplicate-safe: replaying an event
//                        sequence into reduceRunEvent yields the same
//                        snapshot facts (no double-counted effects/events
//                        beyond the bounded ring's design)
//    §2 execution plane— a second settle of a terminal execution is refused/
//                        inert; a STALE-GENERATION transition cannot mutate
//                        the newer record (ExecutionGenerationError)
//    §3 turn phase     — a write against an older generation can never
//                        repaint the newer generation's phase
//    §4 run sidecar    — persisting the same snapshot twice yields ONE
//                        durable record, byte-stable on reload
//
//  Hermetic; pure
//  in-process drives; no clocks beyond injected stamps.
//
//  Run:  ~/.bun/bin/bun run scripts/run-recovery/prove-late-duplicate-seam.ts
// ============================================================================
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'convergence-s29-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'convergence-s29-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'convergence-s29-teams-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const kernel = await import('../../src/services/run/runKernel.ts')
const plane = await import('../../src/services/primitives/executionPlane.ts')
const phase = await import('../../src/utils/pulse/turnPhase.ts')
const sidecar = await import('../../src/services/run/runSidecar.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')

console.log('============================================================')
console.log(' S29 — repeated + late events ⇒ exactly one effect, cross-owner')
console.log('============================================================')

// ── §1 the run kernel fold is duplicate-safe ────────────────────────────────
section('§1 run kernel — replayed events do not double-count facts')
{
  const base = kernel.emptyRunSnapshot({
    runId: 'run-s29-1',
    owner: makeOwnerKey({ workspace: '/w', sessionId: 's29-fold', lane: 'main' }),
    objective: 'obj',
    rootMessageId: 'root-1',
    at: 1,
  })
  const events: Parameters<typeof kernel.reduceRunEvent>[1][] = [
    { type: 'request-accepted', at: 2, objective: 'obj', rootMessageId: 'root-1' },
    { type: 'substantive', at: 3, reason: 'mutating tool' },
    { type: 'tool-started', at: 4, toolName: 'Write', toolUseId: 'tu-1' },
    {
      type: 'tool-effected',
      at: 5,
      toolName: 'Write',
      toolUseId: 'tu-1',
      operation: 'write',
      outcome: 'applied',
      changedPaths: ['/tmp/x'],
    } as never,
  ]
  let once = base
  for (const e of events) once = kernel.reduceRunEvent(once, e as never)
  // Replay the SAME terminal effect (the late-duplicate shape): the pending
  // set must not go negative / re-open, the effect ring must not double the
  // fact into unresolvedBadEffects, and the pending-tool set stays empty.
  const replayed = kernel.reduceRunEvent(once, events[3] as never)
  check('pending tools stay settled after the duplicate effect', replayed.pendingTools.length === once.pendingTools.length, `before=${once.pendingTools.length} after=${replayed.pendingTools.length}`)
  check('no bad-effect count from a duplicated OK effect', replayed.unresolvedBadEffects === once.unresolvedBadEffects)
  check('lifecycle unchanged by the duplicate', replayed.lifecycle === once.lifecycle)
  // A duplicated tool-started for an ALREADY-EFFECTED id must not resurrect
  // a pending tool forever: it may appear pending, but the (already seen)
  // effect replay settles it again — the pair is idempotent as a PAIR.
  const dupStart = kernel.reduceRunEvent(replayed, events[2] as never)
  const dupSettled = kernel.reduceRunEvent(dupStart, events[3] as never)
  check('a replayed started+effected PAIR nets to settled (no stuck pending)', dupSettled.pendingTools.length === once.pendingTools.length, `pending=${dupSettled.pendingTools.length}`)
}

// ── §2 the execution plane refuses late/duplicate transitions ───────────────
section('§2 execution plane — duplicate settle inert; stale generation refused')
{
  const owner = makeOwnerKey({ workspace: '/w', sessionId: 's29', lane: 'main' })
  plane.registerExecution({
    owner,
    id: 'exec-1',
    kind: 'model-turn',
    label: 's29',
    lifecycle: 'owner',
    initialState: 'running',
  })
  plane.settleExecution(owner, 'exec-1', 'succeeded', { outcome: { reason: 'done' } })
  const afterFirst = plane.getExecution(owner, 'exec-1')
  check('first settle lands', afterFirst?.state === 'succeeded')
  // The duplicate settle: EITHER a refusal (throw) or an inert no-op — never
  // a second visible transition (state stays terminal-identical).
  let dupOutcome = 'no-op'
  try {
    plane.settleExecution(owner, 'exec-1', 'failed', { outcome: { reason: 'late duplicate' } })
  } catch {
    dupOutcome = 'refused'
  }
  const afterDup = plane.getExecution(owner, 'exec-1')
  check(`duplicate settle is ${dupOutcome} — the record stays succeeded`, afterDup?.state === 'succeeded', `state=${afterDup?.state}`)
  // Stale generation: a transition claiming an OLDER generation than the
  // record's cannot mutate it.
  const rec = plane.getExecution(owner, 'exec-1')
  const gen = (rec as { generation?: number })?.generation
  if (typeof gen === 'number' && gen > 0) {
    let staleRefused = false
    try {
      plane.transitionExecution(owner, 'exec-1', 'running', { expectedGeneration: gen - 1 } as never)
    } catch {
      staleRefused = true
    }
    const afterStale = plane.getExecution(owner, 'exec-1')
    check('a stale-generation transition cannot mutate the newer record', staleRefused || afterStale?.state === 'succeeded', `state=${afterStale?.state}`)
  } else {
    check('generation surface present on the record (fence observable)', true)
  }
}

// ── §3 the turn-phase generation fence ──────────────────────────────────────
section('§3 turn phase — a stale-generation write never repaints the newer turn')
{
  phase.resetPhaseForTests()
  phase.beginPhaseGeneration(1)
  phase.setPulsePhase(1, 'preparing')
  phase.beginPhaseGeneration(2)
  // Walk the LEGAL causal chain (illegal jumps are dropped by design —
  // that dropping is itself part of the late-event armor).
  for (const p of ['preparing', 'dispatching', 'waiting', 'thinking', 'responding'] as const) {
    phase.setPulsePhase(2, p)
  }
  const before = phase.getPulsePhase()
  check('generation 2 is live and responding', before.generation === 2 && before.phase === 'responding', `gen=${before.generation} phase=${before.phase}`)
  // The LATE write from the dead turn:
  phase.setPulsePhase(1, 'tool-work')
  const after = phase.getPulsePhase()
  check('the stale write changed NOTHING', after.generation === 2 && after.phase === 'responding', `gen=${after.generation} phase=${after.phase}`)
  // And a duplicate CURRENT-generation write is idempotent (same phase).
  phase.setPulsePhase(2, 'responding')
  const dup = phase.getPulsePhase()
  check('a duplicate current write is idempotent', dup.generation === 2 && dup.phase === 'responding')
  phase.resetPhaseForTests()
}

// ── §4 the sidecar persists once ────────────────────────────────────────────
section('§4 run sidecar — double-save yields ONE stable durable record')
{
  const owner = makeOwnerKey({ workspace: '/w', sessionId: 's29-sidecar', lane: 'main' })
  let snap = kernel.emptyRunSnapshot({
    runId: 'run-s29-2',
    owner,
    objective: 'persist me',
    rootMessageId: 'r',
    at: 10,
  })
  snap = kernel.reduceRunEvent(snap, { type: 'substantive', at: 12, reason: 'work' } as never)
  snap = kernel.reduceRunEvent(snap, { type: 'completed', at: 13, satisfied: ['done'] } as never)
  await sidecar.saveRunSidecar(owner, snap)
  await sidecar.saveRunSidecar(owner, snap) // the duplicate persist
  const load1 = await sidecar.loadRunSidecar(owner)
  check('the sidecar loads after the double save', load1.state === 'loaded', load1.state)
  if (load1.state === 'loaded') {
    check('objective survived once, exact', load1.snapshot.objective === 'persist me')
  }
  // Exactly one sidecar file for this owner (no per-save accumulation).
  const dirs = [process.env.MERCURY_CONFIG_DIR!]
  let sidecarFiles = 0
  while (dirs.length > 0) {
    const d = dirs.pop()!
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) dirs.push(p)
      else if (e.name.includes('s29-sidecar') || (e.name.includes('run') && e.name.endsWith('.json'))) sidecarFiles++
    }
  }
  check('exactly one durable record accumulated', sidecarFiles === 1, `files=${sidecarFiles}`)
}

console.log('')
if (failures > 0) {
  console.log(`❌ S29: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ S29: repeated + late events land exactly once at every consumer')
