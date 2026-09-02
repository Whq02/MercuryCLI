#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-context-owner-isolation.ts
//  ORACLE: per-conversation context state (live usage, growth forecast,
//  compaction trigger hysteresis) must be owner-scoped — two conversations in
//  one process at similar usage keep independent forecasts and epochs.
//
//  SLICE-1 INVARIANTS (usage + forecast owner isolation — flipped from the
//  slice-0 FAILURE-CLASS pins in the fixing commit). The context-EPOCH
//  module pin (section 3) stays until lands it.
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-context-owner-isolation.ts
// ============================================================================

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
  const A = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-A', lane: 'main' })
  const B = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-B', lane: 'main' })

  section('1. live context usage is owner-addressed')
  {
    const live = await import('../../src/utils/cockpit/contextUsageLive.js')
    live.publishContextUsage(40, 200_000, 90, A)
    live.publishContextUsage(42, 200_000, 90, B)
    check('owner A reads its own 40%', live.getLiveContextUsage(A).usedPct === 40)
    check('owner B reads its own 42%', live.getLiveContextUsage(B).usedPct === 42)
    // Default-owner callers (MercuryFrame, DeckPane) share the MAIN slot and
    // never collide with explicit owners.
    live.publishContextUsage(55, 200_000, 90)
    check(
      'the default main slot is its own owner',
      live.getLiveContextUsage().usedPct === 55 && live.getLiveContextUsage(A).usedPct === 40,
    )
  }

  section('2. forecast growth histories are independent at similar usage')
  {
    const fc = await import('../../src/utils/cockpit/ctxForecast.js')
    fc.resetCtxForecastForTest()
    // Conversation A: three turns of ~2-point appetite (40→42→44).
    fc.recordCtxSample(40, A)
    fc.noteCtxTurnBoundary(A)
    fc.recordCtxSample(42, A)
    fc.noteCtxTurnBoundary(A)
    fc.recordCtxSample(44, A)
    fc.noteCtxTurnBoundary(A)
    // Conversation B arrives at SIMILAR usage (43%) — the pre-slice-1
    // singleton merged histories here; owners must not.
    fc.recordCtxSample(43, B)
    fc.noteCtxTurnBoundary(B)
    const estA = fc.estimateTurnsToCompact(44, 90, A)
    const estB = fc.estimateTurnsToCompact(43, 90, B)
    check('owner A has a real estimate from its own turns', estA !== null, `A=${estA}`)
    check(
      'owner B honestly reads null (zero completed turns of its own)',
      estB === null,
      `B=${estB}`,
    )
    // B's samples never perturb A's trend.
    fc.recordCtxSample(80, B)
    fc.noteCtxTurnBoundary(B)
    check(
      "B's growth does not change A's estimate",
      fc.estimateTurnsToCompact(44, 90, A) === estA,
    )
    fc.resetCtxForecastForTest()
  }

  section('3. owner-scoped context epochs exist and isolate (slice 3)')
  {
    const epochs = await import('../../src/services/run/contextEpochs.js')
    const eA = epochs.advanceContextEpoch(A, {
      kind: 'auto-compact',
      reason: 'proof',
      tokensBefore: null,
      tokensAfter: null,
      preservedTailCount: null,
    })
    check('A advanced to epoch 1', eA === 1)
    check("B's epoch stays 0 (owner isolation)", epochs.getContextEpoch(B).epoch === 0)
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
