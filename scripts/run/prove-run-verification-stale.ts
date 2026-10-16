#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const ok = await import('../../src/services/run/ownerKey.js')
  const kernel = await import('../../src/services/run/runKernel.js')
  type Ev = Parameters<typeof kernel.reduceRunEvent>[1]

  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'run-stale', lane: 'main' })
  const base = () =>
    kernel.emptyRunSnapshot({ runId: 'r-stale', owner, objective: 'fix the parser', rootMessageId: 'u1', at: 1 })
  const fold = (events: Ev[]) => events.reduce((s, e) => kernel.reduceRunEvent(s, e), base())

  const green: Ev = { type: 'evidence', at: 10, state: 'verified', detail: 'bun test green (just now)' }
  const edit = (at: number, paths: string[], outcome: 'succeeded' | 'failed' | 'indeterminate' | 'no-change' = 'succeeded'): Ev => ({
    type: 'tool-effected',
    at,
    toolName: 'Edit',
    toolUseId: `t${at}`,
    operation: 'edit',
    outcome,
    changedPaths: paths,
  })
  const read = (at: number): Ev => ({
    type: 'tool-effected',
    at,
    toolName: 'Read',
    toolUseId: `t${at}`,
    operation: 'read',
    outcome: 'no-change',
    changedPaths: [],
  })

  section('1. a file changed after the last green test turns the verification stale')
  {
    const snap = fold([{ type: 'substantive', at: 2, reason: 'edit' }, green, edit(20, ['src/parser.ts'])])
    check('verified → stale after a succeeded mutating effect with changed paths', snap.verification.state === 'stale', snap.verification.state)
    check('the detail says files changed after the verification', /after the last verification/.test(snap.verification.detail), snap.verification.detail)
    check('the detail counts the changed files', /\b1 file/.test(snap.verification.detail), snap.verification.detail)
    check('the changed path still folds into changedPaths', snap.changedPaths.includes('src/parser.ts'))
    const two = fold([green, edit(20, ['a.ts', 'b.ts'])])
    check('two paths read as 2 files', /\b2 files?\b/.test(two.verification.detail), two.verification.detail)
  }

  section('2. what does not turn it stale')
  {
    const afterRead = fold([green, read(20)])
    check('a read after the green test keeps verified', afterRead.verification.state === 'verified', afterRead.verification.state)
    const failedEdit = fold([green, edit(20, [], 'failed')])
    check('a failed edit that changed nothing keeps verified (unresolvedBadEffects carries it)', failedEdit.verification.state === 'verified' && failedEdit.unresolvedBadEffects === 1, `${failedEdit.verification.state}/${failedEdit.unresolvedBadEffects}`)
    const noChange = fold([green, edit(20, [], 'no-change')])
    check('a no-change edit keeps verified', noChange.verification.state === 'verified', noChange.verification.state)
    const unverified = fold([edit(20, ['x.ts'])])
    check('unverified stays unverified (nothing to go stale from)', unverified.verification.state === 'unverified', unverified.verification.state)
    const failedTests = fold([{ type: 'evidence', at: 10, state: 'failed', detail: 'bun test FAILED' }, edit(20, ['x.ts'])])
    check('a failed test stays failed, never relabelled stale', failedTests.verification.state === 'failed', failedTests.verification.state)
    const alreadyStale = fold([green, edit(20, ['a.ts']), edit(30, ['b.ts'])])
    check('stale stays stale across further edits', alreadyStale.verification.state === 'stale', alreadyStale.verification.state)
  }

  section('3. a new green test restores verified; the next edit goes stale again')
  {
    const snap = fold([green, edit(20, ['a.ts']), { type: 'evidence', at: 30, state: 'verified', detail: 'bun test green (just now)' }])
    check('evidence verified after the edit → verified', snap.verification.state === 'verified', snap.verification.state)
    const again = kernel.reduceRunEvent(snap, edit(40, ['a.ts']))
    check('the following edit → stale again', again.verification.state === 'stale', again.verification.state)
  }

  section('4. the continuation capsule and the inspector read the stale state')
  {
    const coordinator = await import('../../src/services/run/runCoordinator.js')
    const { buildRunContinuationCapsule } = await import('../../src/services/run/runContinuationCapsule.js')
    const { buildRunRows } = await import('../../src/commands/run/runInspectorModel.js')
    const liveOwner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'run-stale-live', lane: 'agent:stale' })
    coordinator.acceptUserRequest(liveOwner, { objective: 'fix the parser', rootMessageId: 'u1' })
    coordinator.noteRunEvent(liveOwner, { type: 'substantive', at: 2, reason: 'edit' })
    coordinator.noteRunEvent(liveOwner, green)
    const before = buildRunContinuationCapsule(liveOwner) ?? ''
    check('before the edit the capsule reads verified', /Verification: verified/.test(before), before.split('\n').find(l => l.startsWith('Verification')) ?? '(no line)')
    coordinator.noteRunEvent(liveOwner, edit(20, ['src/parser.ts']))
    const after = buildRunContinuationCapsule(liveOwner) ?? ''
    const line = after.split('\n').find(l => l.startsWith('Verification')) ?? '(no line)'
    check('after the edit the capsule reads stale', /Verification: stale/.test(after), line)
    check('the capsule names the changed-after-verification gap', /after the last verification/.test(line), line)
    const snap = coordinator.getRunSnapshot(liveOwner)
    const rows = snap ? buildRunRows(snap, Date.now()) : []
    const vRow = rows.find(r => /stale/.test(r.line))
    check('the /run inspector row carries the stale state', vRow !== undefined, JSON.stringify(rows.map(r => r.line)))
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-run-verification-stale (${failures} failure(s))`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})
