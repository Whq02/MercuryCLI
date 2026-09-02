#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-identity-distinct.ts
//  PROOF: Mercury's model-facing identity is DISTINCT — positive-only.
//
//  The identity surfaces name no other product at all — even negatively
//  ("not a build of X" still primes X) — and assert Mercury as its own
//  sovereign harness. The contract is repository-owned
//  (src/prompt/mercuryContract.ts) and the floor is provider-neutral: it
//  names no engine family (the env block self-reports the actual model).
//
//  Pins: the identity floor / doctrine / reconcile · both subagent-doctrine
//  variants · the guide agent's self-framing (its external DOCS references
//  keep their resource names — that is its function, not identity).
//
//  Run: ~/.bun/bin/bun run scripts/identity/prove-identity-distinct.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' identity distinct — sovereign Mercury, positive-only')
console.log('============================================================')

const {
  MERCURY_IDENTITY_FLOOR,
  MERCURY_IDENTITY_RECONCILE,
  MERCURY_DOCTRINE,
} = await import('../../src/prompt/mercuryContract.ts')

const OTHER = new RegExp(['claude', 'code'].join(' '), 'i')
const FRAMING = new RegExp(['branded', 're-?skinned', 'a build of', ['fork', 'of'].join(' '), 'based on .* technology'].join('|'), 'i')

const surfaces: Array<[string, string]> = [
  ['identity floor', MERCURY_IDENTITY_FLOOR],
  ['identity reconcile', MERCURY_IDENTITY_RECONCILE],
  ['mercury doctrine', MERCURY_DOCTRINE],
]
for (const [label, text] of surfaces) {
  check(`${label}: never names the other product`, !OTHER.test(text))
  check(`${label}: zero derivative framing`, !FRAMING.test(text))
}
check('floor names Mercury', /Mercury/.test(MERCURY_IDENTITY_FLOOR))
check('reconcile names Mercury', /Mercury/.test(MERCURY_IDENTITY_RECONCILE))
check('floor asserts the one name', /The one name you go by is Mercury/.test(MERCURY_IDENTITY_FLOOR))
check(
  'floor engine clause is provider-neutral (no model-family name)',
  /the\n?model is the engine|model is the engine/.test(MERCURY_IDENTITY_FLOOR) &&
    !/Claude model family/.test(MERCURY_IDENTITY_FLOOR),
)
check(
  'no retired register anywhere in the active contract',
  !new RegExp(['Temp', 'est'].join('')).test(MERCURY_IDENTITY_FLOOR + MERCURY_DOCTRINE + MERCURY_IDENTITY_RECONCILE),
)

// Subagent doctrine — both variants ship the Mercury identity, zero foreign-product identity.
const doctrineSrc = readFileSync(join(ROOT, 'src/constants/subagentDoctrine.ts'), 'utf8')
const doctrineBlocks = doctrineSrc.match(/<subagent-doctrine[^>]*>[\s\S]*?<\/subagent-doctrine>/g) ?? []
check('doctrine block found (ONE operating register; buildSubagentMercurySections composes it per variant)', doctrineBlocks.length >= 1 && /buildSubagentMercurySections/.test(doctrineSrc), String(doctrineBlocks.length))
for (const [i, block] of doctrineBlocks.entries()) {
  check(`doctrine[${i}]: never names the other product`, !OTHER.test(block))
  check(`doctrine[${i}]: names Mercury`, /Mercury/.test(block))
}

// The guide agent: self-framing is sovereign + positive-only. External docs
// resource names are allowed (they are its research targets, not identity).
const guideSrc = readFileSync(
  join(ROOT, 'src/tools/AgentTool/built-in/mercuryGuideAgent.ts'),
  'utf8',
)
check('guide agent: sovereign self-framing (its own terms, never lineage)', /Describe Mercury in its own terms/.test(guideSrc) && /Mercury is the harness; its features are its own/.test(guideSrc))
check('guide agent: no built-on framing', !new RegExp('built on ' + OTHER.source, 'i').test(guideSrc))
check('guide agent: no based-on-technology framing', !new RegExp('based on ' + OTHER.source + ' technology', 'i').test(guideSrc))
check(
  'guide agent: no shared-mechanics identity framing',
  !new RegExp('shares most CLI mechanics with upstream ' + OTHER.source, 'i').test(guideSrc),
)
check('guide agent: self-framing stays positive', /Describe Mercury in its own terms/.test(guideSrc))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} IDENTITY-DISTINCT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL IDENTITY-DISTINCT PROOFS PASS')
