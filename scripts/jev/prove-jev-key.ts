#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-key-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.TYPESAFE_API_KEY
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const PROOF_KEY = 'proof-key-jev-not-a-real-key-0001'
const ENV_KEY = 'proof-key-jev-env-pin-not-real-0002'

const secrets = await import('../../src/utils/router/providerSecrets.js')
const key = await import('../../src/services/jev/jevKey.js')
const ledger = await import('../../src/services/jev/jevLedger.js')
const { credentialEnvNames, providerSecretsPathForDisplay, readStoredTypesafeApiKey } = secrets
const { JEV_KEY_ENV, jevKeyPresence, jevKeySourceWords, resolveJevApiKey, storeJevApiKey } = key
const { jevLedgerSnapshot, noteJevWireFailure, resetJevLedger } = ledger

const filesMentioning = (needle: string): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (readFileSync(p, 'utf8').includes(needle)) out.push(p)
    }
  }
  walk(HOME)
  return out
}

section('§1 keyless by default')
check('no key resolves from a fresh home', resolveJevApiKey({}) === undefined)
check('presence reads absent', jevKeyPresence({}).present === false)
check('the words say no key', jevKeySourceWords(jevKeyPresence({})) === 'no key')
check('the env name is TYPESAFE_API_KEY', JEV_KEY_ENV === 'TYPESAFE_API_KEY')
check('the secrets owner enumerates it for the kernel env filter', credentialEnvNames().includes('TYPESAFE_API_KEY'))

section('§2 the pasted key rests in the provider-secrets store with the same laws')
storeJevApiKey(`  ${PROOF_KEY}  `)
check('the store holds the trimmed key', readStoredTypesafeApiKey() === PROOF_KEY)
const path = providerSecretsPathForDisplay()
check('the store file lives under the proof home', path.startsWith(HOME) && existsSync(path), path)
check('mode 600', (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8))
const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
check('the field is typesafeApiKey beside the other keys', stored.typesafeApiKey === PROOF_KEY && typeof stored.version === 'number')
const resolved = resolveJevApiKey({})
check('the resolver answers the stored key with its source', resolved?.key === PROOF_KEY && resolved.source === 'stored')
const presence = jevKeyPresence({})
check('presence names the source only', presence.present === true && presence.source === 'stored' && !JSON.stringify(presence).includes(PROOF_KEY))
check('the words never carry the value', !jevKeySourceWords(presence).includes(PROOF_KEY) && /stored/.test(jevKeySourceWords(presence)))
check('storing the key recorded no sign-in and moved no default: only the secrets file mentions it', filesMentioning(PROOF_KEY).length === 1 && filesMentioning(PROOF_KEY)[0] === path, filesMentioning(PROOF_KEY).join(','))
check('no sign-in ledger names the provider', !filesMentioning('typesafe').some(p => p !== path), filesMentioning('typesafe').join(','))

section('§3 an environment pin outranks the store, and is never the store')
const env = { TYPESAFE_API_KEY: ENV_KEY }
const pinned = resolveJevApiKey(env)
check('the env key wins', pinned?.key === ENV_KEY && pinned.source === 'env')
check('presence says env', jevKeyPresence(env).present === true && (jevKeyPresence(env) as { source: string }).source === 'env')
check('the words say the environment outranks the store, without the value', /environment outranks the store/.test(jevKeySourceWords(jevKeyPresence(env))) && !jevKeySourceWords(jevKeyPresence(env)).includes(ENV_KEY))
check('the store is untouched by the pin', readStoredTypesafeApiKey() === PROOF_KEY)
check('a blank pin is no pin', resolveJevApiKey({ TYPESAFE_API_KEY: '   ' })?.source === 'stored')

section('§4 a new key clears an invalid-key record; clearing the key leaves nothing behind')
resetJevLedger()
noteJevWireFailure({ kind: 'invalid-key', status: 401, detail: 'Unauthorized' }, 1_700_000_000_000, () => 0.5)
check('a 401 is on record', jevLedgerSnapshot(1_700_000_000_000).lastWire?.kind === 'invalid-key')
storeJevApiKey('proof-key-jev-replacement-not-real-0003')
check('storing a new key clears it', jevLedgerSnapshot(1_700_000_000_000).lastWire === null)
storeJevApiKey(null)
check('clearing removes the field', readStoredTypesafeApiKey() === undefined && !('typesafeApiKey' in (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)))
check('and presence reads absent again', jevKeyPresence({}).present === false)
check('no file under the home still carries any proof key', filesMentioning('proof-key-jev').length === 0, filesMentioning('proof-key-jev').join(','))

resetJevLedger()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
