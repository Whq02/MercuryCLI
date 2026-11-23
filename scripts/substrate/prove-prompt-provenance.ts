#!/usr/bin/env bun

let fail = 0
const ok = (l: string) => console.log(`  ✓ ${l}`)
const bad = (l: string, hint = '') => {
  console.log(`  ✗ ${l}${hint ? ' — ' + hint : ''}`)
  fail = 1
}
const assert = (cond: unknown, l: string, hint = '') => (cond ? ok(l) : bad(l, hint))
const RECORDER = 'recordPromptComposition in src/screen/cockpit/promptProvenance.ts'

const {
  recordPromptComposition,
  readPromptProvenance,
  __resetPromptProvenanceForTest,
} = await import('../../src/screen/cockpit/promptProvenance.ts')
const { buildBehaviourContract } = await import('../../src/engine/system-prompt/behaviourContract.ts')
const { renderAnthropicSections } = await import('../../src/engine/system-prompt/behaviourContract.ts')

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
})
recordPromptComposition({ contract: tiny, composedSegments: renderAnthropicSections(tiny) })
assert(readPromptProvenance() !== null, 'provenance state recorded under a bare stamp', `${RECORDER} must record without reading MACRO, and its catch must not swallow a normal input`)

console.log('[2] typed contract attribution is exact')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-proof' }
__resetPromptProvenanceForTest()

const contract = buildBehaviourContract({
  staticSections: ['HEAD-A', 'HEAD-BB'],
  dynamicBoundary: [],
  dynamicSpecs: [
    { name: 'memory', cacheBreak: false },
    { name: 'env_info_simple', cacheBreak: false },
    { name: 'mcp_instructions', cacheBreak: true },
    { name: 'language', cacheBreak: false },
  ],
  dynamicResolved: ['D1', 'D22', 'D333', null],
  wrapperSections: [
    { name: 'response-profile', text: 'W-1' },
    { name: 'another', text: 'W-22' },
  ],
  modeSections: [{ name: 'mode-apollo', text: 'MODEPACK' }],
  antiSycSections: ['R'],
})
const segments = renderAnthropicSections(contract)
recordPromptComposition({
  contract,
  composedSegments: segments,
  absentDynamic: [{ name: 'language', reason: 'computed null (capability gated off or nothing to say)' }],
})
const p = readPromptProvenance()
assert(p !== null, 'provenance recorded', `${RECORDER} must set lastProvenance for a valid contract`)
if (p) {
  assert(p.segmentCount === 9, `segmentCount 9 (got ${p.segmentCount})`, `${RECORDER} must take segmentCount from composedSegments.length`)
  assert(p.totalChars === 38, `totalChars 38 (got ${p.totalChars})`, `${RECORDER} must sum the lengths of composedSegments into totalChars`)
  assert(p.digest === contract.digest, 'contract digest carried verbatim', `${RECORDER} must copy contract.digest unchanged`)
  assert(p.sections.length === contract.sections.length, 'one record per composed section', `${RECORDER} must map every entry of contract.sections to one record`)
  const wrapperRecs = p.sections.filter(s => s.group === 'wrapper')
  assert(
    wrapperRecs.map(s => s.name).join(',') === 'response-profile,another',
    'wrapper sections carry semantic names',
    'buildBehaviourContract in src/engine/system-prompt/behaviourContract.ts must keep each wrapperSections name, in order, on the wrapper group',
  )
  assert(
    wrapperRecs.every(s => s.owner === 'src/engine/system-prompt/mercuryContract.ts'),
    'wrapper owner attributed',
    'the wrapper owner entry in src/engine/system-prompt/behaviourContract.ts must stay src/engine/system-prompt/mercuryContract.ts',
  )
  const mcp = p.sections.find(s => s.name === 'mcp_instructions')
  assert(mcp?.cacheClass === 'turn', 'cacheBreak dynamic section classed turn', 'buildBehaviourContract in src/engine/system-prompt/behaviourContract.ts must give a dynamic spec with cacheBreak true the cacheClass turn')
  const mem = p.sections.find(s => s.name === 'memory')
  assert(mem?.cacheClass === 'session' && mem.owner === 'src/sessions/mneme/mnemeFrontPage.ts', 'memory owner + session cache class', 'the dynamic:memory owner entry and the session cacheClass for dynamic sections in src/engine/system-prompt/behaviourContract.ts must be src/sessions/mneme/mnemeFrontPage.ts and session')
  assert(p.sections.every(s => /^[0-9a-f]{8}$/.test(s.sha8)), 'every section carries a sha-8 fingerprint', `${RECORDER} must set sha8 to the first 8 hex digits of the sha256 of each section text`)
  assert(p.absent.length === 1 && p.absent[0]?.name === 'language', 'absent section recorded with its reason', `${RECORDER} must carry input.absentDynamic into the absent field`)
  assert(typeof p.openaiChars === 'number' && p.openaiChars > 0, 'openai render size recorded', `${RECORDER} must compute openaiChars from the sections whose scope is not anthropic-only`)
  const json = JSON.stringify(p)
  assert(!json.includes('HEAD-A') && !json.includes('MODEPACK') && !json.includes('W-1'), 'SHAPE-ONLY: zero segment content in the record', `${RECORDER} must store only chars and sha8 per section, never the section text`)
}

console.log('[3] previous totals retained (before/after)')
recordPromptComposition({ contract: tiny, composedSegments: renderAnthropicSections(tiny) })
const p2 = readPromptProvenance()
assert(p2?.previous?.totalChars === 38 && p2.previous.digest === contract.digest, 'previous composition totals carried', `${RECORDER} must fill previous from the prior lastProvenance (digest, totalChars, segmentCount, openaiChars)`)

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
assert(!threw, 'garbage input swallowed (provenance can never break composition)', `${RECORDER} must keep all of its work inside the try block so bad input never throws`)
assert(readPromptProvenance()?.segmentCount === 2, 'prior record preserved after garbage call', `${RECORDER} must assign lastProvenance only after every field is computed, so a throw leaves the prior record`)

console.log(fail ? '\n❌ prompt-provenance proof FAILED' : '\n✅ prompt-provenance proof PASS')
process.exit(fail)
