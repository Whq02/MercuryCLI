import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'terminal-provider-auth-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_AUTH_SCOPE_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]

let balanceStatus = 200
let modelsStatus = 200
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path.endsWith('/user/balance')) {
      if (balanceStatus !== 200) return Response.json({ error: { message: 'invalid key' } }, { status: balanceStatus })
      return Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '25.00' }] })
    }
    if (path.endsWith('/models')) {
      if (modelsStatus !== 200) return Response.json({ error: { message: 'invalid key' } }, { status: modelsStatus })
      return Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'grok-4.7' }, { id: 'mistral-large-4' }] })
    }
    if (path.endsWith('/api/oauth/device_authorization')) {
      return Response.json({
        device_code: 'kimi-dev-code',
        user_code: 'KIMI-1234',
        verification_uri: `http://127.0.0.1:${server.port}/kimi/verify`,
        expires_in: 300,
        interval: 0.01,
      })
    }
    if (path.endsWith('/api/oauth/token')) {
      return Response.json({
        access_token: 'kimi-access-token',
        refresh_token: 'kimi-refresh-token',
        expires_in: 3600,
      })
    }
    if (path.endsWith('/usages')) {
      return Response.json({ usages: [{ scope: 'FEATURE_CODING', detail: { limit: 100, used: 10 } }] })
    }
    return Response.json({ data: [] })
  },
})
const origin = `http://127.0.0.1:${server.port}`
process.env.MERCURY_DEEPSEEK_API_BASE = `${origin}/deepseek`
process.env.MERCURY_XAI_API_BASE = `${origin}/xai`
process.env.MERCURY_MISTRAL_API_BASE = `${origin}/mistral`
process.env.MERCURY_MOONSHOT_OAUTH_BASE = `${origin}/kimi`
process.env.MERCURY_MOONSHOT_CODING_BASE = `${origin}/kimi`
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== origin) throw new Error(`non-loopback proof request refused: ${url.origin}`)
  return nativeFetch(input, init)
}) as typeof fetch

const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { resetSettingsCache } = await import(`${root}/src/utils/settings/settingsCache.ts`)
const secrets = await import(`${root}/src/services/providers/providerSecrets.ts`)
const providerAuth = existsSync(`${root}/src/cli/handlers/providerAuth.ts`)
  ? await import(`${root}/src/cli/handlers/providerAuth.ts`)
  : undefined

let checks = 0
let failures = 0
function check(name: string, pass: unknown) {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`)
}

try {
  check('terminal provider auth module exists', providerAuth !== undefined)
  let outBuf = ''
  let errBuf = ''
  const io = (extra: Record<string, unknown> = {}) => ({
    writeOut: (t: string) => { outBuf += t },
    writeErr: (t: string) => { errBuf += t },
    exit: () => {},
    ...extra,
  })

  outBuf = ''
  const listBefore = await providerAuth?.providerAuthList({ json: true }, io())
  const parsedBefore = outBuf ? JSON.parse(outBuf) : null
  check('mercury auth list --json lists the provider families and their signed-out state', listBefore?.code === 0 && Array.isArray(parsedBefore?.families) && parsedBefore.families.length >= 15 && parsedBefore.families.every((f: any) => f.signedIn === false))

  outBuf = ''
  const dsLogin = await providerAuth?.providerAuthLogin('deepseek', {}, io({ promptKey: async () => 'sk-deepseek-terminal-test' }))
  check('mercury auth login deepseek prompts without echo, validates and stores the key', dsLogin?.ok === true && dsLogin.code === 0 && secrets.readStoredDeepseekApiKey() === 'sk-deepseek-terminal-test' && outBuf.includes('DeepSeek API key stored'))

  outBuf = ''
  const dsStatus = await providerAuth?.providerAuthStatus('deepseek', { json: true }, io())
  const parsedDsStatus = outBuf ? JSON.parse(outBuf) : null
  check('mercury auth status deepseek reports the signed-in family slot', dsStatus?.code === 0 && parsedDsStatus?.family === 'deepseek' && parsedDsStatus?.signedIn === true)

  outBuf = ''
  const kimiDevice = await providerAuth?.providerAuthLogin('moonshot', { device: true }, io())
  check('mercury auth login moonshot --device runs the Kimi device flow and prints the verification URI and code', kimiDevice?.ok === true && outBuf.includes('KIMI-1234') && outBuf.includes('Kimi connected'))

  writeFileSync(join(home, 'settings.json'), JSON.stringify({ compatProvider: { east: { baseUrl: `${origin}/east`, label: 'East', models: ['Fixture'] } } }))
  resetSettingsCache()
  outBuf = ''
  const compatLogin = await providerAuth?.providerAuthLogin('compat/east', {}, io({ promptKey: async () => 'sk-compat-east-key' }))
  check('mercury auth login compat/east stores the key for that named endpoint', compatLogin?.ok === true && secrets.readStoredCompatApiKey('east') === 'sk-compat-east-key')

  outBuf = ''
  const dsLogout = await providerAuth?.providerAuthLogout('deepseek', io())
  check('mercury auth logout deepseek removes only the DeepSeek credential while keeping other families signed in', dsLogout?.ok === true && secrets.readStoredDeepseekApiKey() === undefined && secrets.readStoredCompatApiKey('east') === 'sk-compat-east-key')

  console.log('refusals')
  outBuf = ''
  errBuf = ''
  const unknownLogin = await providerAuth?.providerAuthLogin('not-a-provider', {}, io())
  check('mercury auth login <unknown> refuses and names the known provider roster', unknownLogin?.ok === false && unknownLogin.code === 1 && errBuf.includes('Unknown provider family') && errBuf.includes('deepseek') && errBuf.includes('openai'))

  errBuf = ''
  const unknownStatus = await providerAuth?.providerAuthStatus('not-a-provider', {}, io())
  check('mercury auth status <unknown> refuses and names the known provider roster', unknownStatus?.code === 1 && errBuf.includes('Unknown provider family'))

  errBuf = ''
  const unknownLogout = await providerAuth?.providerAuthLogout('not-a-provider', io())
  check('mercury auth logout <unknown> refuses and names the known provider roster', unknownLogout?.ok === false && unknownLogout.code === 1 && errBuf.includes('Unknown provider family'))

  errBuf = ''
  const emptyKey = await providerAuth?.providerAuthLogin('zai', {}, io({ promptKey: async () => '   ' }))
  check('mercury auth login refuses an empty key without storing', emptyKey?.ok === false && secrets.readStoredZaiApiKey() === undefined)

  balanceStatus = 401
  errBuf = ''
  const refusedKey = await providerAuth?.providerAuthLogin('deepseek', {}, io({ promptKey: async () => 'sk-bad-deepseek' }))
  check('mercury auth login deepseek refuses an HTTP 401 key without storing', refusedKey?.ok === false && secrets.readStoredDeepseekApiKey() === undefined && errBuf.includes('HTTP 401'))
  balanceStatus = 200

  console.log(`${failures ? 'TERMINAL PROVIDER AUTH RED' : 'TERMINAL PROVIDER AUTH GREEN'} (${checks} checks, ${failures} failures; loopback only)`)
} finally {
  globalThis.fetch = nativeFetch
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
