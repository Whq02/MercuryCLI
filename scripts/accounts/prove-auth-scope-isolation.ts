#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
function callerFiles(symbolCall: string): string[] {
  let out = ''
  try {
    out = execSync(`grep -rnF ${JSON.stringify(symbolCall)} src --include='*.ts'`, {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch {
    return []
  }
  const files = new Set<string>()
  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):\d+:(.*)$/)
    if (!m) continue
    const trimmed = m[2]!.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    files.add(m[1]!)
  }
  return [...files].sort()
}

section('§1 CALLER FLOOR — getAuthConfigHomeDir() only in the credential store + billing display')
{
  const sanctioned = new Set([
    'src/utils/envUtils.ts',
    'src/utils/secureStorage/plainTextStorage.ts',
    'src/utils/secureStorage/macOsKeychainHelpers.ts',
    'src/utils/router/providerSecrets.ts',
    'src/utils/redactSecrets.ts',
    'src/services/providers/openai/openaiAccounts.ts',
    'src/services/providers/openai/qualificationStore.ts',
    'src/services/providers/anthropic/modelRefusal.ts',
    'src/services/providers/gemini/geminiAccounts.ts',
    'src/services/providers/huggingface/huggingfaceAccounts.ts',
    'src/services/providers/moonshot/moonshotAccounts.ts',
    'src/services/providers/openrouter/openrouterAccounts.ts',
    'src/services/providers/xai/xaiOauth.ts',
    'src/utils/auth.ts',
    'src/utils/healthReport.ts',
    'src/daemon/saturnAccount.ts',
    'src/daemon/signInView.ts',
  ])
  const callers = callerFiles('getAuthConfigHomeDir()')
  check(callers.length > 0, 'the seam is actually wired (has callers)', callers.join(', '))
  const rogue = callers.filter(f => !sanctioned.has(f))
  check(rogue.length === 0, 'no session-state module calls getAuthConfigHomeDir()', rogue.length ? `ROGUE: ${rogue.join(', ')}` : 'clean')
}

section('§2 SCOPE-SETTER FLOOR — setAuthScope/clearAuthScope only in the switch + the isolated read')
{
  const sanctioned = new Set([
    'src/utils/accounts/scopedCredentialRead.ts',
    'src/utils/envUtils.ts',
    'src/utils/accounts/scopedReauth.ts',
  ])
  for (const call of ['setAuthScope(', 'clearAuthScope(']) {
    const callers = callerFiles(call)
    const rogue = callers.filter(f => !sanctioned.has(f))
    check(rogue.length === 0, `no unexpected caller of ${call}…)`, rogue.length ? `ROGUE: ${rogue.join(', ')}` : callers.join(', '))
  }
}

const PREV = process.env.MERCURY_CONFIG_DIR
const PREV_MCD = process.env.MERCURY_CONFIG_DIR
const PREV_MH = process.env.MERCURY_HOME
delete process.env.MERCURY_CONFIG_DIR
delete process.env.MERCURY_HOME
const env = await import('../../src/utils/envUtils.js')
const keychain = await import('../../src/utils/secureStorage/macOsKeychainHelpers.js')

section('§3 REST = IDENTITY — no override ⇒ getAuthConfigHomeDir() === getMercuryHome()')
{
  env.clearAuthScope()
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.mercury')
  check(env.getAuthScope() === undefined, 'no auth scope at rest')
  check(env.getAuthConfigHomeDir() === env.getMercuryHome(), 'auth home === session home at rest (byte-identical)')
}

section('§4 NO KEYCHAIN COLLISION — Mercury ~/.mercury and a foreign-named home are DISTINCT entries, both hashed')
{
  env.clearAuthScope()
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.mercury')
  const mercurySvc = keychain.getMacOsKeychainStorageServiceName(keychain.CREDENTIALS_SERVICE_SUFFIX)
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.claude')
  const foreignSvc = keychain.getMacOsKeychainStorageServiceName(keychain.CREDENTIALS_SERVICE_SUFFIX)
  check(mercurySvc !== foreignSvc, 'sovereign and foreign keychain service names differ', `${mercurySvc} vs ${foreignSvc}`)
  check(/-[0-9a-f]{8}$/.test(mercurySvc), 'sovereign home is HASH-suffixed', mercurySvc)
  check(/-[0-9a-f]{8}$/.test(foreignSvc), 'the foreign-named home is hashed too — never an un-suffixed entry', foreignSvc)
}

section('§5 SESSION HOME PINNED — an override moves the auth home, NOT the session home')
{
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.mercury')
  const sessionHome = env.getMercuryHome()
  const target = join(homedir(), '.mercury-account-b')
  env.setAuthScope(target)
  check(env.getAuthConfigHomeDir() === target, 'override moves the credential store to the switched account', env.getAuthConfigHomeDir())
  check(env.getMercuryHome() === sessionHome, 'the session home (transcripts/config/rooms) is UNMOVED', env.getMercuryHome())
  env.clearAuthScope()
  check(env.getAuthConfigHomeDir() === sessionHome, 'clearing the override restores the session home for creds too')
}

section('§6 NO RELAY RING EXISTS — the roster module and its stations are gone')
{
  check(!existsSync(join(import.meta.dir, '../../src/utils/accountSnapshot.ts')), 'the roster module is deleted')
  const hits = execSync(
    "grep -rl 'launchAccounts(' ../../src --include='*.ts' --include='*.tsx' || true",
    { cwd: import.meta.dir, encoding: 'utf8' },
  ).trim()
  check(hits === '', 'no live source consumes a launch-account ring', hits)
}

section('§7 EXPORT REDACTION reads the active credential scope without moving session state')
{
  const scratch = mkdtempSync(join(tmpdir(), 'export-auth-scope-'))
  const sessionHome = join(scratch, 'session')
  const authHome = join(scratch, 'auth')
  mkdirSync(sessionHome)
  mkdirSync(authHome)
  const sessionBytes = JSON.stringify({ trustedDeviceToken: 'sessionCredentialFixture' })
  const authBytes = JSON.stringify({ trustedDeviceToken: 'scopedCredentialFixture' })
  writeFileSync(join(sessionHome, '.credentials.json'), sessionBytes)
  writeFileSync(join(authHome, '.credentials.json'), authBytes)
  process.env.MERCURY_CONFIG_DIR = sessionHome
  const credentialStore = process.env.MERCURY_CREDENTIAL_STORE
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  try {
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
    enableConfigs()
    const { sessionSecretValues } = await import('../../src/utils/redactSecrets.js')
    env.setAuthScope(authHome)
    const values = await sessionSecretValues()
    check(values.includes('scopedCredentialFixture') && !values.includes('sessionCredentialFixture'), 'the export masker reads credentials from the auth scope, not the session home')
    check(env.getMercuryHome() === sessionHome, 'the export masker leaves the session home unchanged')
    check(readFileSync(join(sessionHome, '.credentials.json'), 'utf8') === sessionBytes && readFileSync(join(authHome, '.credentials.json'), 'utf8') === authBytes, 'the export masker rewrites neither credential store')
  } finally {
    env.clearAuthScope()
    if (credentialStore === undefined) delete process.env.MERCURY_CREDENTIAL_STORE
    else process.env.MERCURY_CREDENTIAL_STORE = credentialStore
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (PREV === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = PREV
if (PREV_MCD === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = PREV_MCD
if (PREV_MH === undefined) delete process.env.MERCURY_HOME
else process.env.MERCURY_HOME = PREV_MH

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '✅ AUTH-SCOPE ISOLATION GREEN' : `❌ AUTH-SCOPE ISOLATION RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
