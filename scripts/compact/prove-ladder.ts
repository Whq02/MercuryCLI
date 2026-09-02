#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-ladder.ts — the typed maintenance ladder (spec
//  07-C1): walk order, applied/advanced verdicts, the no-op-advance law,
//  the overflow-skips-handoff law, and the gate wiring.
//
//    §A the walk — default order digest→notes→handoff→summary; each rung's
//       verdict is typed; the first application wins and the steps record
//       the whole walk
//    §B the laws — digest never double-applies (measured advance); overflow
//       always advances past handoff; an absent handoff runner advances
//       typed (the C2 drop-in seam); notes' null answer advances (its
//       no-failure-handler contract untouched)
//    §C exhaustion — an order without summary that applies nothing reports
//       'exhausted' with the full typed trail (never a loop)
//    §D the gate — autoCompactIfNeeded consults the ladder ONLY under
//       MERCURY_COMPACT_LADDER; the registry carries the row (structural)
//
//  Hermetic: injectable rung runners; no model call, no config home.
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-ladder.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const ladder = await import('../../src/services/compact/maintenanceLadder.ts')
type LadderInput = import('../../src/services/compact/maintenanceLadder.ts').LadderInput
type CompactionResult = import('../../src/services/compact/compact.ts').CompactionResult

const RESULT = { boundaryMarker: {}, summaryMessages: [], attachments: [], hookResults: [], preCompactTokenCount: 100, postCompactTokenCount: 10 } as unknown as CompactionResult
const INPUT: LadderInput = {
  messages: [],
  toolUseContext: { agentId: undefined } as never,
  cacheSafeParams: {} as never,
  querySource: 'test',
  recompactionInfo: { isRecompaction: false, turnsSincePreviousCompact: -1, autoCompactThreshold: 100_000, querySource: 'test' } as never,
}

// ============================================================================
section('§A the walk — order, typed verdicts, first application wins')
// ============================================================================
{
  const out = await ladder.runMaintenanceLadder(INPUT, undefined, {
    digestProjection: () => null,
    notes: async () => null,
    summary: (async () => RESULT) as never,
  })
  check('summary applies when digest/notes/handoff advance', out.outcome === 'applied' && out.method === 'summary')
  const trail = out.steps.map(s => `${s.method}:${s.outcome}`).join(',')
  check('the steps record the WHOLE walk in order', trail === 'digest:advanced,notes:advanced,handoff:advanced,summary:applied', trail)
  const reasons = out.steps.filter(s => s.outcome === 'advanced').map(s => (s as { reason: string }).reason)
  check('every advance carries a typed reason', reasons.length === 3 && reasons.every(r => r.length > 10), JSON.stringify(reasons))

  const viaNotes = await ladder.runMaintenanceLadder(INPUT, undefined, {
    digestProjection: () => null,
    notes: async () => RESULT,
    summary: (async () => {
      throw new Error('summary must not run once notes applied')
    }) as never,
  })
  check('notes applying STOPS the walk (first application wins)', viaNotes.outcome === 'applied' && viaNotes.method === 'notes' && viaNotes.steps.length === 2)
}

// ============================================================================
section('§B the laws')
// ============================================================================
{
  const measured = await ladder.runMaintenanceLadder(INPUT, ['digest'], {
    digestProjection: () => ({ cleared: 4, tokensSaved: 1234 }) as never,
  })
  check('digest NEVER applies at the ladder layer — measured typed advance', measured.outcome === 'exhausted' && measured.steps[0]?.outcome === 'advanced' && (measured.steps[0] as { reason: string }).reason.includes('1234'), JSON.stringify(measured.steps))

  const overflow = await ladder.runMaintenanceLadder({ ...INPUT, overflow: true }, ['handoff'], {
    handoff: async () => RESULT, // even a PRESENT runner is skipped on overflow
  })
  check('overflow ALWAYS advances past handoff (same-oversized-input law)', overflow.outcome === 'exhausted' && (overflow.steps[0] as { reason: string }).reason.includes('overflow'), JSON.stringify(overflow.steps))

  const absent = await ladder.runMaintenanceLadder(INPUT, ['handoff'], {})
  check('an absent handoff runner advances typed (the C2 drop-in seam)', absent.outcome === 'exhausted' && (absent.steps[0] as { reason: string }).reason.includes('not built'), JSON.stringify(absent.steps))

  const handoffApplies = await ladder.runMaintenanceLadder(INPUT, ['handoff', 'summary'], {
    handoff: async () => RESULT,
    summary: (async () => {
      throw new Error('summary must not run once handoff applied')
    }) as never,
  })
  check('a PRESENT handoff runner applies off-overflow (drop-in proven)', handoffApplies.outcome === 'applied' && handoffApplies.method === 'handoff')
}

// ============================================================================
section('§C exhaustion — the typed trail, never a loop')
// ============================================================================
{
  const out = await ladder.runMaintenanceLadder(INPUT, ['digest', 'notes', 'handoff'], {
    digestProjection: () => null,
    notes: async () => null,
  })
  check('an order without summary exhausts with the full trail', out.outcome === 'exhausted' && out.steps.length === 3 && out.steps.every(s => s.outcome === 'advanced'))
}

// ============================================================================
section('§D the gate (structural)')
// ============================================================================
{
  const auto = readFileSync(join(ROOT, 'src/services/compact/autoCompact.ts'), 'utf8')
  check('autoCompactIfNeeded consults the ladder ONLY under the gate', auto.includes('isMaintenanceLadderEnabled()') && auto.indexOf('runMaintenanceLadder(') > auto.indexOf('isMaintenanceLadderEnabled()'))
  check('OFF keeps the standing two-step (notes then summary) intact', auto.includes('trySessionMemoryCompaction(messages, toolUseContext.agentId, threshold)'))
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  check('MERCURY_COMPACT_LADDER carries its registry row', registry.includes('MERCURY_COMPACT_LADDER'))
  check('the flag reads through the registry seam (flagEnv)', readFileSync(join(ROOT, 'src/services/compact/maintenanceLadder.ts'), 'utf8').includes("flagEnv('MERCURY_COMPACT_LADDER')"))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
