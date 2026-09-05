#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'credential-words-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.CI = '1'
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_BASE_URL'] as const
for (const name of CREDENTIAL_VARS) delete process.env[name]

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const auth = await import('../../src/utils/auth.ts')
const errors = await import('../../src/services/api/errors.ts')

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
const j = (v: unknown): string => JSON.stringify(v)

const ROADS: Array<{ label: string; env: Record<string, string>; source: unknown; words: string }> = [
  { label: 'no credential anywhere', env: {}, source: { kind: 'none' }, words: errors.INVALID_API_KEY_ERROR_MESSAGE },
  { label: 'ANTHROPIC_API_KEY (the env key)', env: { ANTHROPIC_API_KEY: 'sk-ant-fixture-not-a-real-key' }, source: { kind: 'env', name: 'ANTHROPIC_API_KEY' }, words: 'Invalid API key · Fix ANTHROPIC_API_KEY' },
  { label: 'ANTHROPIC_AUTH_TOKEN (a gateway bearer)', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-bearer' }, source: { kind: 'env', name: 'ANTHROPIC_AUTH_TOKEN' }, words: 'Invalid credential · Fix ANTHROPIC_AUTH_TOKEN' },
  { label: 'ANTHROPIC_AUTH_TOKEN beside ANTHROPIC_API_KEY (the bearer rides; it is named)', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-bearer', ANTHROPIC_API_KEY: 'sk-ant-fixture-not-a-real-key' }, source: { kind: 'env', name: 'ANTHROPIC_AUTH_TOKEN' }, words: 'Invalid credential · Fix ANTHROPIC_AUTH_TOKEN' },
  { label: 'MERCURY_OAUTH_TOKEN (an env OAuth token)', env: { MERCURY_OAUTH_TOKEN: 'fixture-oauth' }, source: { kind: 'env', name: 'MERCURY_OAUTH_TOKEN' }, words: 'Invalid credential · Fix MERCURY_OAUTH_TOKEN' },
]

const refusal = (): unknown => Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { status: 401 })

section('§1 the source owner names the credential road')
section('§2 the words per source, through the real error road')
for (const road of ROADS) {
  for (const name of CREDENTIAL_VARS) delete process.env[name]
  for (const [name, value] of Object.entries(road.env)) process.env[name] = value
  const source = auth.wireCredentialSource()
  check(`§1 ${road.label} → ${j(road.source)}`, j(source) === j(road.source), j(source))
  const row = errors.getAssistantMessageFromError(refusal(), 'claude-fable-5-1')
  const content = row.message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (b as { text?: string }).text ?? '').join('') : ''
  check(`§2 ${road.label} → "${road.words}"`, text.includes(road.words), text.slice(0, 160))
}
for (const name of CREDENTIAL_VARS) delete process.env[name]

section('§3 the painter recognises every spelling of the family')
check('the env key words are the family', errors.isInvalidCredentialWords('Invalid API key · Fix ANTHROPIC_API_KEY'))
check('the env bearer words are the family', errors.isInvalidCredentialWords('Invalid credential · Fix ANTHROPIC_AUTH_TOKEN'))
check('the helper words are the family', errors.isInvalidCredentialWords(errors.invalidCredentialWords({ kind: 'helper' })) && errors.invalidCredentialWords({ kind: 'helper' }) === 'Invalid API key · Fix the apiKeyHelper')
check('the older external spelling (persisted transcripts) is still the family', errors.isInvalidCredentialWords(errors.INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL))
check('the logged-out words are NOT the family (their own painter)', !errors.isInvalidCredentialWords(errors.INVALID_API_KEY_ERROR_MESSAGE) && errors.invalidCredentialWords({ kind: 'managed' }) === errors.INVALID_API_KEY_ERROR_MESSAGE && errors.invalidCredentialWords({ kind: 'none' }) === errors.INVALID_API_KEY_ERROR_MESSAGE)
check('a plain sentence is not the family', !errors.isInvalidCredentialWords('Invalid API key mentioned in passing'))

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
