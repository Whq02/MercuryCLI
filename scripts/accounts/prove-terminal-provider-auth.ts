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
let keyStatus = 200
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/openrouter/key') {
      if (keyStatus === 401) return Response.json({ error: { message: 'API key expired', code: 401 } }, { status: 401 })
      return Response.json({ data: { label: 'fixture', usage: 1, limit: null, limit_remaining: null } })
    }
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
process.env.MERCURY_OPENROUTER_API_BASE = `${origin}/openrouter`
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

  console.log('one truth for a stored key the service refused: auth list, auth status, auth status <family> and the logins row agree')
  const keyProbe = await import(`${root}/src/services/providers/openrouter/openrouterUsageState.ts`)
  const logins = await import(`${root}/src/components/BootLoginsScreen.tsx`)
  const loginsRow = () => logins.loginsRowStateOf(logins.loginsCatalogue().find((row: { familyId: string }) => row.familyId === 'openrouter')!, logins.collectLoginsScreenFacts())
  const wholeStatus = (): { providers?: Array<{ id: string; present: boolean; status?: string; refused?: { status: number } }> } | null => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync(process.execPath, ['-e', `globalThis.MACRO={VERSION:'1.0.0'};const c=await import(${JSON.stringify(`${root}/src/utils/config.ts`)});c.enableConfigs();const a=await import(${JSON.stringify(`${root}/src/cli/handlers/auth.ts`)});await a.authStatus({json:true});`], { env: { ...process.env }, encoding: 'utf8', timeout: 60000 })
    try { return JSON.parse(r.stdout) } catch { return null }
  }
  const listRow = async (json: boolean) => { outBuf = ''; const r = await providerAuth?.providerAuthList({ json }, io()); return json ? { code: r?.code, row: (JSON.parse(outBuf).families as Array<{ id: string; signedIn: boolean; source: string; refused?: string }>).find(f => f.id === 'openrouter') } : { code: r?.code, line: outBuf.split('\n').find(l => l.startsWith('openrouter:')) } }
  const familyStatus = async (json: boolean) => { outBuf = ''; const r = await providerAuth?.providerAuthStatus('openrouter', { json }, io()); return { code: r?.code, text: outBuf, json: json ? JSON.parse(outBuf) as { signedIn: boolean; refused?: string; slots: Array<{ active: boolean; stateNote?: string }> } : undefined } }
  secrets.writeStoredOpenrouterApiKey('sk-or-fixture-expired-key')
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  keyStatus = 401
  await keyProbe.refreshOpenrouterKeyUsage({ fetchImpl: globalThis.fetch, force: true })
  const refusedList = await listRow(true)
  const words = refusedList.row?.refused
  check('auth list --json: the stored key is signed in AND refused, in the composer\'s words (status, the service\'s message, the time, the door)', refusedList.row?.signedIn === true && typeof words === 'string' && words.startsWith('key refused (HTTP 401: API key expired) at ') && words.endsWith(' · /logins openrouter reconnects'), JSON.stringify(refusedList.row))
  const refusedLine = await listRow(false)
  check('auth list: the line reads signed in — <the refusal words>', refusedLine.line === `openrouter: signed in — ${words}`, refusedLine.line)
  const refusedFamily = await familyStatus(true)
  check('auth status openrouter --json: signed in, the same refused words, the active slot noted, exit 1 (refused is not usable)', refusedFamily.code === 1 && refusedFamily.json?.signedIn === true && refusedFamily.json?.refused === words && refusedFamily.json?.slots.find(slot => slot.active)?.stateNote === words, refusedFamily.text)
  const refusedFamilyText = await familyStatus(false)
  check('auth status openrouter: the slot line carries the same words', refusedFamilyText.text.includes(`(active) · ${words}`), refusedFamilyText.text)
  const whole = wholeStatus()
  const wholeRow = whole?.providers?.find(p => p.id === 'openrouter')
  check('auth status --json (the whole door, a fresh process): openrouter present, refused 401, the same words', wholeRow?.present === true && wholeRow?.refused?.status === 401 && wholeRow?.status === words, JSON.stringify(wholeRow))
  const row = loginsRow()
  check('the /logins row: signed in, loud, the same words', row.signedIn === true && row.loud === true && row.chip === words, JSON.stringify(row))
  keyStatus = 200
  await keyProbe.refreshOpenrouterKeyUsage({ fetchImpl: globalThis.fetch, force: true })
  const acceptedList = await listRow(true)
  const acceptedFamily = await familyStatus(true)
  const acceptedRow = loginsRow()
  check('after the service accepts the key every door drops the refusal together: list signed in with no refused, family status exit 0, the logins row quiet', acceptedList.row?.signedIn === true && acceptedList.row?.refused === undefined && acceptedFamily.code === 0 && acceptedFamily.json?.refused === undefined && acceptedRow.loud === false && acceptedRow.refusal === undefined, `${JSON.stringify(acceptedList.row)} ${acceptedFamily.text} ${JSON.stringify(acceptedRow)}`)
  check('the control: a signed-in family with no refusal keeps its plain source line', (await listRow(false)).line === 'openrouter: signed in — API key (stored key (auth-scoped) …-key)', (await listRow(false)).line)
  keyStatus = 401
  await keyProbe.refreshOpenrouterKeyUsage({ fetchImpl: globalThis.fetch, force: true })
  secrets.writeStoredOpenrouterApiKey('sk-or-fixture-replacement-key')
  const replaced = await listRow(true)
  check('a refusal belongs to the key it was recorded for: a replacement key reads signed in with no refusal on list, family status and the logins row, no network asked', replaced.row?.signedIn === true && replaced.row?.refused === undefined && (await familyStatus(true)).json?.refused === undefined && loginsRow().refusal === undefined, JSON.stringify(replaced.row))
  secrets.writeStoredOpenrouterApiKey(null)
  keyStatus = 200
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  check('with the key removed the family is not signed in on every door', (await listRow(true)).row?.signedIn === false && (await familyStatus(true)).json?.signedIn === false && loginsRow().signedIn === false)

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
