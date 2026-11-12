#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'export-secret-set-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const { setAuthScope } = await import(join(SRC, 'utils/envUtils.ts'))
const auth = await import(join(SRC, 'utils/auth.ts'))
const redaction = await import(join(SRC, 'utils/redactSecrets.ts'))

let total = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  total++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

let homes = 0
async function exportOver(store: Record<string, unknown>): Promise<{ values: string[]; redact: (text: string) => string }> {
  const home = join(SCRATCH, `home-${++homes}`)
  mkdirSync(home, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = home
  setAuthScope(home)
  writeFileSync(join(home, '.credentials.json'), JSON.stringify(store))
  auth.clearOAuthTokenCache()
  const values = (await redaction.sessionSecretValues()) as string[]
  return { values, redact: redaction.createSecretRedactor(values) as (text: string) => string }
}

const SIGNED_IN = {
  claudeAiOauth: {
    accessToken: 'fixture-access-AAAA',
    refreshToken: 'fixture-refresh-BBBB',
    expiresAt: 4102444800000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default',
    profile: {
      account: { uuid: 'fixture-account-id', email: 'someone@example.test', display_name: 'Fixture Person', created_at: '2026-01-02T03:04:05Z', has_claude_max: true },
      organization: { uuid: 'fixture-organisation-id', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', billing_type: 'free', subscription_created_at: '2026-01-03T00:00:00Z' },
    },
    tokenAccount: { uuid: 'fixture-account-id', emailAddress: 'someone@example.test' },
    writtenByALaterBuild: 'fixture-later-field',
  },
  mcpOAuth: {
    'linear|0a1b2c': {
      serverName: 'linear',
      serverUrl: 'https://mcp.example.test/sse',
      accessToken: 'fixture-mcp-access',
      refreshToken: 'fixture-mcp-refresh',
      clientSecret: 'fixture-client-secret',
      expiresAt: 4102444800000,
      scope: 'read',
      stepUpScope: 'write',
      writtenByALaterBuild: 'fixture-later-mcp-field',
    },
  },
  extensionSecrets: { 'ext-1': { key: 'abcde' } },
  trustedDeviceToken: 'fixture-device-token',
}
const WORDS = ['user:inference', 'user:profile', 'max', 'default', 'claude_max', 'default_claude_max_20x', 'free', 'read', 'write']
const LINE = 'The maximum key size of the default process is set by user:inference; billing is free on claude_max, the tier default_claude_max_20x, and the server may read and write.'

section('§1 the words saved beside the tokens are not secrets: an export keeps them')
{
  const signedIn = await exportOver(SIGNED_IN)
  check('an export of a signed-in session keeps its sentence whole', signedIn.redact(LINE) === LINE, signedIn.redact(LINE))
  check('the scope words, the subscription\'s word, the tier\'s and the billing word are not in the set of secrets', WORDS.every(word => !signedIn.values.includes(word)), WORDS.filter(word => signedIn.values.includes(word)).join(', '))
}

section('§2 every secret is still hidden, the short one among them, and so is whatever the set does not know')
{
  process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home-key')
  mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
  await auth.saveApiKey('fixture-api-key-CCCC')
  const keyHome = process.env.MERCURY_CONFIG_DIR
  writeFileSync(join(keyHome, '.credentials.json'), JSON.stringify(SIGNED_IN))
  setAuthScope(keyHome)
  const values = (await redaction.sessionSecretValues()) as string[]
  const redact = redaction.createSecretRedactor(values) as (text: string) => string
  const SECRETS: Array<[string, string]> = [
    ['the access token', 'fixture-access-AAAA'],
    ['the refresh token', 'fixture-refresh-BBBB'],
    ['the API key', 'fixture-api-key-CCCC'],
    ['an extension\'s secret of five characters', 'abcde'],
    ['an MCP access token', 'fixture-mcp-access'],
    ['an MCP refresh token', 'fixture-mcp-refresh'],
    ['an MCP client secret', 'fixture-client-secret'],
    ['the device token', 'fixture-device-token'],
  ]
  for (const [label, value] of SECRETS) {
    const exported = redact(`a line that holds ${value} in the middle`)
    check(`${label} is in the set and is replaced in an export`, values.includes(value) && !exported.includes(value), exported)
  }
  check('a string field a later build writes beside the tokens is hidden until it is named', values.includes('fixture-later-field') && values.includes('fixture-later-mcp-field'), values.filter(value => value.includes('later')).join(', '))
  check('the limit that stays: who the user is, a server\'s name and its address are still in the set', ['Fixture Person', 'someone@example.test', 'fixture-account-id', 'linear', 'https://mcp.example.test/sse'].every(value => values.includes(value)), JSON.stringify(values.filter(value => !value.startsWith('fixture-'))))
  check('and the words are out of the set here too', WORDS.every(word => !values.includes(word)), WORDS.filter(word => values.includes(word)).join(', '))
}

section('§3 a word is left out by where it is stored, never by what it says')
{
  const same = await exportOver({ ...SIGNED_IN, extensionSecrets: { 'ext-1': { plan: 'max' } } })
  check('a secret that happens to be the subscription\'s word is still replaced wherever it stands', same.values.includes('max') && same.redact('the maximum') === 'the [redacted]imum', same.redact('the maximum'))
  const moved = await exportOver({ scopes: ['fixture-top-level-list'], mcpOAuth: { scope: 'fixture-not-an-entry', 'x|1': { nested: { scope: 'fixture-deeper-scope' } } }, claudeAiOauth: { profile: { account: { billing_type: 'fixture-elsewhere' } } } })
  check('the same field names anywhere else in the store name nothing', ['fixture-top-level-list', 'fixture-not-an-entry', 'fixture-deeper-scope', 'fixture-elsewhere'].every(value => moved.values.includes(value)), JSON.stringify(moved.values))
}

rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
console.log(failures === 0 ? `\nALL ${total} CHECKS PASS` : `\n${failures} OF ${total} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
