import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'gemini-oauth-family-'))
const debugLog = join(scratch, 'debug.txt')
process.argv.push(`--debug-file=${debugLog}`)
const path = process.env.PATH
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  PATH: path,
  HOME: join(scratch, 'os-home'),
  MERCURY_CONFIG_DIR: scratch,
  MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
})
mkdirSync(process.env.HOME!, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
writeFileSync(join(scratch, '.gemini-auth.json'), JSON.stringify({
  version: 1,
  client: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' },
  tokens: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 },
  preferredSource: 'oauth',
}), { mode: 0o600 })
let status = 200
let models = [{ name: 'models/gemini-fixture-model', displayName: 'Gemini fixture model', supportedGenerationMethods: ['generateContent'] }]
const requests: Array<{ oauth: boolean; key: boolean; status: number }> = []
const server = createServer((req, res) => {
  requests.push({ oauth: req.headers.authorization === 'Bearer fixture-access', key: req.headers['x-goog-api-key'] === 'fixture-key', status })
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200
    ? { models }
    : { error: { code: status, message: `fixture catalogue refusal of ${req.headers.authorization ?? req.headers['x-goog-api-key'] ?? 'nothing'}`, status: status === 403 ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED' } }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.MERCURY_GEMINI_API_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'http://127.0.0.1:1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
const { resolveGeminiAccount, disconnectGeminiOauth } = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const { refreshGeminiCatalogue, __resetGeminiCatalogueForTest } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
const { flushDebugLogs } = await import('../../src/utils/debug.ts')
const SECRETS = ['fixture-access', 'fixture-refresh', 'fixture-client-secret', 'fixture-client', 'fixture-key']
async function debugLines(): Promise<string[]> {
  await flushDebugLogs()
  return existsSync(debugLog) ? readFileSync(debugLog, 'utf8').split('\n').filter(line => line.includes('[gemini] catalogue')) : []
}
let failures = 0
function check(label: string, condition: boolean, value?: unknown): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || value === undefined ? '' : ` — ${JSON.stringify(value)}`}`)
}
try {
  for (const arm of ['session', 'crew'] as const) {
    for (const code of [200, 401, 403, 500]) {
      status = code
      __resetGeminiCatalogueForTest()
      await refreshGeminiCatalogue('oauth', { force: true })
      resetComputedDefaultMemo()
      const family = await validateWorkerModelChoice('gemini', arm)
      check(`${arm} HTTP ${code}: the Google sign-in remains present`, resolveGeminiAccount()?.kind === 'oauth')
      if (code === 200) {
        check(`${arm}: a listed family word resolves to its model`, family.ok && family.entry.modelId === 'gemini-fixture-model', family)
      } else {
        check(`${arm} HTTP ${code}: a refused catalogue is not a missing credential`, !family.ok && !family.reason.startsWith('no-credential:'), family)
        check(`${arm} HTTP ${code}: the refusal retains the catalogue reason`, !family.ok && family.reason === `not-runnable:${code === 500 ? 'catalogue-error' : 'auth-invalid'}`, family)
        if (code === 500) check(`${arm}: an unreachable catalogue offers a retry`, !family.ok && /retry/.test(family.action ?? ''), family)
        if (code !== 500) check(`${arm} HTTP ${code}: the refusal names the Google account and the status`, !family.ok && family.detail === `the Google account's token was refused (HTTP ${code}) — /logins re-connects`, family)
        if (arm === 'session' && code === 403) {
          const lines = await debugLines()
          const refusals = lines.filter(line => line.includes('HTTP 403'))
          check('the 403 writes ONE debug line naming the source, the status and the body', refusals.length === 1 && refusals[0]!.includes('[gemini] catalogue refused the credential · source=Google account (OAuth) · HTTP 403 · body=') && refusals[0]!.includes('fixture catalogue refusal of') && refusals[0]!.includes('PERMISSION_DENIED'), refusals)
          check('the debug line carries no token, key, client id or client secret', refusals.length === 1 && SECRETS.every(secret => !refusals[0]!.includes(secret)) && refusals[0]!.includes('«masked»'), refusals)
        }
      }
      const explicit = await validateWorkerModelChoice('gemini-fixture-model', arm)
      check(`${arm} HTTP ${code}: an explicit model id still uses the present sign-in`, explicit.ok && explicit.entry.modelId === 'gemini-fixture-model', explicit)
    }
  }
  status = 200
  models = [{ name: 'models/gemma-fixture', displayName: 'Gemma fixture', supportedGenerationMethods: ['generateContent'] }]
  __resetGeminiCatalogueForTest()
  await refreshGeminiCatalogue('oauth', { force: true })
  resetComputedDefaultMemo()
  for (const arm of ['session', 'crew'] as const) {
    const unroutable = await validateWorkerModelChoice('gemini', arm)
    check(`${arm}: a ready catalogue without selectable rows retains the sign-in`, !unroutable.ok && unroutable.reason === 'not-runnable:no-selectable-models', unroutable)
  }
  models = []
  __resetGeminiCatalogueForTest()
  await refreshGeminiCatalogue('oauth', { force: true })
  resetComputedDefaultMemo()
  const empty = await validateWorkerModelChoice('gemini', 'session')
  check('an empty catalogue does not erase the sign-in', !empty.ok && empty.reason === 'not-runnable:no-generate-models', empty)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  __resetGeminiCatalogueForTest()
  resetComputedDefaultMemo()
  const dark = await validateWorkerModelChoice('gemini', 'session')
  check('disabled catalogue traffic is not a missing sign-in', !dark.ok && dark.reason === 'not-runnable:traffic-off', dark)
  check('disabled catalogue traffic names the setting to unset', !dark.ok && (dark.action ?? '').includes('unset MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'), dark)
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  resetComputedDefaultMemo()
  const zero = await validateWorkerModelChoice('gemini', 'session')
  check('a nonempty zero still disables traffic and says to unset the flag', !zero.ok && zero.reason === 'not-runnable:traffic-off' && (zero.action ?? '').includes('unset MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'), zero)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  models = [{ name: 'models/gemini-fixture-model', displayName: 'Gemini fixture model', supportedGenerationMethods: ['generateContent'] }]
  __resetGeminiCatalogueForTest()
  await refreshGeminiCatalogue('oauth', { force: true })
  resetComputedDefaultMemo()
  const enabled = await validateWorkerModelChoice('gemini', 'session')
  check('unsetting the flag permits the catalogue and family admission', enabled.ok && enabled.entry.modelId === 'gemini-fixture-model', enabled)
  disconnectGeminiOauth()
  __resetGeminiCatalogueForTest()
  resetComputedDefaultMemo()
  const absent = await validateWorkerModelChoice('gemini', 'session')
  check('an absent sign-in still refuses as no-credential:gemini', !absent.ok && absent.reason === 'no-credential:gemini', absent)
  check('every OAuth models request uses the stored Google token', requests.length > 0 && requests.every(r => r.oauth && !r.key), requests)
  const oauthRequests = requests.length
  process.env.GOOGLE_API_KEY = 'fixture-key'
  for (const code of [401, 403]) {
    status = code
    __resetGeminiCatalogueForTest()
    await refreshGeminiCatalogue('api-key', { force: true })
    resetComputedDefaultMemo()
    const keyRefusal = await validateWorkerModelChoice('gemini', 'session')
    check(`API key HTTP ${code}: a present key keeps the authentication refusal`, !keyRefusal.ok && keyRefusal.reason === 'not-runnable:auth-invalid', keyRefusal)
    check(`API key HTTP ${code}: the refusal names GOOGLE_API_KEY and the status`, !keyRefusal.ok && keyRefusal.detail === `the Gemini API key from GOOGLE_API_KEY was refused (HTTP ${code}) — update GOOGLE_API_KEY`, keyRefusal)
  }
  const keyLines = (await debugLines()).filter(line => line.includes('source=Gemini API key (GOOGLE_API_KEY env)'))
  check('the key refusals write debug lines naming the env key source, never the key', keyLines.length === 2 && keyLines.every(line => !line.includes('fixture-key') && line.includes('«masked»')), keyLines)
  check('the key models requests use the key header, not OAuth', requests.length > oauthRequests && requests.slice(oauthRequests).every(r => r.key && !r.oauth), requests.slice(oauthRequests))
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
console.log(`Gemini family refusal: ${failures} failure(s); fixture home ${scratch}`)
process.exit(failures ? 1 : 0)
