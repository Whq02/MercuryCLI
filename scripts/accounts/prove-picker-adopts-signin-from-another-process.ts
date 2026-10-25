#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'picker-signin-'))
const HOME = join(SCRATCH, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
mkdirSync(HOME, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = 'http://127.0.0.1:1'
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
delete process.env.MERCURY_API_KEY_FILE_DESCRIPTOR
delete process.env.CI
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const KEY = 'sk-ant-api03-picker-signin-proof'
const TOKEN = 'at_picker_signin_proof'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const WRITER = join(SCRATCH, 'writer.ts')
writeFileSync(
  WRITER,
  `process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.CI
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs, saveGlobalConfig, getGlobalConfig } = await import(${JSON.stringify(join(ROOT, 'src/utils/config/globalConfig.ts'))})
enableConfigs()
if (process.argv[2] === 'key') {
  saveGlobalConfig(c => ({ ...c, primaryApiKey: ${JSON.stringify(KEY)} }))
  console.log('WROTE ' + (getGlobalConfig().primaryApiKey === ${JSON.stringify(KEY)}))
} else {
  const auth = await import(${JSON.stringify(join(ROOT, 'src/utils/auth.ts'))})
  const r = auth.saveOAuthTokensIfNeeded({
    accessToken: ${JSON.stringify(TOKEN)},
    refreshToken: 'rt_picker_signin_proof',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: null,
  })
  console.log('WROTE ' + r.success)
}
`,
)
const runWriter = (mode: 'key' | 'oauth'): boolean => {
  const r = spawnSync(process.execPath, ['run', WRITER, mode], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env }, timeout: 60_000 })
  const ok = r.status === 0 && /WROTE true/.test(r.stdout)
  if (!ok) console.log(`    writer(${mode}) rc=${r.status}\n${r.stdout}\n${r.stderr}`.trim())
  return ok
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const usage = await import('../../src/services/providers/providerUsage.ts')
const { getModelOptions, ANTHROPIC_CONNECT_OPTION_VALUE } = await import('../../src/utils/model/modelOptions.ts')
const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')

const anthropicRows = (): Array<{ value: string; unavailable?: string }> =>
  getModelOptions().filter(option => option.group === undefined && !option.value.startsWith('__') && /sonnet|opus|haiku|fable/i.test(option.value))
const connectRowShown = (): boolean => getModelOptions().some(option => option.value === ANTHROPIC_CONNECT_OPTION_VALUE)
const logins = (): { signedIn: boolean } => {
  const group = deriveFamilySlotGroups().find(candidate => candidate.family.id === 'anthropic')
  return { signedIn: group?.slots.some(slot => slot.signedIn) === true }
}

console.log('============================================================')
console.log(' the model picker and /logins agree after a sign-in another process stored')
console.log('============================================================')

section('§1 the chat boots signed out: the picker says so')
{
  const rows = anthropicRows()
  check('the Anthropic model rows exist', rows.length > 0, String(rows.length))
  check('presence: not credentialed', usage.anthropicCredentialPresence().credentialed === false)
  check('every Anthropic model row is "not signed in"', rows.every(row => typeof row.unavailable === 'string' && row.unavailable.startsWith('not signed in')), JSON.stringify(rows.map(row => row.unavailable)))
  check('the sign-in row is offered', connectRowShown())
  check('/logins agrees: no signed-in Anthropic slot', logins().signedIn === false)
}

section('§2 the owner signs in from another window — the next time the picker opens it agrees with /logins, with no API turn in between')
{
  check('the login writer landed the sign-in', runWriter('oauth'))
  check('the credential file exists', existsSync(join(HOME, '.credentials.json')))
  check('/logins (it scans the files) shows the slot signed in', logins().signedIn === true)
  const presence = usage.anthropicCredentialPresence()
  check('PRESENCE ADOPTS THE SIGN-IN (the token memo held boot\'s null for the process\'s whole life)', presence.credentialed === true, JSON.stringify(presence))
  check('…as the Claude subscription', presence.credentialLabel === 'Claude subscription (max)', String(presence.credentialLabel))
  const rows = anthropicRows()
  check('no Anthropic model row says "not signed in" now', rows.every(row => row.unavailable === undefined), JSON.stringify(rows.filter(row => row.unavailable !== undefined).map(row => `${row.value}: ${row.unavailable}`)))
  check('the sign-in row is gone', !connectRowShown())
  check('the family presence list (the heading, the usage page, the status) agrees', usage.providerFamilyPresences().find(family => family.id === 'anthropic')?.credentialed === true)
  check('the sign-in is not read as expired', auth.isAnthropicOAuthSignInExpired() === false)
}

section('§3 the owner signs out from another window — the picker follows that way too')
{
  unlinkSync(join(HOME, '.credentials.json'))
  check('presence: not credentialed again', usage.anthropicCredentialPresence().credentialed === false)
  check('every Anthropic model row is "not signed in" again', anthropicRows().every(row => typeof row.unavailable === 'string'))
  check('/logins agrees: no signed-in Anthropic slot', logins().signedIn === false)
}

section('§4 a managed key stored from another window is adopted the same way')
{
  check('the /logins writer landed the key', runWriter('key'))
  let adopted: ReturnType<typeof usage.anthropicCredentialPresence> | null = null
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const presence = usage.anthropicCredentialPresence()
    if (presence.credentialed) {
      adopted = presence
      break
    }
    await sleep(200)
  }
  check('PRESENCE ADOPTS THE MANAGED KEY without a refresh turn', adopted !== null, 'still not credentialed after 8s')
  check('…as the Anthropic API key', adopted?.credentialLabel === 'Anthropic API key', String(adopted?.credentialLabel))
  check('the Anthropic model rows are selectable', anthropicRows().every(row => row.unavailable === undefined))
}

section('§5 the shape: the one presence reader checks the credential files before it answers')
{
  const providerUsage = readFileSync(join(ROOT, 'src/services/providers/providerUsage.ts'), 'utf8')
  const start = providerUsage.indexOf('export function anthropicCredentialPresence(')
  const body = providerUsage.slice(start, providerUsage.indexOf('\n}\n', start))
  check('the live path (no injected reads) runs the on-disk invalidator first', /if \(reads === undefined\) invalidateOnDiskChange\(\)/.test(body) && body.indexOf('invalidateOnDiskChange()') !== -1 && body.indexOf('invalidateOnDiskChange()') < body.indexOf('isClaudeAISubscriber()'))
  check('auth.ts exports the invalidator', /export function invalidateOnDiskChange\(\)/.test(readFileSync(join(ROOT, 'src/utils/auth.ts'), 'utf8')))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-picker-adopts-signin-from-another-process${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
