import assert from 'node:assert/strict'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { proveWakeJourney } = await import('./swarm-wake-world.ts')
let checks = 0
await proveWakeJourney(true, (label, value) => {
  assert(value, label)
  checks++
  console.log(`PASS ${label}`)
})
console.log(`${checks} missing-worktree wake checks passed`)
