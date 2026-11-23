#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'start-wait-note-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const prefetch = await import(join(SRC, 'platform/secure-storage/keychainPrefetch.ts'))

let total = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  total++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const KEYCHAIN = 'checking the system keychain and managed settings…'
const STORE = 'checking the credential store and managed settings…'
const note = prefetch.startWaitNote as ((platform: string) => string) | undefined

console.log('the line a slow start writes, by platform')
check('on Windows it names the credential store', note?.('win32') === STORE, `Windows must say the credential store; fix credentialStoreWaitNote in src/platform/host-os/words.ts, which startWaitNote in src/platform/secure-storage/keychainPrefetch.ts returns; got ${note?.('win32')}`)
check('on macOS it keeps its words', note?.('darwin') === KEYCHAIN, `macOS must keep the keychain wording; fix credentialStoreWaitNote in src/platform/host-os/words.ts, which startWaitNote in src/platform/secure-storage/keychainPrefetch.ts returns; got ${note?.('darwin')}`)
check('on Linux it keeps the words it has', note?.('linux') === KEYCHAIN, `Linux must keep the keychain wording; fix credentialStoreWaitNote in src/platform/host-os/words.ts, which startWaitNote in src/platform/secure-storage/keychainPrefetch.ts returns; got ${note?.('linux')}`)


rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
