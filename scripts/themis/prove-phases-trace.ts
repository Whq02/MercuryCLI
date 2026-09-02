#!/usr/bin/env bun
// prove-phases-trace — the phase state machine's invariants and the DERIVED
// traceability check (set arithmetic over the actual diff, not agent
// self-report).
//
//   §1 phases: ordering · end-without-start · delegation/security/review
//      gates · iteration cap · rollback resets the mandate · all audited.
//   §2 trace: verifyTraceComplete blocks implementation-without-test-trace;
//      scanDiff flags undeclared changed paths mechanically.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { createPhaseMachine } = await import('../../src/substrate/themis/phases.ts')
const { createTraceTable, scanDiff } = await import('../../src/substrate/themis/trace.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const kindOf = (r: { ok: boolean }): string => (r.ok ? 'ok' : (r as { kind: string }).kind)

section('§1 phase machine invariants')
{
  const audited: string[] = []
  const m = createPhaseMachine({
    phases: ['spec', 'design', { name: 'impl', reviewRequired: true }, 'finalize'],
    iterationCap: 3,
    audit: (action, details) => audited.push(`${action}:${details}`),
  })
  check('ordering: cannot start design before spec ended', kindOf(m.start('design')) === 'PHASE_ORDER')
  check('unknown phase named', kindOf(m.start('nope')) === 'UNKNOWN_PHASE')
  check('spec starts', m.start('spec').ok)
  check('cannot start design while spec open', kindOf(m.start('design')) === 'PHASE_ORDER')
  check('end-without-start: design is not open', kindOf(m.end('design')) === 'END_WITHOUT_START')
  check('spec ends', m.end('spec').ok)
  check('design starts after spec', m.start('design').ok)

  // Delegation + security-scan gates.
  m.recordDelegation('design', { id: 'd1', wroteFiles: true, received: false })
  check('unreceipted delegation blocks end', kindOf(m.end('design')) === 'DELEGATION_GATE')
  m.recordDelegation('design', { id: 'd1', wroteFiles: true, received: true })
  check('file-writing delegation arms the scan gate', kindOf(m.end('design')) === 'SECURITY_SCAN_GATE')
  m.recordSecurityScan('design', 'dirty')
  check('dirty scan still blocks', kindOf(m.end('design')) === 'SECURITY_SCAN_GATE')
  m.recordSecurityScan('design', 'clean')
  check('clean scan unblocks', m.end('design').ok)

  // Review gate.
  check('impl starts', m.start('impl').ok)
  check('review required blocks end', kindOf(m.end('impl')) === 'REVIEW_GATE')
  m.recordReview('impl', 'rejected')
  check('rejected review still blocks', kindOf(m.end('impl')) === 'REVIEW_GATE')
  m.recordReview('impl', 'approved')
  check('approved review unblocks', m.end('impl').ok)

  // Iteration cap + rollback reset.
  check('3 iterations pass', m.bumpIteration().ok && m.bumpIteration().ok && m.bumpIteration().ok)
  check('4th iteration capped', kindOf(m.bumpIteration()) === 'ITERATION_CAP')
  check('rollback to impl ok', m.rollbackTo('impl').ok)
  const st = m.state()
  check('rollback reopens impl, keeps earlier ends', !st.ended.includes('impl') && st.ended.includes('design') && st.ended.includes('spec'))
  check('rollback resets the iteration mandate', st.iteration === 0 && m.bumpIteration().ok)
  check('impl restartable after rollback', m.start('impl').ok)
  check('every transition audited', audited.length >= 15, `${audited.length} rows`)
  check('violations audited too', audited.some(a => a.startsWith('phase-violation:')))
}

section('§1b cap clamped to sane bounds')
{
  const m = createPhaseMachine({ phases: ['a'], iterationCap: 99 })
  let n = 0
  while (m.bumpIteration().ok) n++
  check('cap 99 clamps to 5', n === 5, `${n}`)
}

section('§1c ended phases are immutable · rollback target must have started')
{
  const m = createPhaseMachine({ phases: ['a', 'b', 'c'], iterationCap: 3 })
  check('a runs', m.start('a').ok && m.end('a').ok)
  // Post-end record verbs: a file-writing delegation recorded after end would
  // retroactively dodge the scan gate it exists to arm.
  check('post-end delegation refused', kindOf(m.recordDelegation('a', { id: 'x', wroteFiles: true, received: true })) === 'ALREADY_ENDED')
  check('post-end scan refused', kindOf(m.recordSecurityScan('a', 'clean')) === 'ALREADY_ENDED')
  check('post-end review refused', kindOf(m.recordReview('a', 'approved')) === 'ALREADY_ENDED')
  // The free-cap-reset laundering: rollback to the NEXT unstarted phase would
  // wipe nothing yet zero the iteration counter.
  check('cap exhausts', m.bumpIteration().ok && m.bumpIteration().ok && m.bumpIteration().ok && kindOf(m.bumpIteration()) === 'ITERATION_CAP')
  check('rollback to never-started phase refused', kindOf(m.rollbackTo('b')) === 'PHASE_ORDER')
  check('cap STILL exhausted after the refused rollback', kindOf(m.bumpIteration()) === 'ITERATION_CAP')
  check('rollback to a STARTED phase allowed', m.rollbackTo('a').ok)
  check('fresh mandate only after a real rollback', m.bumpIteration().ok)
  const m2 = createPhaseMachine({ phases: ['a', 'b'] })
  check('open phase is a valid rollback target', m2.start('a').ok && m2.rollbackTo('a').ok)
}

section('§2 trace: implementation-without-test-trace blocks')
{
  const t = createTraceTable()
  t.addCriterion('AC-1', 'blocklist denies at the gate')
  t.addCriterion('AC-2', 'audit chain detects deletion')
  t.linkFile('AC-1', 'src/substrate/themis/gate.ts')
  t.linkTest('AC-1', 'scripts/themis/prove-gate-wiring.ts')
  t.linkFile('AC-2', 'src/substrate/themis/auditChain.ts')
  const v = t.verifyTraceComplete()
  check('AC-2 blocked: file but NO test', !v.ok && !v.ok && v.violations.some(x => x.acId === 'AC-2' && x.kind === 'NO_TESTS'), JSON.stringify(v))
  t.linkTest('AC-2', 'scripts/themis/prove-audit-chain.ts')
  check('complete table passes', t.verifyTraceComplete().ok)
  check('unknown AC refuses links', t.linkFile('AC-9', 'x.ts') === false)
  check('declaredFiles unions', t.declaredFiles().length === 2)
}

section('§2b scanDiff: derived, not cooperative')
{
  const r = scanDiff(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src/b.ts', 'src/SNEAKED.ts'])
  check('undeclared change flagged', !r.ok && r.undeclared.join(',') === 'src/SNEAKED.ts')
  const r2 = scanDiff(['./src/a.ts'], ['src\\a.ts'])
  check('path normalization folds ./ and backslashes', r2.ok && r2.missing.length === 0, JSON.stringify(r2))
  const r3 = scanDiff(['src/a.ts', 'src/b.ts'], ['src/a.ts'])
  check('missing is informational, ok stays true', r3.ok && r3.missing.join(',') === 'src/b.ts')
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} PHASES/TRACE PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL PHASES/TRACE PROOFS PASS')
