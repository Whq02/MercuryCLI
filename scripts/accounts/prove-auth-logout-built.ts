#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeBinPath } from '../lib/nodeBin.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const NODE = nodeBinPath()

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]
for (const key of ['MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_USAGE_SEED']) {
  delete process.env[key]
}

const scratch = mkdtempSync(join(tmpdir(), 'prove-auth-logout-built-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'cwd')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]

const revokeCalls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
const oauthServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/v1/oauth/token/revoke') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      revokeCalls.push({ method: request.method, path: url.pathname, body })
      return Response.json({})
    }
    return Response.json({ error: 'unexpected endpoint' }, { status: 404 })
  },
})

const oauthOrigin = `http://127.0.0.1:${oauthServer.port}`
const dead = 'http://127.0.0.1:1'
const BASE_ENV = /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/
const deadBases: Record<string, string> = {
  ...Object.fromEntries(
    ['ANTHROPIC_BASE_URL', ...FLAG_REGISTRY.map(row => row.env).filter(name => BASE_ENV.test(name))].map(name => [name, dead]),
  ),
  MERCURY_OPENAI_AUTH_BASE: dead,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: dead,
  MERCURY_HUGGINGFACE_HUB_BASE: dead,
  MERCURY_MOONSHOT_OAUTH_BASE: dead,
  MERCURY_OPENROUTER_API_BASE: dead,
}
for (const [k, v] of Object.entries(deadBases)) process.env[k] = v
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = oauthOrigin

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const { buildProviderSnapshot, resetProviderSnapshotMemo } = await import('../../src/models/roads/modelRegistry.ts')
const { deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.ts')
const { clearOAuthTokenCache } = await import('../../src/models/sign-in/lifecycle/oauthLifecycle.ts')
const { credentialsPath } = await import('../../src/platform/secure-storage/index.ts')
const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const moonshot = await import('../../src/models/roads/moonshot/moonshotAccounts.ts')
const huggingface = await import('../../src/models/roads/huggingface/huggingfaceAccounts.ts')
const xai = await import('../../src/models/roads/xai/xaiOauth.ts')
const nous = await import('../../src/models/roads/nous/nousOauth.ts')

const far = Date.now() + 365 * 24 * 3600_000
const REFRESH_TOKEN = 'fixture-anthropic-refresh-token'

const readJson = (name: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(home, name), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function runBuiltCli(args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
    ...deadBases,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_ANTHROPIC_OAUTH_BASE: oauthOrigin,
    MERCURY_BOOT_PREFLIGHT: '0',
  }
  if (process.env.MERCURY_FEATURE_TRACE) env.MERCURY_FEATURE_TRACE = process.env.MERCURY_FEATURE_TRACE
  if (process.env.MERCURY_FEATURE_TRACE_PROOF) env.MERCURY_FEATURE_TRACE_PROOF = process.env.MERCURY_FEATURE_TRACE_PROOF
  return new Promise(resolveRun => {
    const child = spawn(NODE, [DIST, ...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.once('close', status => {
      clearTimeout(timer)
      resolveRun({ status, stdout, stderr })
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolveRun({ status: null, stdout, stderr })
    })
  })
}

const SEEDERS: Record<string, () => void> = {
  anthropic: () => {
    writeFileSync(
      credentialsPath(),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fixture-anthropic-access-token',
          refreshToken: REFRESH_TOKEN,
          expiresAt: far,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
      }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(home, '.mercury.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          accountUuid: 'fixture-acct-uuid',
          emailAddress: 'fixture@example.test',
          organizationUuid: 'fixture-org-uuid',
        },
        customApiKeyResponses: { approved: ['fixture-approved-tail'], rejected: [] },
      }),
    )
  },
  openai: () => {
    secrets.writeStoredOpenaiApiKey('sk-fixture-openai')
    writeFileSync(
      join(home, '.openai-auth.json'),
      JSON.stringify({
        version: 1,
        tokens: {
          idToken: '',
          accessToken: 'fixture-openai-access',
          refreshToken: 'fixture-openai-refresh',
          accountId: 'acct_fixture',
          planType: 'plus',
          accessTokenExpiresAtMs: far,
        },
      }),
    )
  },
  zai: () => secrets.writeStoredZaiApiKey('fixture-zai-key', 'coding'),
  openrouter: () => {
    secrets.writeStoredOpenrouterApiKey('sk-or-fixture-stored')
    writeFileSync(
      join(home, '.openrouter-auth.json'),
      JSON.stringify({ version: 1, minted: { key: 'sk-or-v1-fixture-minted', mintedAtMs: Date.now(), label: 'Mercury' } }),
    )
  },
  gemini: () => {
    secrets.writeStoredGeminiApiKey('fixture-gemini-key')
    writeFileSync(
      join(home, '.gemini-auth.json'),
      JSON.stringify({
        version: 1,
        client: { clientId: 'fixture-gemini-client' },
        tokens: { accessToken: 'fixture-gemini-access', refreshToken: 'fixture-gemini-refresh', accessTokenExpiresAtMs: far },
        plan: {
          accessToken: 'fixture-gemini-plan-access',
          refreshToken: 'fixture-gemini-plan-refresh',
          accessTokenExpiresAtMs: far,
          projectId: 'fixture-gemini-project',
          email: 'fixture@example.test',
        },
      }),
    )
  },
  moonshot: () => {
    secrets.writeStoredMoonshotApiKey('fixture-moonshot-key')
    moonshot.writeMoonshotTokens(
      { accessToken: 'fixture-kimi-access', refreshToken: 'fixture-kimi-refresh', accessTokenExpiresAtMs: far },
      'global',
    )
  },
  deepseek: () => secrets.writeStoredDeepseekApiKey('fixture-deepseek-key'),
  xai: () => {
    secrets.writeStoredXaiApiKey('fixture-xai-key')
    secrets.writeStoredXaiManagementApiKey('fixture-xai-mgmt-key')
    xai.writeXaiTokens({ accessToken: 'fixture-xai-access', refreshToken: 'fixture-xai-refresh', expiresAtMs: far })
  },
  meta: () => {
    secrets.writeStoredMetaApiKey('fixture-meta-key')
    writeFileSync(
      join(home, '.meta-auth.json'),
      JSON.stringify({
        version: 1,
        museCode: {
          accessToken: 'fixture-meta-access',
          apiKey: 'fixture-meta-minted-key',
          email: 'fixture@example.test',
          observedAtMs: Date.now(),
        },
      }),
    )
  },
  'openai-compat': () => {
    secrets.writeStoredCompatApiKey('fixture-compat-default')
    writeFileSync(
      join(home, '.provider-secrets.json'),
      JSON.stringify({ ...readJson('.provider-secrets.json'), compatEndpointKeys: { named: 'fixture-compat-named' } }),
      { mode: 0o600 },
    )
  },
  huggingface: () => {
    secrets.writeStoredHuggingfaceApiKey('hf_fixture_token')
    huggingface.writeHuggingfaceTokens(
      { accessToken: 'fixture-hf-access', refreshToken: 'fixture-hf-refresh', accessTokenExpiresAtMs: far },
      { username: 'fixture', observedAtMs: Date.now() },
    )
  },
  local: () => secrets.writeStoredLocalApiKey('fixture-local-key'),
  mistral: () => {
    secrets.writeStoredMistralApiKey('fixture-mistral-key')
    secrets.writeStoredMistralAdminApiKey('fixture-mistral-admin-key')
  },
  nous: () => {
    secrets.writeStoredNousApiKey('fixture-nous-key')
    nous.writeNousTokens({ accessToken: 'fixture-nous-access', refreshToken: 'fixture-nous-refresh', expiresAtMs: far })
  },
  zen: () => secrets.writeStoredZenApiKey('fixture-zen-key'),
  minimax: () => secrets.writeStoredMinimaxApiKey('fixture-minimax-key'),
  together: () => secrets.writeStoredTogetherApiKey('fixture-together-key'),
  cohere: () => secrets.writeStoredCohereApiKey('fixture-cohere-key'),
  groq: () => secrets.writeStoredGroqApiKey('fixture-groq-key'),
  melious: () => secrets.writeStoredMeliousApiKey('fixture-melious-key'),
  orcarouter: () => secrets.writeStoredOrcarouterApiKey('fixture-orcarouter-key'),
  cerebras: () => secrets.writeStoredCerebrasApiKey('fixture-cerebras-key'),
  fireworks: () => secrets.writeStoredFireworksApiKey('fixture-fireworks-key'),
  qwen: () => secrets.writeStoredQwenApiKey('fixture-qwen-key', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
}

console.log('============================================================')
console.log(' built bare mercury auth logout — every registry family + revocation')
console.log('============================================================')

try {
  const registryIds = buildProviderSnapshot().providers.map(provider => provider.id)
  const unseeded = registryIds.filter(id => !(id in SEEDERS))
  check('every provider family in buildProviderSnapshot has a fixture seeder', unseeded.length === 0, unseeded.join(', '))
  for (const id of registryIds) {
    SEEDERS[id]?.()
  }
  clearOAuthTokenCache()
  resetProviderSnapshotMemo()

  console.log('\n§1 before logout — every registry family reads signed in')
  const beforeGroups = deriveFamilySlotGroups()
  const missingBefore = registryIds.filter(id => {
    const group = beforeGroups.find(candidate => candidate.family.id === id)
    return !group || !group.slots.some(slot => slot.signedIn)
  })
  check('every registry family has a signed-in slot before logout', missingBefore.length === 0, missingBefore.join(', '))

  const listBefore = await runBuiltCli(['auth', 'list', '--json'])
  const parsedBefore = JSON.parse(listBefore.stdout || '{}') as { families?: Array<{ id: string; signedIn: boolean }> }
  const unsignedBefore = (parsedBefore.families ?? []).filter(row => !row.signedIn).map(row => row.id)
  check('built auth list --json reports every terminal family signed in before logout', listBefore.status === 0 && (parsedBefore.families?.length ?? 0) >= 20 && unsignedBefore.length === 0, `rc=${listBefore.status} unsigned=${unsignedBefore.join(',')}`)

  console.log('\n§2 built bare `mercury auth logout` — revokes OAuth token and exits 0')
  const ran = await runBuiltCli(['auth', 'logout'])
  check('bare auth logout exits 0', ran.status === 0, `rc=${ran.status} stderr=${ran.stderr.slice(0, 300)}`)
  check('bare auth logout prints Signed out with empty stderr', ran.stdout.trim() === 'Signed out' && ran.stderr === '', `stdout=${JSON.stringify(ran.stdout)} stderr=${JSON.stringify(ran.stderr)}`)
  check(
    'revocation endpoint received one POST with the fixture refresh token',
    revokeCalls.length === 1 &&
      revokeCalls[0]?.method === 'POST' &&
      revokeCalls[0]?.body.token === REFRESH_TOKEN &&
      revokeCalls[0]?.body.token_type_hint === 'refresh_token',
    JSON.stringify(revokeCalls),
  )

  console.log('\n§3 after logout — every registry family and store is empty')
  clearOAuthTokenCache()
  resetProviderSnapshotMemo()
  const afterGroups = deriveFamilySlotGroups()
  const stillSignedIn = registryIds.filter(id => {
    const group = afterGroups.find(candidate => candidate.family.id === id)
    return group?.slots.some(slot => slot.signedIn) ?? false
  })
  check('zero registry families have a signed-in slot after logout', stillSignedIn.length === 0, stillSignedIn.join(', '))

  const stillAccount = buildProviderSnapshot().providers
    .filter(provider => provider.id !== 'anthropic' && provider.description.account.kind !== 'none')
    .map(provider => provider.id)
  check('provider snapshot reports account.kind none for every non-anthropic family', stillAccount.length === 0, stillAccount.join(', '))

  const listAfter = await runBuiltCli(['auth', 'list', '--json'])
  const parsedAfter = JSON.parse(listAfter.stdout || '{}') as { families?: Array<{ id: string; signedIn: boolean }> }
  const remainingListed = (parsedAfter.families ?? []).filter(row => row.signedIn).map(row => row.id)
  check('built auth list --json reports every family signed out', listAfter.status === 0 && remainingListed.length === 0, `rc=${listAfter.status} remaining=${remainingListed.join(',')}`)

  const statusAfter = await runBuiltCli(['auth', 'status', '--json'])
  const parsedStatus = JSON.parse(statusAfter.stdout || '{}') as { loggedIn?: boolean; providers?: Array<{ id: string; present: boolean }> }
  const presentProviders = (parsedStatus.providers ?? []).filter(row => row.present).map(row => row.id)
  check('built auth status --json reports loggedIn false, zero present providers, exit 1', statusAfter.status === 1 && parsedStatus.loggedIn === false && presentProviders.length === 0, `rc=${statusAfter.status} present=${presentProviders.join(',')}`)

  check('Anthropic credential file is removed', !existsSync(credentialsPath()))
  const secretsFile = readJson('.provider-secrets.json')
  const leftKeys = Object.keys(secretsFile).filter(key => /ApiKey$/.test(key) || key === 'zaiKeyPlan' || key === 'qwenKeyBase' || key === 'compatEndpointKeys')
  check('.provider-secrets.json holds no provider key, plan, qwen base or compat endpoint map', leftKeys.length === 0, leftKeys.join(', '))
  check('OpenAI auth file tokens cleared', readJson('.openai-auth.json').tokens === undefined)
  check('OpenRouter auth file minted key cleared', readJson('.openrouter-auth.json').minted === undefined)
  const geminiFile = readJson('.gemini-auth.json')
  check('Gemini auth file tokens and plan cleared while client config kept', geminiFile.tokens === undefined && geminiFile.plan === undefined && geminiFile.client !== undefined, JSON.stringify(geminiFile))
  check('Moonshot auth file tokens cleared', readJson('.moonshot-auth.json').tokens === undefined)
  check('xAI auth file tokens cleared', readJson('.xai-auth.json').tokens === undefined)
  check('Meta auth file Muse Code grant cleared', readJson('.meta-auth.json').museCode === undefined)
  check('Hugging Face auth file tokens cleared', readJson('.huggingface-auth.json').tokens === undefined)
  check('Nous auth file tokens cleared', readJson('.nous-auth.json').tokens === undefined)
  const globalCfg = readJson('.mercury.json')
  check('.mercury.json cleared oauthAccount and preserved onboarding state', globalCfg.oauthAccount === undefined && globalCfg.hasCompletedOnboarding === true, JSON.stringify(globalCfg))
} finally {
  oauthServer.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-auth-logout-built (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
