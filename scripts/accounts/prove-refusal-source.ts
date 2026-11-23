import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'refusal-source-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
for (const key of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|HF_TOKEN/.test(key)) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { captureSignInRequest, observeSignInResponse, readSignInRefusal, signInRefusalWords } = await import('../../src/models/roads/signInRefusal.js')
const { writeStoredOpenaiApiKey, writeStoredGeminiApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
let failures = 0
function check(label: string, ok: boolean, detail?: string) { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` -- ${detail}` : ''}`) }
try {
  for (const [family, store] of [['openai', writeStoredOpenaiApiKey], ['gemini', writeStoredGeminiApiKey]] as const) {
    const key = `fixture-${family}-key`
    const token = `fixture-${family}-token`
    store(key)
    writeFileSync(join(home, `.${family}-auth.json`), JSON.stringify({ version: 1, tokens: { accessToken: token, refreshToken: `fixture-${family}-refresh`, accessTokenExpiresAtMs: Date.now() + 3600000 }, preferredSource: family === 'openai' ? 'chatgpt-subscription' : 'oauth' }))
    const wrong = captureSignInRequest(family, key)
    observeSignInResponse(wrong, 401)
    check(`${family}: an inactive key's refusal never blames the selected sign-in`, wrong === undefined && readSignInRefusal(family) === undefined, `change captureSignInRequest/observeSignInResponse in ${'src/models/roads/signInRefusal.ts'} so a request carrying a credential other than the selected sign-in's bearer is not captured and records no refusal`)
    observeSignInResponse(captureSignInRequest(family, token), 403)
    check(`${family}: the selected bearer refusal is recorded`, readSignInRefusal(family)?.status === 403, 'observeSignInResponse in src/models/roads/signInRefusal.ts must record a 401/403 seen on the selected bearer, readable through readSignInRefusal')
    observeSignInResponse(captureSignInRequest(family, key), 200)
    check(`${family}: another key's success cannot clear the sign-in refusal`, readSignInRefusal(family)?.status === 403, 'observeSignInResponse in src/models/roads/signInRefusal.ts must clear a refusal only for a request made with the selected bearer')
    observeSignInResponse(captureSignInRequest(family, token), 200)
    check(`${family}: success on the selected bearer clears its refusal`, readSignInRefusal(family) === undefined, 'observeSignInResponse in src/models/roads/signInRefusal.ts must clear the stored refusal on a success with the selected bearer')
    observeSignInResponse(captureSignInRequest(family, token), 401)
    const path = join(home, '.sign-in-refusals', `${family}.json`)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.refusal.at = 1e30
    writeFileSync(path, JSON.stringify(record))
    const corrupt = readSignInRefusal(family)
    check(`${family}: an out-of-range time is ignored rather than crashing a status surface`, corrupt === undefined, 'readSignInRefusal in src/models/roads/signInRefusal.ts must return undefined for a stored refusal whose time is out of range')
    if (!corrupt) check(`${family}: the valid status formatter stays deterministic`, signInRefusalWords({ status: 401, at: 1 }, family).includes('1970-01-01T00:00:00Z') && signInRefusalWords({ status: 401, at: 1, message: 'API key expired', credential: 'key' }, family) === `key refused (HTTP 401: API key expired) at 1970-01-01T00:00:00Z · /logins ${family} reconnects`, 'signInRefusalWords in src/models/roads/signInRefusal.ts must format the time as UTC ISO seconds and end with "/logins <family> reconnects"')
  }
} finally { rmSync(home, { recursive: true, force: true }) }
console.log(failures ? `refusal-source: ${failures} FAILURE(S)` : 'refusal-source: ALL LAWS HOLD')
process.exit(failures ? 1 : 0)
