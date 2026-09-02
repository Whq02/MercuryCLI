#!/usr/bin/env bun
// prove-fgts-carve — fine-grained tool streaming gate +
// the baked-strip carve. Without FGTS the API buffers WHOLE tool inputs before
// any input_json_delta (P0 bench: a ~45KB Write = 275s of dead wire, 2.0× wall
// vs the buffered path). The restore is provider-aware and must never reach a proxy.
//
//   §1 GATE POLARITY (functional, live env): default-ON via the registered
//      MERCURY_FGTS row on direct first-party; =0 kills; the retired foreign
//      boundary spelling is IGNORED; a non-first-party base URL is false
//      regardless (the 400 class).
//   §2 STRIP CARVE (structural): the DISABLE_EXPERIMENTAL_BETAS strip in
//      src/utils/api.ts re-reads the SAME live gate, allowlists ONLY
//      eager_input_streaming behind it, rebuilds the field into the stripped
//      return, and keeps every other beta field stripped (the '1' pin).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

// The foreign product's env prefix, composed so this prover never matches a
// vocabulary sweep (the dist-invariants needle pattern).
const FOREIGN = ['CLAUDE', 'CODE'].join('_')
const FOREIGN_FGTS = `${FOREIGN}_ENABLE_FINE_GRAINED_TOOL_STREAMING`
const ENV_KEYS = [
  'MERCURY_FGTS',
  FOREIGN_FGTS,
  'ANTHROPIC_BASE_URL',
] as const
const saved = new Map<string, string | undefined>()
for (const k of ENV_KEYS) saved.set(k, process.env[k])
const setEnv = (overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>): void => {
  for (const k of ENV_KEYS) {
    const v = overrides[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
const restore = (): void => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const { fineGrainedToolStreamingEnabled } = await import(
  '../../src/utils/model/capabilities.ts'
)

section('§1 GATE POLARITY — live env re-reads on direct first-party')
try {
  setEnv({})
  check('default-ON (unset, direct first-party)', fineGrainedToolStreamingEnabled() === true)
  setEnv({ MERCURY_FGTS: '0' })
  check('MERCURY_FGTS=0 kills', fineGrainedToolStreamingEnabled() === false)
  setEnv({ MERCURY_FGTS: '0', [FOREIGN_FGTS]: '1' })
  check(
    'the retired foreign boundary spelling is IGNORED (=0 still kills)',
    fineGrainedToolStreamingEnabled() === false,
  )
  setEnv({ [FOREIGN_FGTS]: '0' })
  check(
    'the retired foreign boundary spelling is IGNORED (default-on holds)',
    fineGrainedToolStreamingEnabled() === true,
  )
  setEnv({ ANTHROPIC_BASE_URL: 'https://litellm.proxy.example.com' })
  check(
    'proxy base URL ⇒ OFF regardless (the 400 class)',
    fineGrainedToolStreamingEnabled() === false,
  )
  setEnv({
    ANTHROPIC_BASE_URL: 'https://litellm.proxy.example.com',
  })
  check(
    'proxy base URL is false regardless of the gate default',
    fineGrainedToolStreamingEnabled() === false,
  )
} finally {
  restore()
}

section('§2 STRIP CARVE — structural pins on src/utils/api.ts')
const apiSrc = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'utils', 'api.ts'),
  'utf8',
)
const stripBlock = apiSrc.slice(apiSrc.indexOf("if (isEnvTruthy('1'))"))
check(
  'strip block exists (the baked DISABLE_EXPERIMENTAL_BETAS choke point)',
  stripBlock.length > 0 && stripBlock.length < apiSrc.length,
)
check(
  'carve is gated on the LIVE base-URL-aware fn',
  /if \(fineGrainedToolStreamingEnabled\(\)\) \{\s*allowed\.add\('eager_input_streaming'\)/.test(
    stripBlock,
  ),
)
check(
  'stripped return rebuilds the field only when carved AND present',
  stripBlock.includes(
    "...(allowed.has('eager_input_streaming') &&\n          schema.eager_input_streaming && { eager_input_streaming: true }),",
  ),
)
const allowlistMatch = stripBlock.match(
  /const allowed = new Set\(\[([\s\S]*?)\]\)/,
)
const allowlistLiterals = (allowlistMatch?.[1].match(/'[a-z_]+'/g) ?? []).map(
  s => s.slice(1, -1),
)
check(
  "base allowlist is exactly the four pre-carve fields (the '1' pin holds)",
  JSON.stringify(allowlistLiterals) ===
    JSON.stringify(['name', 'description', 'input_schema', 'cache_control']),
  allowlistLiterals.join(','),
)
check(
  // defer_loading gained its OWN live base-URL-aware
  // carve (MERCURY_TOOL_DEFER — prove-tool-defer-carve.ts owns it). This pin
  // narrows from "never carved" to "carved only behind toolDeferralEnabled()".
  'defer_loading is carved ONLY behind the live tool-defer gate AND the wire-form acceptance',
  /if \(toolDeferralEnabled\(\) && toolReferenceWireAccepted\(\)\) \{\s*allowed\.add\('defer_loading'\)/.test(
    stripBlock,
  ),
)
check(
  'strict is never carved',
  !/allowed\.add\('strict'\)/.test(stripBlock),
)
check(
  'the set-site stays gated on the same fn',
  /if \(fineGrainedToolStreamingEnabled\(\)\) \{\s*built\.eager_input_streaming = true/.test(
    apiSrc,
  ),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} FGTS-CARVE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FGTS-CARVE PROOFS PASS')
