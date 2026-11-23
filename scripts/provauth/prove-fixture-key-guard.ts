#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const savedEnv: Record<string, string | undefined> = {}
for (const key of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_GEMINI_API_BASE']) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-fixture-guard-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}


console.log('============================================================')
console.log(' PROVAUTH — the fixture-key leak road (both ends closed)')
console.log('============================================================')

const FIXTURE = 'zz-SECRETBYTES-0f9e8d7c6b5a4321'
const REAL = 'AIzaSyA0000000000000000000000000000000'

const { guardLoginDriverWrite, configHomeIsReal, defaultConfigHome } = await import('../lib/loginDriverGuard.ts')
const { looksLikeProofFixtureKey, deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.ts')
const { writeStoredGeminiApiKey, readStoredGeminiApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')

const homeHint = 'fix configHomeIsReal in scripts/lib/loginDriverGuard.ts so that only the default config home and paths inside it read as the real store'
const guardHint = 'fix guardLoginDriverWrite in scripts/lib/loginDriverGuard.ts so that it throws (message naming the real store) only when configHomeIsReal reads true'
const fixtureHint = 'fix looksLikeProofFixtureKey in src/models/roads/account-slots/keyLane.ts'
{
  const { homedir } = await import('node:os')
  check('the real store is the default home under the user directory', defaultConfigHome() === join(homedir(), '.mercury'), 'defaultConfigHome in scripts/lib/loginDriverGuard.ts must return the .mercury folder under the user home')
  check('configHomeIsReal: no MERCURY_CONFIG_DIR pin reads real (the default home, or the launcher word MERCURY_HOME — an operator pin, never a proof pin)', configHomeIsReal({}) && configHomeIsReal({ MERCURY_HOME: '/tmp/prove-fixture-launcher-home' }), homeHint)
  check('configHomeIsReal: a pin naming the default home reads real', configHomeIsReal({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') }) && configHomeIsReal({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') + '/' }), homeHint)
  check('configHomeIsReal: a scratch pin is not the real store', !configHomeIsReal({ MERCURY_CONFIG_DIR: '/tmp/prove-fixture-scratch' }), homeHint)
  check('configHomeIsReal: a nested path under the real store is still real', configHomeIsReal({ MERCURY_CONFIG_DIR: join(defaultConfigHome(), 'nested', 'missing') }), homeHint)
  check('configHomeIsReal: a sibling sharing the prefix is not real', !configHomeIsReal({ MERCURY_CONFIG_DIR: `${defaultConfigHome()}-proof` }), homeHint)
  const alias = join(process.env.MERCURY_CONFIG_DIR!, 'home-link')
  symlinkSync(defaultConfigHome(), alias, 'dir')
  try {
    check('configHomeIsReal: a symlink to the real store is real', configHomeIsReal({ MERCURY_CONFIG_DIR: alias }), homeHint)
    check('configHomeIsReal: a missing leaf under that symlink is real', configHomeIsReal({ MERCURY_CONFIG_DIR: join(alias, 'missing', 'leaf') }), homeHint)
  } finally {
    unlinkSync(alias)
  }
  check("configHomeIsReal: a drive world's shape — MERCURY_CONFIG_DIR and MERCURY_HOME both on one scratch home — is not the real store", !configHomeIsReal({ MERCURY_HOME: '/tmp/prove-fixture-world/home', MERCURY_CONFIG_DIR: '/tmp/prove-fixture-world/home' }), homeHint)
  const throws = (env: NodeJS.ProcessEnv): boolean => {
    try {
      guardLoginDriverWrite('the test sweep', env)
      return false
    } catch (error) {
      return /real store/.test(error instanceof Error ? error.message : String(error))
    }
  }
  check('the guard THROWS a login-driver write with no pin at all (the leak road: an inherited or absent home)', throws({}), guardHint)
  check('the guard THROWS a login-driver write pinned at the default home', throws({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') }), guardHint)
  check('the guard PASSES a login-driver write under a scratch pin', !throws({ MERCURY_CONFIG_DIR: '/tmp/prove-fixture-scratch' }), guardHint)
  check("the guard PASSES a drive world's shape", !throws({ MERCURY_HOME: '/tmp/prove-fixture-world/home', MERCURY_CONFIG_DIR: '/tmp/prove-fixture-world/home' }), guardHint)
}

{
  check('the seeded fixture key reads as a fixture', looksLikeProofFixtureKey(FIXTURE), fixtureHint)
  check('a real Gemini key (AIza…) does not', !looksLikeProofFixtureKey(REAL), fixtureHint)
  check('an absent key is not a fixture', !looksLikeProofFixtureKey(undefined), fixtureHint)
}

{
  guardLoginDriverWrite('the fixture-key guard proof')
  writeStoredGeminiApiKey(FIXTURE)
  check('the fixture key landed in the SCRATCH store (never the real one)', readStoredGeminiApiKey() === FIXTURE, 'writeStoredGeminiApiKey and readStoredGeminiApiKey in src/models/sign-in/account-ledger/providerSecrets.ts must round-trip under the pinned MERCURY_CONFIG_DIR')
  const groups = deriveFamilySlotGroups(undefined, {
    geminiOauthConnected: () => false,
    geminiActiveAccount: () => ({ provider: 'gemini', kind: 'api-key', label: 'Gemini API key (stored)', keySource: 'stored' }),
    geminiStoredKey: () => FIXTURE,
    geminiEnvGoogleKey: () => undefined,
    geminiEnvGeminiKey: () => undefined,
  })
  const gemini = groups.find(g => g.family.id === 'gemini')
  const storedSlot = gemini?.slots.find(s => s.id === 'gemini:stored-key')
  check('the Gemini stored-key slot exists', storedSlot !== undefined, JSON.stringify(gemini?.slots.map(s => s.id)) + ' — deriveFamilySlotGroups in src/models/roads/accountSlots.ts must yield a gemini:stored-key slot for a stored key')
  check('its state note says the key is a test key, not a real Gemini API key, and names the removal gesture', (storedSlot?.stateNote ?? '') === 'a test key (zz-SECRE…), not a real Gemini API key — ⌫ removes it', (storedSlot?.stateNote ?? '<none>') + ' — the stored-key note is built in src/models/roads/account-slots/gemini.ts')
  writeStoredGeminiApiKey(null)
}


for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} fixture-key-guard proof(s) failed`)
  process.exit(1)
}
console.log('✅ FIXTURE-KEY LEAK ROAD CLOSED (fixture rig)')
