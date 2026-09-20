#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
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

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

console.log('============================================================')
console.log(' PROVAUTH — the fixture-key leak road (both ends closed)')
console.log('============================================================')

const FIXTURE = 'zz-SECRETBYTES-0f9e8d7c6b5a4321'
const REAL = 'AIzaSyA0000000000000000000000000000000'

const { guardLoginDriverWrite, configHomeIsReal, defaultConfigHome } = await import('../lib/loginDriverGuard.ts')
const { looksLikeProofFixtureKey, deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
const { writeStoredGeminiApiKey, readStoredGeminiApiKey } = await import('../../src/utils/router/providerSecrets.ts')

{
  const { homedir } = await import('node:os')
  check('the real store is the default home under the user directory', defaultConfigHome() === join(homedir(), '.mercury'))
  check('configHomeIsReal: no MERCURY_CONFIG_DIR pin reads real (the default home, or the launcher word MERCURY_HOME — an operator pin, never a proof pin)', configHomeIsReal({}) && configHomeIsReal({ MERCURY_HOME: '/tmp/prove-fixture-launcher-home' }))
  check('configHomeIsReal: a pin naming the default home reads real', configHomeIsReal({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') }) && configHomeIsReal({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') + '/' }))
  check('configHomeIsReal: a scratch pin is not the real store', !configHomeIsReal({ MERCURY_CONFIG_DIR: '/tmp/prove-fixture-scratch' }))
  check("configHomeIsReal: a drive world's shape — MERCURY_CONFIG_DIR and MERCURY_HOME both on one scratch home — is not the real store", !configHomeIsReal({ MERCURY_HOME: '/tmp/prove-fixture-world/home', MERCURY_CONFIG_DIR: '/tmp/prove-fixture-world/home' }))
  const throws = (env: NodeJS.ProcessEnv): boolean => {
    try {
      guardLoginDriverWrite('the test sweep', env)
      return false
    } catch (error) {
      return /real store/.test(error instanceof Error ? error.message : String(error))
    }
  }
  check('the guard THROWS a login-driver write with no pin at all (the leak road: an inherited or absent home)', throws({}))
  check('the guard THROWS a login-driver write pinned at the default home', throws({ MERCURY_CONFIG_DIR: join(homedir(), '.mercury') }))
  check('the guard PASSES a login-driver write under a scratch pin', !throws({ MERCURY_CONFIG_DIR: '/tmp/prove-fixture-scratch' }))
  check("the guard PASSES a drive world's shape", !throws({ MERCURY_HOME: '/tmp/prove-fixture-world/home', MERCURY_CONFIG_DIR: '/tmp/prove-fixture-world/home' }))
}

{
  check('the seeded fixture key reads as a fixture', looksLikeProofFixtureKey(FIXTURE))
  check('a real Gemini key (AIza…) does not', !looksLikeProofFixtureKey(REAL))
  check('an absent key is not a fixture', !looksLikeProofFixtureKey(undefined))
}

{
  guardLoginDriverWrite('the fixture-key guard proof')
  writeStoredGeminiApiKey(FIXTURE)
  check('the fixture key landed in the SCRATCH store (never the real one)', readStoredGeminiApiKey() === FIXTURE)
  const groups = deriveFamilySlotGroups(undefined, {
    geminiOauthConnected: () => false,
    geminiActiveAccount: () => ({ provider: 'gemini', kind: 'api-key', label: 'Gemini API key (stored)', keySource: 'stored' }),
    geminiStoredKey: () => FIXTURE,
    geminiEnvGoogleKey: () => undefined,
    geminiEnvGeminiKey: () => undefined,
  })
  const gemini = groups.find(g => g.family.id === 'gemini')
  const storedSlot = gemini?.slots.find(s => s.id === 'gemini:stored-key')
  check('the Gemini stored-key slot exists', storedSlot !== undefined, JSON.stringify(gemini?.slots.map(s => s.id)))
  check('its state note says the key is a test key, not a real Gemini API key, and names the removal gesture', (storedSlot?.stateNote ?? '') === 'a test key (zz-SECRE…), not a real Gemini API key — ⌫ removes it', storedSlot?.stateNote ?? '<none>')
  writeStoredGeminiApiKey(null)
}

{
  const face = read('scripts/ui/prove-face-logins.ts')
  check('prove-face-logins pins its own scratch home unconditionally (never ??= the ambient one)', face.includes("process.env['MERCURY_CONFIG_DIR'] = mkdtempSync(") && !face.includes("process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync("))
  check('the secrecy sweep calls the login-driver guard before it writes', face.includes('guardLoginDriverWrite('))
  const slots = read('src/services/providers/accountSlots.ts')
  check('the Gemini slot names a fixture-shaped stored key as a test key', slots.includes('a test key (zz-SECRE…), not a real Gemini API key'))
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
