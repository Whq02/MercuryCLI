#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' per-slot sign-out — one field leaves, the siblings stay')
console.log('============================================================')

for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
]) {
  delete process.env[key]
}
const scratch = mkdtempSync(join(tmpdir(), 'prove-slot-signout-scope-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const credentialsPath = join(home, '.credentials.json')
const far = Date.now() + 365 * 24 * 3600_000
const seed = (): void => {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'fixture-access', refreshToken: '', expiresAt: far, scopes: ['user:inference'], subscriptionType: null },
      mcpOAuth: { 'srv|abc': { accessToken: 'mcp-fixture', clientId: 'c' } },
      mcpOAuthClientConfig: { 'srv|abc': { clientId: 'c' } },
      extensionSecrets: { 'ext.one': { token: 'ext-fixture' } },
      trustedDeviceToken: 'device-fixture',
    }),
  )
}
const readStore = (): Record<string, unknown> | null => {
  if (!existsSync(credentialsPath)) return null
  return JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>
}
const SIBLINGS = ['mcpOAuth', 'mcpOAuthClientConfig', 'extensionSecrets', 'trustedDeviceToken'] as const
const siblingsIntact = (store: Record<string, unknown> | null): boolean =>
  store !== null && SIBLINGS.every(k => store[k] !== undefined)

section('§1 removeSecureStorageField — exactly one field leaves')
{
  const storage = (await import('../../src/utils/secureStorage/index.js')) as Record<string, unknown>
  const door = storage.removeSecureStorageField as
    | ((field: string) => { removed: boolean; kept: number; success: boolean })
    | undefined
  check('the one-field door exists on the secure-storage owner', typeof door === 'function')
  if (typeof door === 'function') {
    seed()
    const first = door('claudeAiOauth')
    const after = readStore()
    check('the field is reported removed and the write landed', first.removed && first.success, JSON.stringify(first))
    check('the store still exists on disk', after !== null)
    check('claudeAiOauth is gone', after !== null && after.claudeAiOauth === undefined)
    check(`every sibling field survives (${SIBLINGS.join(', ')})`, siblingsIntact(after), JSON.stringify(after))
    check('the receipt counts the kept siblings', first.kept === SIBLINGS.length, String(first.kept))
    const again = door('claudeAiOauth')
    check('a repeat removal is a no-op that still succeeds', !again.removed && again.success && again.kept === SIBLINGS.length, JSON.stringify(again))
    check('the no-op rewrote nothing away', siblingsIntact(readStore()))
    writeFileSync(credentialsPath, JSON.stringify({ trustedDeviceToken: 'only' }))
    const last = door('trustedDeviceToken')
    check('removing the last field deletes the emptied store', last.removed && last.success && !existsSync(credentialsPath), JSON.stringify(last))
    const absent = door('claudeAiOauth')
    check('an absent store is never written (nothing to remove, nothing clobbered)', !absent.removed && absent.success && !existsSync(credentialsPath), JSON.stringify(absent))
  }
}

section('§2 the /logins slot road — the default sign-out keeps the siblings')
{
  seed()
  const { executeSlotRemoval } = await import('../../src/services/providers/accountSlots.js')
  const slot = {
    family: 'anthropic', id: home, name: 'primary', kind: 'oauth' as const,
    kindLabel: 'OAuth', identity: 'a@x.com', active: true, envPinned: false, signedIn: true,
    scope: { name: 'primary', dir: home, isCurrent: true, hasConfig: true, authed: true, claudeFamily: false },
    removal: { route: 'anthropic-oauth' as const, dir: home },
  }
  const out = executeSlotRemoval(slot as never)
  check('the board answers mutated with the this-login-only receipt', out.mutated && /this Claude login/.test(out.note), out.note)
  const deadline = Date.now() + 8_000
  let settled = readStore()
  while (Date.now() < deadline && settled !== null && settled.claudeAiOauth !== undefined) {
    await new Promise(r => setTimeout(r, 50))
    settled = readStore()
  }
  check('the sign-out settled (the OAuth field left)', settled === null || settled.claudeAiOauth === undefined)
  check('the credential file still exists after the per-slot sign-out', settled !== null, 'the whole file was deleted')
  check(`the MCP sessions, IDP sessions, extension secrets and device token all survive`, siblingsIntact(settled), JSON.stringify(settled))
}

section('§3 /logout keeps the whole-file delete (the global verb)')
{
  const logoutSrc = readFileSync(join(import.meta.dir, '../../src/commands/logout/logout.tsx'), 'utf8')
  check('/logout deletes the whole store', logoutSrc.includes('getSecureStorage().delete()'))
  const slotsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  check('the per-slot sign-out never calls the whole-store delete', !slotsSrc.includes('getSecureStorage().delete()'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-slot-signout-scope${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
