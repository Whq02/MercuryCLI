#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const ok = await import('../../src/engine/run-owner/ownerKey.js')

  section('1. post-compact cleanup is owner/scope-explicit')
  {
    const cleanup = await import('../../src/engine/compaction/postFoldCleanup.js')
    const mc = await import('../../src/engine/compaction/pruneToolResults.js')
    const agentOwner = ok.makeOwnerKey({
      workspace: '/tmp/w',
      sessionId: 'sess',
      lane: 'agent:sub1',
    })
    cleanup.runPostFoldCleanup({ querySource: 'agent:general' as never, owner: agentOwner })
    cleanup.runPostFoldCleanup('agent:general' as never)
    cleanup.runPostFoldCleanup()
    check('cleanup accepts {querySource, owner} + legacy shapes', true)
    check(
      'resetMicrocompactState is owner-parameterized',
      mc.resetPruneState.length >= 1,
      `arity ${mc.resetPruneState.length}`,
      'resetMicrocompactState in src/engine/compaction/pruneToolResults.ts must declare an owner parameter',
    )
  }

  section('2. the LSP document release is awaited')
  {
    const { releaseLspDocumentsForContext } = await import('../../src/integrations/lsp/serverManagerLifecycle.js')
    const returned = releaseLspDocumentsForContext('proof') as unknown
    check(
      'releaseLspDocumentsForContext returns a Promise (awaitable sweep)',
      returned instanceof Promise,
      '',
      'releaseLspDocumentsForContext in src/integrations/lsp/serverManagerLifecycle.ts must return its promise so callers can await the sweep',
    )
    check('no-manager release resolves 0', (await (returned as Promise<number>)) === 0, '', 'releaseLspDocumentsForContext in src/integrations/lsp/serverManagerLifecycle.ts must resolve 0 when no manager is running')
  }

  section('3. context epochs — owner-scoped, explicit, guarded')
  {
    const epochs = await import('../../src/engine/run/contextEpochs.js')
    const A = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ep-A', lane: 'main' })
    const B = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ep-B', lane: 'main' })
    check('fresh owner starts at epoch 0', epochs.getContextEpoch(A).epoch === 0, '', 'getContextEpoch in src/engine/run/contextEpochs.ts must give an owner with no compaction epoch 0')
    const e1 = epochs.advanceContextEpoch(A, {
      kind: 'auto-compact',
      reason: 'threshold',
      tokensBefore: 180_000,
      tokensAfter: 30_000,
      preservedTailCount: 12,
      capsule: { state: 'installed', reason: 'summary + capsule' },
    })
    check('advance is monotonic', e1 === 1 && epochs.getContextEpoch(A).epoch === 1, '', 'advanceContextEpoch in src/engine/run/contextEpochs.ts must raise the owner epoch by one and return the new epoch')
    check("B's epoch is untouched by A's compaction", epochs.getContextEpoch(B).epoch === 0, '', 'advanceContextEpoch in src/engine/run/contextEpochs.ts must key the epoch by the whole owner, so one owner compacting leaves another at 0')
    check(
      'the transition records honest token deltas',
      epochs.getContextEpoch(A).lastTransition?.tokensBefore === 180_000 &&
        epochs.getContextEpoch(A).lastTransition?.tokensAfter === 30_000,
      '',
      'advanceContextEpoch in src/engine/run/contextEpochs.ts must store tokensBefore and tokensAfter on lastTransition as given',
    )
    let staleRan = false
    let currentRan = false
    epochs.advanceContextEpoch(A, {
      kind: 'manual-compact',
      reason: 'operator',
      tokensBefore: null,
      tokensAfter: null,
      preservedTailCount: null,
    })
    epochs.ifEpochCurrent(A, 1, () => {
      staleRan = true
    })
    epochs.ifEpochCurrent(A, 2, () => {
      currentRan = true
    })
    check('a stale sweep (older epoch) is dropped', !staleRan, '', 'ifEpochCurrent in src/engine/run/contextEpochs.ts must skip the callback when the captured epoch is older than the owner epoch')
    check('a current-epoch sweep runs', currentRan, '', 'ifEpochCurrent in src/engine/run/contextEpochs.ts must run the callback when the captured epoch equals the owner epoch')
    epochs.advanceContextEpoch(A, {
      kind: 'auto-compact',
      reason: 'threshold',
      tokensBefore: null,
      tokensAfter: null,
      preservedTailCount: null,
      capsule: { state: 'degraded', reason: 'semantic summary under 80 chars' },
    })
    const state = epochs.getContextEpoch(A)
    check(
      'a degraded continuation is marked on the epoch record',
      state.capsule.state === 'degraded' && state.degraded.length > 0,
      '',
      'advanceContextEpoch in src/engine/run/contextEpochs.ts must record a degraded capsule state and a degraded entry on the epoch record',
    )
  }

  section('4. the deterministic run capsule')
  {
    const ok2 = await import('../../src/engine/run-owner/ownerKey.js')
    const coordinator = await import('../../src/engine/run/runCoordinator.js')
    const capsuleMod = await import('../../src/engine/run/runContinuationCapsule.js')
    const owner = ok2.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'cap', lane: 'main' })
    check(
      'no run ⇒ null capsule (lightweight conversations compact as before)',
      capsuleMod.buildRunContinuationCapsule(owner) === null,
      '',
      'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must return null for an owner with no run',
    )
    coordinator.acceptUserRequest(owner, { objective: 'build the compiler', rootMessageId: 'u1' })
    check(
      'a non-substantive run still yields null (no run chrome for Q&A)',
      capsuleMod.buildRunContinuationCapsule(owner) === null,
      '',
      'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must return null until the run has a substantive event',
    )
    coordinator.noteRunEvent(owner, { type: 'substantive', at: 2, reason: 'edits landed' })
    coordinator.noteRunEvent(owner, {
      type: 'task-transition',
      at: 3,
      taskId: 't1',
      title: 'write the parser',
      state: 'open',
    })
    coordinator.noteRunEvent(owner, {
      type: 'tool-effected',
      at: 4,
      toolName: 'LSP',
      toolUseId: 'tu1',
      operation: 'lsp.rename.apply',
      outcome: 'failed',
      changedPaths: [],
    })
    const capsule = capsuleMod.buildRunContinuationCapsule(owner, ['/tmp/w/a.ts', '/tmp/w/b.ts'])
    check('capsule exists for a substantive run', capsule !== null, '', 'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must return a capsule once the run has a substantive event')
    check('capsule carries the objective', capsule!.includes('build the compiler'), '', 'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must include the run objective')
    check('capsule lists the open deliverable', capsule!.includes('write the parser'), '', 'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must list open task titles')
    check('capsule records the failed attempt', /lsp\.rename\.apply: failed/.test(capsule!), '', 'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must record a failed tool effect as operation: outcome')
    check('capsule references re-readable files (no contents pasted)', capsule!.includes('/tmp/w/a.ts'), '', 'buildRunContinuationCapsule in src/engine/run/runContinuationCapsule.ts must list the file paths it is given')
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
