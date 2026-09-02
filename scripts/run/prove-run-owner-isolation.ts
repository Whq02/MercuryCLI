#!/usr/bin/env bun
// ============================================================================
//  scripts/run/prove-run-owner-isolation.ts
//  ORACLE: two conversations in one process must not share mutable run state
//  (verification mutation ordering, stop-hook engagement).
//
//  SLICE-1 INVARIANTS (flipped from the slice-0 FAILURE-CLASS pins in the
//  same commit that fixed them): verification state is keyed by the
//  canonical OwnerKey; dungeon-seat engagement is per-session; owner
//  disposal returns every registry to baseline (400-cycle leak proof).
//
//  Run:  ~/.bun/bin/bun run scripts/run/prove-run-owner-isolation.ts
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const tmp = mkdtempSync(join(tmpdir(), 'run-owner-'))
  process.env.MERCURY_VERIFY_EVIDENCE = '1'

  section('0. the canonical owner key')
  {
    const ok = await import('../../src/services/run/ownerKey.js')
    const id = {
      workspace: '/tmp/w s|pipe',
      sessionId: 'sess|A',
      lane: 'agent:x',
      querySource: 'sdk',
    }
    const key = ok.makeOwnerKey(id)
    check('round-trips through the canonical serializer', JSON.stringify(ok.parseOwnerKey(key)) === JSON.stringify(id))
    check('pipe characters cannot forge a boundary', ok.isOwnerKey(key) && key.split('|').length === 5)
    check(
      'distinct lanes make distinct keys',
      ok.makeOwnerKey({ ...id, lane: 'main' }) !== key,
    )
    check(
      'equality is canonical',
      ok.ownerEquals(ok.makeOwnerKey(id), key) === true,
    )
    check('file stem is filesystem-safe', /^[a-zA-Z0-9_-]+$/.test(ok.ownerKeyFileStem(key)))
  }

  section('1. verification state is owner-addressed')
  {
    const ok = await import('../../src/services/run/ownerKey.js')
    const v = await import('../../src/utils/verification/verificationState.js')
    const a = ok.makeOwnerKey({ workspace: tmp, sessionId: 'sess-A', lane: 'main' })
    const b = ok.makeOwnerKey({ workspace: tmp, sessionId: 'sess-B', lane: 'main' })
    v._resetVerificationStateForTesting()
    v.markMutation(a)
    const seenByA = v.verificationSummary(tmp, { skipDigest: true, owner: a })
    const seenByB = v.verificationSummary(tmp, { skipDigest: true, owner: b })
    check('owner A sees its own mutation', seenByA.mutationsSinceEvidence === 1)
    check(
      "owner A's mutation is INVISIBLE to owner B",
      seenByB.mutationsSinceEvidence === 0,
      `B sees ${seenByB.mutationsSinceEvidence}`,
    )
    v.recordEvidence(
      tmp,
      { command: 'bun run scripts/x/prove-y.ts', ok: true, scope: 'proof', coverage: 'prove-y.ts' },
      b,
    )
    const aAfterB = v.verificationSummary(tmp, { skipDigest: true, owner: a })
    check(
      "owner B's evidence does NOT satisfy owner A's mutation",
      aAfterB.state !== 'verified' && aAfterB.mutationsSinceEvidence === 1,
      `A state=${aAfterB.state}`,
    )
    v.disposeVerificationOwner(a)
    v.disposeVerificationOwner(b)
    check(
      'disposal drains the verification registry',
      v._verificationOwnerCountForTesting() === 0,
      `count=${v._verificationOwnerCountForTesting()}`,
    )
  }

  // (§2, the dungeon-seat per-session engagement law, retired with the seat
  //  hook — the multiplayer estate's C10 residue.)

  section('3. owner lifecycle: 400 create/dispose cycles return to baseline')
  {
    const ok = await import('../../src/services/run/ownerKey.js')
    const lifecycle = await import('../../src/services/run/ownerLifecycle.js')
    const v = await import('../../src/utils/verification/verificationState.js')
    const fc = await import('../../src/utils/cockpit/ctxForecast.js')
    const live = await import('../../src/utils/cockpit/contextUsageLive.js')
    v._resetVerificationStateForTesting()
    fc.resetCtxForecastForTest()
    for (let i = 0; i < 400; i++) {
      const o = ok.makeOwnerKey({ workspace: tmp, sessionId: `cycle-${i}`, lane: 'main' })
      v.markMutation(o)
      fc.recordCtxSample(10 + (i % 5), o)
      live.publishContextUsage(10 + (i % 5), 200_000, 90, o)
      let adhocRan = false
      lifecycle.registerOwnerDisposer(o, 'probe', () => {
        adhocRan = true
      })
      await lifecycle.disposeOwner(o)
      if (!adhocRan) {
        check('ad-hoc disposer ran', false, `cycle ${i}`)
        break
      }
    }
    const counts = lifecycle.ownerLifecycleCounts()
    check(
      'every registry at baseline after 400 cycles',
      Object.values(counts.stores).every(n => n === 0) && counts.adhoc === 0,
      JSON.stringify(counts),
    )
  }

  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
