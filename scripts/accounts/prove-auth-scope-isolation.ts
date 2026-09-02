#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
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
    'src/services/providers/openai/openaiAccounts.ts',
    'src/services/providers/openai/qualificationStore.ts',
    'src/services/providers/gemini/geminiAccounts.ts',
    'src/services/providers/huggingface/huggingfaceAccounts.ts',
    'src/services/providers/moonshot/moonshotAccounts.ts',
    'src/services/providers/openrouter/openrouterAccounts.ts',
    'src/utils/auth.ts',
    'src/utils/healthReport.ts',
    'src/daemon/saturnAccount.ts',
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

section('§4 NO KEYCHAIN COLLISION — Mercury ~/.mercury vs the foreign ~/.claude are DISTINCT entries')
{
  env.clearAuthScope()
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.mercury')
  const mercurySvc = keychain.getMacOsKeychainStorageServiceName(keychain.CREDENTIALS_SERVICE_SUFFIX)
  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.claude')
  const foreignSvc = keychain.getMacOsKeychainStorageServiceName(keychain.CREDENTIALS_SERVICE_SUFFIX)
  check(mercurySvc !== foreignSvc, 'sovereign and foreign keychain service names differ', `${mercurySvc} vs ${foreignSvc}`)
  check(/-[0-9a-f]{8}$/.test(mercurySvc), 'sovereign home is HASH-suffixed (never the un-suffixed foreign entry)', mercurySvc)
  check(!/-[0-9a-f]{8}$/.test(foreignSvc), 'the foreign ~/.claude stays the un-suffixed default entry', foreignSvc)
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

if (PREV === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = PREV
if (PREV_MCD === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = PREV_MCD
if (PREV_MH === undefined) delete process.env.MERCURY_HOME
else process.env.MERCURY_HOME = PREV_MH

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '✅ AUTH-SCOPE ISOLATION GREEN' : `❌ AUTH-SCOPE ISOLATION RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
