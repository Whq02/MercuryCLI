#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s6-key-store.ts
//  PROOF:
//
//    1. Write/read/clear round-trip under a scratch auth scope; the file
//       lands beside the credentials store (auth-scope-resolved), mode 600,
//       versioned; unknown keys in the file survive a rewrite.
//    2. RESOLUTION PRECEDENCE: explicit env (ZAI_API_KEY) WINS over the
//       store; the store serves when env is absent; source labels are
//       honest ('env' | 'stored').
//    3. The adapter flips on a STORED key exactly as on an env key
//       (status available · account label names the stored source) — and
//       the VALUE never appears in any status/describe/discovery surface.
//    4. Auth-scope isolation: a different scope dir sees no key.
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s6-key-store.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' S6 — provider-secret store proof (hermetic scratch scope)')
console.log('============================================================')

const savedZaiKey = process.env.ZAI_API_KEY
const savedConfigDir = process.env.MERCURY_CONFIG_DIR
const scopeA = mkdtempSync(join(tmpdir(), 'prove-key-store-a-'))
const scopeB = mkdtempSync(join(tmpdir(), 'prove-key-store-b-'))
process.env.MERCURY_CONFIG_DIR = scopeA
delete process.env.ZAI_API_KEY

const {
  providerSecretsPathForDisplay,
  readStoredZaiApiKey,
  writeStoredZaiApiKey,
} = await import('../../src/utils/router/providerSecrets.js')
const {
  __resetProviderDiscoveryForTest,
  resolveZaiApiKey,
  zaiKeySource,
} = await import('../../src/utils/router/providerDiscovery.js')
const { zaiProviderAdapter } = await import('../../src/utils/router/providers/zai.js')

__resetProviderDiscoveryForTest()

//
section('1 · write/read/clear round-trip · mode 600 · unknown keys survive')
//
{
  check('empty scope: no stored key', readStoredZaiApiKey() === undefined)
  writeStoredZaiApiKey('  zai-stored-proof-key  ')
  check('stored key reads back trimmed', readStoredZaiApiKey() === 'zai-stored-proof-key')
  const path = providerSecretsPathForDisplay()
  check('file lives under the auth scope', path.startsWith(scopeA), path)
  const mode = statSync(path).mode & 0o777
  check('file mode is 600', mode === 0o600, mode.toString(8))

  // Unknown keys survive a rewrite (forward-compat law).
  const { readFileSync, writeFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  raw.futureProviderKey = 'kept'
  writeFileSync(path, JSON.stringify(raw), { mode: 0o600 })
  writeStoredZaiApiKey('zai-stored-proof-key-2')
  const rewritten = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  check('unknown keys survive a rewrite', rewritten.futureProviderKey === 'kept')
  check('version stamped', rewritten.version === 1)

  writeStoredZaiApiKey(null)
  check('clear removes the key', readStoredZaiApiKey() === undefined)
  writeStoredZaiApiKey('zai-stored-proof-key')
}

//
section('2 · resolution precedence — env WINS, store serves, sources honest')
//
{
  check("no env: resolves the stored key, source 'stored'", resolveZaiApiKey() === 'zai-stored-proof-key' && zaiKeySource() === 'stored')
  process.env.ZAI_API_KEY = 'zai-env-proof-key'
  check("env present: env WINS, source 'env'", resolveZaiApiKey() === 'zai-env-proof-key' && zaiKeySource() === 'env')
  delete process.env.ZAI_API_KEY
}

//
section('3 · the adapter flips on a stored key; the value never leaks')
//
{
  const status = zaiProviderAdapter.status()
  check('status available on the STORED key alone', status.available === true, status.reason ?? '')
  const description = zaiProviderAdapter.describe()
  check(
    "account label names the stored source",
    description.account.kind === 'api-key' && description.account.label.includes('stored'),
    description.account.label,
  )
  const surface = JSON.stringify({ status, description })
  check('the key VALUE never enters status/describe', !surface.includes('zai-stored-proof-key'), '')
}

//
section('4 · auth-scope isolation — a different scope sees no key')
//
{
  process.env.MERCURY_CONFIG_DIR = scopeB
  __resetProviderDiscoveryForTest()
  check('scope B: no stored key', readStoredZaiApiKey() === undefined)
  const status = zaiProviderAdapter.status()
  check("scope B: adapter honest 'no-api-key:zai'", status.available === false && status.reason === 'no-api-key:zai', status.reason)
}

// Restore the ambient env exactly.
if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY
else process.env.ZAI_API_KEY = savedZaiKey
if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = savedConfigDir
__resetProviderDiscoveryForTest()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S6 KEY-STORE PROOFS PASS')
else console.log(`${failures} S6 KEY-STORE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
