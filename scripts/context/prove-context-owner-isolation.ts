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
  const A = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-A', lane: 'main' })
  const B = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'conv-B', lane: 'main' })

  section('1. live context usage is owner-addressed')
  {
    const live = await import('../../src/screen/cockpit-gauges/contextUsageLive.js')
    live.publishContextUsage(40, 200_000, 90, A)
    live.publishContextUsage(42, 200_000, 90, B)
    check('owner A reads its own 40%', live.getLiveContextUsage(A).usedPct === 40, '', 'publishContextUsage and getLiveContextUsage in src/screen/cockpit-gauges/contextUsageLive.ts must store and read usage per owner')
    check('owner B reads its own 42%', live.getLiveContextUsage(B).usedPct === 42, '', 'publishContextUsage and getLiveContextUsage in src/screen/cockpit-gauges/contextUsageLive.ts must store and read usage per owner')
    live.publishContextUsage(55, 200_000, 90)
    check(
      'the default main slot is its own owner',
      live.getLiveContextUsage().usedPct === 55 && live.getLiveContextUsage(A).usedPct === 40,
      '',
      'publishContextUsage in src/screen/cockpit-gauges/contextUsageLive.ts must keep the call without an owner in its own main slot, apart from owner A',
    )
  }

  section('2. forecast growth histories are independent at similar usage')
  {
    const fc = await import('../../src/screen/cockpit-gauges/ctxForecast.js')
    fc.resetCtxForecastForTest()
    fc.recordCtxSample(40, A)
    fc.noteCtxTurnBoundary(A)
    fc.recordCtxSample(42, A)
    fc.noteCtxTurnBoundary(A)
    fc.recordCtxSample(44, A)
    fc.noteCtxTurnBoundary(A)
    fc.recordCtxSample(43, B)
    fc.noteCtxTurnBoundary(B)
    const estA = fc.estimateTurnsToFold(44, 90, A)
    const estB = fc.estimateTurnsToFold(43, 90, B)
    check('owner A has a real estimate from its own turns', estA !== null, `A=${estA}`, 'estimateTurnsToCompact in src/screen/cockpit-gauges/ctxForecast.ts must estimate from the turns recorded for that owner')
    check(
      'owner B honestly reads null (zero completed turns of its own)',
      estB === null,
      `B=${estB}`,
      'estimateTurnsToCompact in src/screen/cockpit-gauges/ctxForecast.ts must return null for an owner with no completed turns of its own, not use another owner history',
    )
    fc.recordCtxSample(80, B)
    fc.noteCtxTurnBoundary(B)
    check(
      "B's growth does not change A's estimate",
      fc.estimateTurnsToFold(44, 90, A) === estA,
      '',
      'recordCtxSample and noteCtxTurnBoundary in src/screen/cockpit-gauges/ctxForecast.ts must keep a separate growth history per owner',
    )
    fc.resetCtxForecastForTest()
  }

  section('3. owner-scoped context epochs exist and isolate (slice 3)')
  {
    const epochs = await import('../../src/engine/run/contextEpochs.js')
    const eA = epochs.advanceContextEpoch(A, {
      kind: 'auto-compact',
      reason: 'proof',
      tokensBefore: null,
      tokensAfter: null,
      preservedTailCount: null,
    })
    check('A advanced to epoch 1', eA === 1, '', 'advanceContextEpoch in src/engine/run/contextEpochs.ts must raise the first epoch of an owner to 1')
    check("B's epoch stays 0 (owner isolation)", epochs.getContextEpoch(B).epoch === 0, '', 'advanceContextEpoch in src/engine/run/contextEpochs.ts must key the epoch by the whole owner, so owner A compacting leaves owner B at 0')
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
