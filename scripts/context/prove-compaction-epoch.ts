#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-compaction-epoch.ts
//  ORACLE: compaction cleanup is owner/epoch-correct (slice-3 invariants,
//  flipped from the slice-0 fire-and-forget pins).
//
//  Proven here:
//   · runPostCompactCleanup takes an explicit {querySource, owner} scope and
//     the microcompact reset is owner-parameterized (slice-1 fix, re-pinned);
//   · releaseLspDocumentsForContext is AWAITABLE — the close sweep completes
//     before compaction proceeds (both compact call sites await it);
//   · context epochs are owner-scoped, explicit, and monotonic; the epoch
//     guard drops a stale sweep's work;
//   · a degraded semantic summary is RECORDED (capsule state + degraded
//     marker), never a silently-installed empty continuation;
//   · the run continuation capsule carries deterministic facts and is null
//     for a non-substantive conversation.
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-compaction-epoch.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..', '..')
  const ok = await import('../../src/services/run/ownerKey.js')

  section('1. post-compact cleanup is owner/scope-explicit')
  {
    const cleanup = await import('../../src/services/compact/postCompactCleanup.js')
    const mc = await import('../../src/services/compact/microCompact.js')
    const agentOwner = ok.makeOwnerKey({
      workspace: '/tmp/w',
      sessionId: 'sess',
      lane: 'agent:sub1',
    })
    cleanup.runPostCompactCleanup({ querySource: 'agent:general' as never, owner: agentOwner })
    cleanup.runPostCompactCleanup('agent:general' as never)
    cleanup.runPostCompactCleanup()
    check('cleanup accepts {querySource, owner} + legacy shapes', true)
    check(
      'resetMicrocompactState is owner-parameterized',
      mc.resetMicrocompactState.length >= 1,
      `arity ${mc.resetMicrocompactState.length}`,
    )
  }

  section('2. the LSP document release is awaited')
  {
    const { releaseLspDocumentsForContext } = await import('../../src/services/lsp/manager.js')
    const returned = releaseLspDocumentsForContext('proof') as unknown
    check(
      'releaseLspDocumentsForContext returns a Promise (awaitable sweep)',
      returned instanceof Promise,
    )
    check('no-manager release resolves 0', (await (returned as Promise<number>)) === 0)
    const src = readFileSync(join(root, 'src/services/compact/compact.ts'), 'utf8')
    const awaited = src.match(/await releaseLspDocumentsForContext\(/g) ?? []
    const bare = (src.match(/releaseLspDocumentsForContext\(/g) ?? []).length - awaited.length
    check(
      'BOTH compact call sites await the sweep',
      awaited.length === 2 && bare <= 1, // the import line accounts for one bare mention
      `${awaited.length} awaited`,
    )
  }

  section('3. context epochs — owner-scoped, explicit, guarded')
  {
    const epochs = await import('../../src/services/run/contextEpochs.js')
    const A = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ep-A', lane: 'main' })
    const B = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ep-B', lane: 'main' })
    check('fresh owner starts at epoch 0', epochs.getContextEpoch(A).epoch === 0)
    const e1 = epochs.advanceContextEpoch(A, {
      kind: 'auto-compact',
      reason: 'threshold',
      tokensBefore: 180_000,
      tokensAfter: 30_000,
      preservedTailCount: 12,
      capsule: { state: 'installed', reason: 'summary + capsule' },
    })
    check('advance is monotonic', e1 === 1 && epochs.getContextEpoch(A).epoch === 1)
    check("B's epoch is untouched by A's compaction", epochs.getContextEpoch(B).epoch === 0)
    check(
      'the transition records honest token deltas',
      epochs.getContextEpoch(A).lastTransition?.tokensBefore === 180_000 &&
        epochs.getContextEpoch(A).lastTransition?.tokensAfter === 30_000,
    )
    // The epoch guard: a sweep that captured epoch 1 must not run once the
    // owner is at epoch 2 (a document reopened in the newer epoch survives).
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
    check('a stale sweep (older epoch) is dropped', !staleRan)
    check('a current-epoch sweep runs', currentRan)
    // Degraded capsule verdicts are recorded, never silent.
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
    )
  }

  section('4. the deterministic run capsule')
  {
    const ok2 = await import('../../src/services/run/ownerKey.js')
    const coordinator = await import('../../src/services/run/runCoordinator.js')
    const capsuleMod = await import('../../src/services/run/runContinuationCapsule.js')
    const owner = ok2.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'cap', lane: 'main' })
    check(
      'no run ⇒ null capsule (lightweight conversations compact as before)',
      capsuleMod.buildRunContinuationCapsule(owner) === null,
    )
    coordinator.acceptUserRequest(owner, { objective: 'build the compiler', rootMessageId: 'u1' })
    check(
      'a non-substantive run still yields null (no run chrome for Q&A)',
      capsuleMod.buildRunContinuationCapsule(owner) === null,
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
    check('capsule exists for a substantive run', capsule !== null)
    check('capsule carries the objective', capsule!.includes('build the compiler'))
    check('capsule lists the open deliverable', capsule!.includes('write the parser'))
    check('capsule records the failed attempt', /lsp\.rename\.apply: failed/.test(capsule!))
    check('capsule references re-readable files (no contents pasted)', capsule!.includes('/tmp/w/a.ts'))
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
