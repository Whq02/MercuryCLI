#!/usr/bin/env bun


let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ENV_KEYS = [
  'MERCURY_FGTS',
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
  '../../src/models/facts/capabilities.ts'
)

section('§1 GATE POLARITY — live env re-reads on direct first-party')
try {
  setEnv({})
  check('default-ON (unset, direct first-party)', fineGrainedToolStreamingEnabled() === true)
  setEnv({ MERCURY_FGTS: '0' })
  check('MERCURY_FGTS=0 kills', fineGrainedToolStreamingEnabled() === false)
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


console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} FGTS-CARVE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL FGTS-CARVE PROOFS PASS')
