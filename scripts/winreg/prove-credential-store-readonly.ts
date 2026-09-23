#!/usr/bin/env bun
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'credential-readonly-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { plainTextStorage } = await import('../../src/utils/secureStorage/plainTextStorage.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' saving over a read-only credential store')
console.log('============================================================')

const store = join(HOME, '.credentials.json')
writeFileSync(store, JSON.stringify({ trustedDeviceToken: 'fixture-old' }))
chmodSync(store, 0o400)

const saved = plainTextStorage.update({ trustedDeviceToken: 'fixture-new' } as never)
check('the save succeeds', saved.success === true, JSON.stringify(saved))
let content = ''
try {
  content = readFileSync(store, 'utf8')
} catch (error) {
  content = String(error)
}
check('the store holds the new credential', content.includes('fixture-new'), content)
check('a read of the store returns the new credential', (plainTextStorage.read() as { trustedDeviceToken?: string } | null)?.trustedDeviceToken === 'fixture-new')

try {
  chmodSync(store, 0o600)
} catch {
}
try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL READ-ONLY CREDENTIAL STORE CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
