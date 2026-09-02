#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-prompt-provenance.ts
//  PROOF: the prompt-
//  provenance recorder captures the TYPED behaviour contract exactly —
//  semantic IDs, owners, provider scope, cache class, sizes, sha-8
//  fingerprints — stores shape only, retains the previous totals for
//  before/after, and never throws.
// ============================================================================

let fail = 0
const ok = (l: string) => console.log(`  ✓ ${l}`)
const bad = (l: string) => {
  console.log(`  ✗ ${l}`)
  fail = 1
}
const assert = (cond: unknown, l: string) => (cond ? ok(l) : bad(l))

const {
  recordPromptComposition,
  readPromptProvenance,
  __resetPromptProvenanceForTest,
} = await import('../../src/utils/cockpit/promptProvenance.ts')
const { buildBehaviourContract } = await import('../../src/prompt/behaviourContract.ts')
const { renderAnthropicSections } = await import('../../src/prompt/behaviourContract.ts')

// ---------- 1. stamp-independence --------------
console.log('[1] no MACRO: recorder STILL records (stamp-independence)')
delete (globalThis as Record<string, unknown>).MACRO
__resetPromptProvenanceForTest()
const tiny = buildBehaviourContract({
  staticSections: ['a', 'bb'],
  dynamicBoundary: [],
  dynamicSpecs: [],
  dynamicResolved: [],
  wrapperSections: [],
  modeSections: [],
  antiSycSections: [],
  reconcileTailSections: [],
})
recordPromptComposition({ contract: tiny, composedSegments: renderAnthropicSections(tiny) })
assert(readPromptProvenance() !== null, 'provenance state recorded under a bare stamp')

// ---------- 2. exact typed attribution ---------------------------------------
console.log('[2] typed contract attribution is exact')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-hermes' }
__resetPromptProvenanceForTest()

const contract = buildBehaviourContract({
  staticSections: ['HEAD-A', 'HEAD-BB'], // 6 + 7 = 13
  dynamicBoundary: [],
  dynamicSpecs: [
    { name: 'memory', cacheBreak: false },
    { name: 'env_info_simple', cacheBreak: false },
    { name: 'mcp_instructions', cacheBreak: true },
    { name: 'language', cacheBreak: false },
  ],
  dynamicResolved: ['D1', 'D22', 'D333', null], // 2 + 3 + 4 = 9
  wrapperSections: [
    { name: 'identity-floor', text: 'W-1' }, // 3
    { name: 'mercury-doctrine', text: 'W-22' }, // 4
  ],
  modeSections: [{ name: 'mode-autopilot', text: 'MODEPACK' }], // 8
  antiSycSections: [],
  reconcileTailSections: ['R'], // 1
})
const segments = renderAnthropicSections(contract)
recordPromptComposition({
  contract,
  composedSegments: segments,
  absentDynamic: [{ name: 'language', reason: 'computed null (capability gated off or nothing to say)' }],
})
const p = readPromptProvenance()
assert(p !== null, 'provenance recorded')
if (p) {
  assert(p.segmentCount === 9, `segmentCount 9 (got ${p.segmentCount})`)
  assert(p.totalChars === 38, `totalChars 38 (got ${p.totalChars})`)
  assert(p.digest === contract.digest, 'contract digest carried verbatim')
  assert(p.sections.length === contract.sections.length, 'one record per composed section')
  const wrapperRecs = p.sections.filter(s => s.group === 'wrapper')
  assert(
    wrapperRecs.map(s => s.name).join(',') === 'identity-floor,mercury-doctrine',
    'wrapper sections carry semantic names',
  )
  assert(
    wrapperRecs.every(s => s.owner === 'src/prompt/mercuryContract.ts'),
    'wrapper owner attributed',
  )
  const mcp = p.sections.find(s => s.name === 'mcp_instructions')
  assert(mcp?.cacheClass === 'turn', 'cacheBreak dynamic section classed turn')
  const mem = p.sections.find(s => s.name === 'memory')
  assert(mem?.cacheClass === 'session' && mem.owner === 'src/memdir/memdir.ts', 'memory owner + session cache class')
  assert(p.sections.every(s => /^[0-9a-f]{8}$/.test(s.sha8)), 'every section carries a sha-8 fingerprint')
  assert(p.absent.length === 1 && p.absent[0]?.name === 'language', 'absent section recorded with its reason')
  assert(typeof p.openaiChars === 'number' && p.openaiChars > 0, 'openai render size recorded')
  // shape-only: no prompt content stored anywhere in the record
  const json = JSON.stringify(p)
  assert(!json.includes('HEAD-A') && !json.includes('MODEPACK') && !json.includes('W-1'), 'SHAPE-ONLY: zero segment content in the record')
}

// ---------- 3. before/after totals --------------------------------------------
console.log('[3] previous totals retained (before/after)')
recordPromptComposition({ contract: tiny, composedSegments: renderAnthropicSections(tiny) })
const p2 = readPromptProvenance()
assert(p2?.previous?.totalChars === 38 && p2.previous.digest === contract.digest, 'previous composition totals carried')

// ---------- 4. never-throws ---------------------------------------------------
console.log('[4] never-throws on garbage input')
let threw = false
try {
  recordPromptComposition({
    // @ts-expect-error deliberate garbage
    contract: undefined,
    composedSegments: undefined as never,
  })
} catch {
  threw = true
}
assert(!threw, 'garbage input swallowed (provenance can never break composition)')
assert(readPromptProvenance()?.segmentCount === 2, 'prior record preserved after garbage call')

console.log(fail ? '\n❌ prompt-provenance proof FAILED' : '\n✅ prompt-provenance proof PASS')
process.exit(fail)
