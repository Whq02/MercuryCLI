#!/usr/bin/env bun
import { userInfo } from 'node:os'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { getUsername, KEYCHAIN_FALLBACK_USERNAME } = await import(
  '../../src/platform/secure-storage/macOsKeychainHelpers.ts'
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

console.log(failures === 0 ? 'KEYCHAIN USERNAME: ALL GREEN' : `KEYCHAIN USERNAME: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
