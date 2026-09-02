#!/usr/bin/env bun
// ============================================================================
//  scripts/accounts/prove-keychain-username.ts — the keychain entry's account
//  name ladder (secureStorage/macOsKeychainHelpers.getUsername): a truthy
//  USER wins, then the OS user-info username, and the literal fallback —
//  the product's own spelling — applies only when reading user info throws.
//  The fallback carries no foreign product name (bucket-3 vocabulary
//  cleanup, operator-classified).
// ============================================================================
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { getUsername, KEYCHAIN_FALLBACK_USERNAME } = await import(
  '../../src/utils/secureStorage/macOsKeychainHelpers.ts'
)

console.log('keychain username — the ladder and the product-spelled fallback')
const prior = process.env.USER
process.env.USER = 'fixture-operator'
check('a truthy USER wins', getUsername() === 'fixture-operator', getUsername())
delete process.env.USER
let osName: string | undefined
try {
  osName = userInfo().username
} catch {
  osName = undefined
}
check(
  'with USER unset, the OS user-info username answers (the fallback only when that read throws)',
  osName === undefined ? getUsername() === KEYCHAIN_FALLBACK_USERNAME : getUsername() === osName,
  getUsername(),
)
if (prior === undefined) delete process.env.USER
else process.env.USER = prior

check("the fallback is the product's own spelling", KEYCHAIN_FALLBACK_USERNAME === 'mercury-user', KEYCHAIN_FALLBACK_USERNAME)
const src = readFileSync(join(import.meta.dir, '../../src/utils/secureStorage/macOsKeychainHelpers.ts'), 'utf8')
check('the fallback is reached only from the user-info catch arm', /catch \{\s*return KEYCHAIN_FALLBACK_USERNAME\s*\}/.test(src))
check('no foreign product name survives in the helper', !/claude-code-user/.test(src))

console.log(failures === 0 ? 'KEYCHAIN USERNAME: ALL GREEN' : `KEYCHAIN USERNAME: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
