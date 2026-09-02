#!/usr/bin/env bun
// ============================================================================
//  prove-auth-scope-isolation — the in-session account switch (auth-scope
//  override) can NEVER interfere with a co-installed external harness.
//
//  The switch moves ONLY the credential store (getAuthConfigHomeDir); the
//  session home (getMercuryHome → transcripts, the global config file,
//  teams, TABULA, rooms) NEVER moves. This proof is the standing ratchet that
//  keeps it that way — a future edit routing a session-state path through the
//  auth scope, or the auto-relay reaching the foreign ~/.claude, fails HERE.
//
//   §1 CALLER FLOOR: getAuthConfigHomeDir() is called ONLY by the credential
//      store (plaintext path · keychain service · creds-mtime watch · refresh
//      lock) + the billing-display marker. No session-state module may call it.
//   §2 SCOPE-SETTER FLOOR: setAuthScope/clearAuthScope are called ONLY by the
//      relay switch + the isolated per-dir read bracket.
//   §3 REST = IDENTITY: with no override, getAuthConfigHomeDir() ===
//      getMercuryHome() (byte-identical).
//   §4 NO KEYCHAIN COLLISION: Mercury's sovereign home (~/.mercury) and the foreign
//      (~/.claude) resolve to DISTINCT keychain service names — Mercury never
//      reads/writes the external un-suffixed keychain entry at rest.
//   §5 SESSION HOME PINNED: while an override is active, getAuthConfigHomeDir()
//      moves but getMercuryHome() (the session home) does NOT.
//   §6 NO RELAY RING EXISTS: the launch-account roster and every auto-relay
//      station died with the switching machinery (account-slot
//      simplification, operator ruling) — pinned as absence.
// ============================================================================

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
/** Files (relative to src/) with a NON-COMMENT line containing `symbolCall`.
 *  Comment lines (// * /*) and JSDoc mentions are excluded so only real code
 *  references count — a call site or the definition signature. */
function callerFiles(symbolCall: string): string[] {
  let out = ''
  try {
    out = execSync(`grep -rnF ${JSON.stringify(symbolCall)} src --include='*.ts'`, {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch {
    return [] // no matches ⇒ grep exits 1
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
    'src/utils/envUtils.ts', // the definition (return authScopeOverride ?? …)
    'src/utils/secureStorage/plainTextStorage.ts', // creds file path
    'src/utils/secureStorage/macOsKeychainHelpers.ts', // keychain service name
    // The engines' secret store — a credential-plane
    // module BY DESIGN: .provider-secrets.json lives beside .credentials.json
    // under the SAME auth-scope bracket, so per-account isolation and
    // in-session switches hold for third-party engine keys exactly as for
    // Anthropic credentials. Never session state.
    'src/utils/router/providerSecrets.ts',
    // The OpenAI account-source owner — the SAME
    // credential-plane class: .openai-auth.json (subscription OAuth tokens)
    // lives beside .credentials.json under the auth-scope bracket, so
    // per-account isolation and in-session switches hold for the GPT
    // engine's sign-in exactly as for Anthropic credentials. Never session
    // state.
    'src/services/providers/openai/openaiAccounts.ts',
    // The digest-tied qualification-receipt store —
    // ACCOUNT-SOURCE EVIDENCE (.apex-qualification.json, no secrets): a
    // subscription's live qualification is not an API key's, so receipts
    // follow the account slot exactly like the credential files beside
    // them. Never session state.
    'src/services/providers/openai/qualificationStore.ts',
    // The four sibling account-source owners
    // carry the SAME credential-plane class as openaiAccounts — their auth
    // files (.gemini-auth.json · .huggingface-auth.json · .moonshot-auth.json
    // · .openrouter-auth.json) live beside .credentials.json under the
    // auth-scope bracket so per-account isolation and in-session switches
    // hold for every engine sign-in. Never session state.
    'src/services/providers/gemini/geminiAccounts.ts',
    'src/services/providers/huggingface/huggingfaceAccounts.ts',
    'src/services/providers/moonshot/moonshotAccounts.ts',
    'src/services/providers/openrouter/openrouterAccounts.ts',
    'src/utils/auth.ts', // creds-mtime watch + refresh lock + identity display
    // /doctor's config-home coherence check: read-only DISPLAY
    // of credential identity — it keys the keychain-suffix test on the home
    // the service actually derives from (never a session-state path; the
    // session-home compare false-positived an env-pinned run as a
    // 'credential identity split').
    'src/utils/healthReport.ts',
    // SATURN's account capture (the capture-is-WHO law,
    // verified-good): the schedule's provenance row reads the scope DIR and
    // the identity snapshot from the credential home — identity display,
    // never a token, never session state (prove-saturn-medic's smuggle
    // teeth hold the no-secret shape). Joined the floor when the
    // suite ran red on main with the lawful caller unlisted.
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
    'src/utils/accounts/scopedCredentialRead.ts', // the isolated per-dir read bracket
    'src/utils/envUtils.ts', // the definitions themselves
    // The in-board scoped reauth (the account rework): the SAVE
    // bracket — setAuthScope(dir) so saveOAuthTokensIfNeeded lands the new
    // credential in the TARGET slot's keychain, restored in `finally` (both
    // caches cleared). The operator's own gesture, same audit class as the
    // relay switch.
    'src/utils/accounts/scopedReauth.ts',
  ])
  for (const call of ['setAuthScope(', 'clearAuthScope(']) {
    const callers = callerFiles(call)
    const rogue = callers.filter(f => !sanctioned.has(f))
    check(rogue.length === 0, `no unexpected caller of ${call}…)`, rogue.length ? `ROGUE: ${rogue.join(', ')}` : callers.join(', '))
  }
}

// Behavioral legs — hermetic (a tmp sovereign home; never the real config).
const PREV = process.env.MERCURY_CONFIG_DIR
const PREV_MCD = process.env.MERCURY_CONFIG_DIR
const PREV_MH = process.env.MERCURY_HOME
// scrub the canonical spellings — the pooled gate exports them and they
// outrank every MERCURY_CONFIG_DIR pin below (second-eyes adjudication class)
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
  // The literal foreign path is this law's INPUT (the un-suffixed entry is keyed
  // on exactly that spelling) and is used as a string only — the derivation
  // reads nothing and writes nothing under that directory.
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
  // The station roster (accountSnapshot/launchAccounts) RETIRED
  // with the account-ring switching machinery. Pin the absence structurally:
  // the module is deleted and no live source resolves a launch-account ring.
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
