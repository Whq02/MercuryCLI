#!/usr/bin/env bun


let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) {
    failures++
    console.log('         fix: gate in toolDeferralEnabled (src/models/facts/capabilities.ts), mode ladder in getToolSearchMode (src/engine/messages/toolSearch.ts), wire form in toolReferenceWireAccepted (src/models/roads/deferralWire.ts)')
  }
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
  '../../src/models/facts/capabilities.ts'
)
const { getToolSearchMode } = await import('../../src/engine/messages/toolSearch.ts')
const { toolReferenceWireAccepted } = await import('../../src/models/roads/deferralWire.ts')

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


console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} TOOL-DEFER-CARVE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TOOL-DEFER-CARVE PROOFS PASS')
