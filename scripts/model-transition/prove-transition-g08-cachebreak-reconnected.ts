#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-g08-cachebreak-reconnected.ts —
// the prompt-cache-break detector is RECONNECTED at the
//  sampling-call sites into a Mercury-native receipt, on all three lanes
//  (the severed loop repro-ctm-g07b recorded is repaired; the retired
//  telemetry sink never returns).
//
//    §A the wiring is live — each lane calls BOTH phases (source-anchored,
//       the inverse of the severance repro's §B); the turn machine carries
//       the frozen per-call reference into the lanes
//    §B behavior — synthetic switch-class drives mint typed receipts:
//       stable prompt → none; model switch → modelChanged (+previousModel);
//       tool add → toolSchemasChanged (+addedTools); unchanged prompt with
//       an old history → TTL classification; sub-threshold drop → none;
//       compaction/deletion notifications suppress the false positive
//    §C the receipt ring is bounded and reset clears it; untracked
//       sources stay untracked
//
//  Seams: the real detection module under a hermetic scratch home; the
//  lane files scanned as source (the wiring's call sites).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g08-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g08-home-'))

const ROOT = join(import.meta.dir, '..', '..')

const det = await import('../../src/services/api/promptCacheBreakDetection.ts')
const { buildModelCallReference } = await import('../../src/run-core/call-reference.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('§A the wiring is live on all three lanes (+ the reference carrier)')
{
  const LANES: Array<[string, string]> = [
    ['anthropic', 'src/services/providers/anthropic/streamCore.ts'],
    ['openai', 'src/services/providers/openai/openaiCallModel.ts'],
    ['zai', 'src/services/providers/zai/zaiCallModel.ts'],
  ]
  for (const [lane, rel] of LANES) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    check(
      `${lane}: phase 1 call site live (recordPromptState({...}))`,
      src.includes('recordPromptState({'),
    )
    check(
      `${lane}: phase 2 call site live (checkResponseForCacheBreak(...))`,
      src.includes('checkResponseForCacheBreak('),
    )
    check(`${lane}: the snapshot names its lane`, src.includes(`lane: '${lane}'`))
  }
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check(
    'the turn machine carries the frozen reference to the lanes (callReference)',
    machine.includes('callReference,') && machine.includes('const callReference = buildModelCallReference'),
  )
  const options = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('the callModel Options contract carries callReference', options.includes('callReference?: ModelCallReference'))
}

// ── §B rig: synthetic switch-class drives through the REAL module ───────────

type Snap = Parameters<typeof det.recordPromptState>[0]
const SYSTEM = [{ text: 'the system prompt bytes' }]
const TOOLS = (...names: string[]): Array<Record<string, unknown>> =>
  names.map(name => ({ name, description: `${name} tool`, input_schema: { type: 'object' } }))

const baseSnap = (over: Partial<Snap> = {}): Snap =>
  ({
    system: SYSTEM,
    toolSchemas: TOOLS('Alpha', 'Beta'),
    querySource: 'repl_main_thread',
    model: 'claude-opus-5',
    lane: 'anthropic',
    ...over,
  }) as Snap

const oldHistory = [
  {
    type: 'assistant',
    uuid: 'aaaaaaaa-0000-0000-0000-000000000001',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    message: { role: 'assistant', content: [] },
  },
] as never[]

async function drive(snap: Snap, cacheRead: number, messages: never[] = []): Promise<number> {
  det.recordPromptState(snap)
  await det.checkResponseForCacheBreak(snap.querySource, cacheRead, 1000, messages, snap.agentId)
  return det.recentCacheBreakReceipts().length
}

section('§B switch classes mint typed receipts')
{
  det.resetPromptCacheBreakDetection()
  const reference = buildModelCallReference({
    model: 'claude-opus-5',
    effort: 'high',
    maxOutputTokensOverride: undefined,
    tools: [{ name: 'Alpha' }, { name: 'Beta' }],
  })

  await drive(baseSnap({ callReference: reference }), 50_000) // first call: baseline
  let n = await drive(baseSnap({ callReference: reference }), 50_000)
  check('stable prompt + stable cache → no receipt', n === 0, `receipts=${n}`)

  n = await drive(
    baseSnap({ model: 'gpt-5.2', lane: 'openai', callReference: reference }),
    10_000,
  )
  const modelBreak = det.recentCacheBreakReceipts().at(-1)
  check('model switch + real drop → ONE receipt', n === 1, `receipts=${n}`)
  check(
    'the receipt types the switch class (modelChanged + previousModel)',
    modelBreak?.classes?.modelChanged === true && modelBreak?.previousModel === 'claude-opus-5',
    JSON.stringify(modelBreak?.classes),
  )
  check(
    'the receipt names the lane + reason',
    modelBreak?.lane === 'openai' && Boolean(modelBreak?.reason.includes('model changed')),
    `${modelBreak?.lane} · ${modelBreak?.reason}`,
  )
  check(
    'the receipt folds the frozen per-call reference digest',
    modelBreak?.callReferenceDigest === reference.digest,
  )

  n = await drive(
    baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }),
    4_000,
  )
  const toolBreak = det.recentCacheBreakReceipts().at(-1)
  check('tool addition + drop → receipt with addedTools', n === 2 && toolBreak?.classes?.toolSchemasChanged === true && toolBreak?.classes?.addedTools.join(',') === 'Gamma', JSON.stringify(toolBreak?.classes?.addedTools))

  // Rebuild the baseline high so the next drop is meaningful.
  await drive(baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }), 60_000)
  n = await drive(
    baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }),
    9_000,
    oldHistory,
  )
  const ttlBreak = det.recentCacheBreakReceipts().at(-1)
  check(
    'unchanged prompt + old history → TTL-classified receipt, no classes',
    n === 3 && ttlBreak?.classes === undefined && Boolean(ttlBreak?.reason.includes('TTL')),
    `${ttlBreak?.reason}`,
  )

  // Sub-threshold: 9_000 → 8_500 (drop 500 < 2_000 minimum).
  n = await drive(baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }), 8_500)
  check('sub-threshold drop → no receipt', n === 3, `receipts=${n}`)

  // Compaction resets the baseline: the next (legitimate) big drop is quiet.
  det.notifyCompaction('repl_main_thread')
  n = await drive(baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }), 1_000)
  check('post-compaction drop → suppressed (baseline reset)', n === 3, `receipts=${n}`)

  // Deletion marks the next drop expected.
  await drive(baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }), 40_000)
  det.notifyCacheDeletion('repl_main_thread')
  n = await drive(baseSnap({ model: 'gpt-5.2', lane: 'openai', toolSchemas: TOOLS('Alpha', 'Beta', 'Gamma') as never }), 5_000)
  check('post-deletion drop → suppressed (expected reduction)', n === 3, `receipts=${n}`)
}

section('§C ring bounds, reset, untracked sources')
{
  det.resetPromptCacheBreakDetection()
  check('reset clears the ring', det.recentCacheBreakReceipts().length === 0)

  // 55 rise/drop rounds → 55 breaks → the ring holds the newest 50.
  await drive(baseSnap(), 100_000)
  for (let i = 0; i < 55; i++) {
    await drive(baseSnap(), 100_000) // recover the baseline (rise: never a break)
    await drive(baseSnap(), 10_000) // 90k drop → break
  }
  const ring = det.recentCacheBreakReceipts()
  check('the ring is bounded at 50, newest last', ring.length === 50 && ring.at(-1)!.at >= ring[0]!.at, `len=${ring.length}`)

  det.resetPromptCacheBreakDetection()
  const before = det.recentCacheBreakReceipts().length
  det.recordPromptState(baseSnap({ querySource: 'speculation' as never }))
  await det.checkResponseForCacheBreak('speculation' as never, 1_000, 0, [])
  check('untracked sources stay untracked (no state, no receipt)', det.recentCacheBreakReceipts().length === before)
}

console.log(
  failures === 0
    ? '\n ✅ CACHE-BREAK DETECTOR RECONNECTED (three lanes, Mercury-native receipts)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
