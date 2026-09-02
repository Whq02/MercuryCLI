#!/usr/bin/env bun
// prove-tool-defer-carve — tool deferral
// (ToolSearch + the name-only announcement) on EVERY route, behind the
// registered MERCURY_TOOL_DEFER gate alone. The baked
// DISABLE_EXPERIMENTAL_BETAS fold forced getToolSearchMode() to 'standard',
// inlining every deferrable tool schema into every request (~111KB measured
// — the single largest prefix component; P0 bench ~94K-token prefix vs ~22K
// with deferral). The first carve re-opened the ladder on the first-party
// host only; a later change made the gate route-independent and moved the
// base-URL term where it belongs — the WIRE FORM (deferralWire.ts: the beta
// block form on first-party by contract, on a gateway by probe evidence; the
// text form everywhere else). The 400 class is still fenced: the strip choke
// point admits defer_loading only where the block form is accepted.
//
//   §1 GATE POLARITY (functional, live env): default-ON via the registered
//      MERCURY_TOOL_DEFER row on EVERY base URL; =0 kills; a non-first-party
//      base URL keeps deferral ON while the beta field acceptance reads
//      false there (unprobed) — and true again under the operator's
//      MERCURY_TOOL_SEARCH assertion.
//   §2 MODE LADDER (functional): with the carve open, getToolSearchMode()
//      resolves the deferral ladder — unset ⇒ 'tst', MERCURY_TOOL_SEARCH=false ⇒
//      'standard', auto ⇒ 'tst-auto' (the external spelling keeps its
//      historical decode one rung below the carve); a proxy resolves the
//      same ladder ('tst'); with the carve closed (=0) the baked
//      force-'standard' stands.
//   §3 STRIP CARVE (structural): the DISABLE_EXPERIMENTAL_BETAS strip in
//      src/utils/api.ts re-reads the SAME live gate AND the wire-form
//      acceptance, allowlists ONLY defer_loading behind them, rebuilds the
//      field into the stripped return, and keeps every other beta field
//      stripped (the '1' pin).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ENV_KEYS = [
  'MERCURY_TOOL_DEFER',
  'MERCURY_TOOL_SEARCH',
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

const { toolDeferralEnabled } = await import(
  '../../src/utils/model/capabilities.ts'
)
const { getToolSearchMode } = await import('../../src/utils/toolSearch.ts')
const { toolReferenceWireAccepted } = await import('../../src/services/providers/deferralWire.ts')

section('§1 GATE POLARITY — live env re-reads; the base URL selects the wire form, never the gate')
try {
  setEnv({})
  check('default-ON (unset, direct first-party)', toolDeferralEnabled() === true)
  check('first-party accepts the beta field (the block form by contract)', toolReferenceWireAccepted() === true)
  setEnv({ MERCURY_TOOL_DEFER: '0' })
  check('MERCURY_TOOL_DEFER=0 kills', toolDeferralEnabled() === false)
  setEnv({ ANTHROPIC_BASE_URL: 'https://litellm.proxy.example.com' })
  check(
    'proxy base URL ⇒ deferral stays ON (route-independent)',
    toolDeferralEnabled() === true,
  )
  check(
    'proxy base URL ⇒ the beta field is NOT accepted while unprobed (the 400 class is fenced at the wire form)',
    toolReferenceWireAccepted() === false,
  )
  setEnv({ ANTHROPIC_BASE_URL: 'https://litellm.proxy.example.com', MERCURY_TOOL_SEARCH: 'tst' })
  check(
    "the operator's explicit MERCURY_TOOL_SEARCH asserts pass-through ⇒ the block form on the proxy",
    toolReferenceWireAccepted() === true,
  )
} finally {
  restore()
}

section('§2 MODE LADDER — the carve re-opens the full decode, kill restores baked standard')
try {
  setEnv({})
  check("carve open + unset ⇒ 'tst' (default: always defer)", getToolSearchMode() === 'tst')
  setEnv({ MERCURY_TOOL_SEARCH: 'false' })
  check("MERCURY_TOOL_SEARCH=false keeps its decode ⇒ 'standard'", getToolSearchMode() === 'standard')
  setEnv({ MERCURY_TOOL_SEARCH: 'auto' })
  check("MERCURY_TOOL_SEARCH=auto ⇒ 'tst-auto'", getToolSearchMode() === 'tst-auto')
  setEnv({ MERCURY_TOOL_SEARCH: 'auto:0' })
  check("auto:0 ⇒ 'tst'", getToolSearchMode() === 'tst')
  setEnv({ MERCURY_TOOL_SEARCH: 'auto:100' })
  check("auto:100 ⇒ 'standard'", getToolSearchMode() === 'standard')
  setEnv({ MERCURY_TOOL_DEFER: '0' })
  check("=0 ⇒ baked 'standard' (byte-identical pre-carve wire)", getToolSearchMode() === 'standard')
  setEnv({ MERCURY_TOOL_DEFER: '0', MERCURY_TOOL_SEARCH: 'true' })
  check("=0 beats even an explicit MERCURY_TOOL_SEARCH=true (the kill is absolute)", getToolSearchMode() === 'standard')
  setEnv({ ANTHROPIC_BASE_URL: 'https://litellm.proxy.example.com' })
  check("proxy ⇒ the same ladder ('tst' — deferral rides the text form there)", getToolSearchMode() === 'tst')
} finally {
  restore()
}

section('§3 STRIP CARVE — structural pins on src/utils/api.ts + toolSearch.ts')
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
  'carve is gated on the LIVE gate AND the wire-form acceptance',
  /if \(toolDeferralEnabled\(\) && toolReferenceWireAccepted\(\)\) \{\s*allowed\.add\('defer_loading'\)/.test(
    stripBlock,
  ),
)
check(
  'stripped return rebuilds the field only when carved AND present',
  stripBlock.includes(
    "...(allowed.has('defer_loading') &&\n          schema.defer_loading && { defer_loading: true }),",
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
  'strict is never carved',
  !/allowed\.add\('strict'\)/.test(stripBlock),
)
const tsSrc = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'utils', 'toolSearch.ts'),
  'utf8',
)
check(
  "getToolSearchMode's baked force-'standard' is carved on the SAME live fn",
  /if \(isEnvTruthy\('1'\) && !toolDeferralEnabled\(\)\) \{\s*return 'standard'/.test(
    tsSrc,
  ),
)

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} TOOL-DEFER-CARVE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TOOL-DEFER-CARVE PROOFS PASS')
