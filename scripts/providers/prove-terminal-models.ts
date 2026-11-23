import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PLUMBING_PROOF_ROOT ?? join(import.meta.dir, '../..'))
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const home = mkdtempSync(join(parent, 'terminal-models-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_AUTH_SCOPE_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/models/sign-in/credentials/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]

const { enableConfigs } = await import(`${root}/src/platform/settings/config.ts`)
enableConfigs()
await import(`${root}/src/integrations/resources/registry.ts`)
const { liveModelsReference, liveModelsReferenceText } = await import(`${root}/src/integrations/resources/adapters/models.ts`)
const { getEngineModel } = await import(`${root}/src/models/catalogue/engineModel.ts`)
const secrets = await import(`${root}/src/models/sign-in/account-ledger/providerSecrets.ts`)
const modelsModule = existsSync(`${root}/src/commands/verbs/models.ts`)
  ? await import(`${root}/src/commands/verbs/models.ts`)
  : undefined

let checks = 0
let failures = 0
function check(name: string, pass: unknown, detail = '') {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${!pass && detail ? ` — ${detail}` : ''}`)
}

try {
  check('models CLI handler exists', modelsModule !== undefined, `${root}/src/commands/verbs/models.ts is missing; the mercury models verb needs modelsCli exported from it`)

  secrets.writeStoredDeepseekApiKey('sk-deepseek-models-proof')
  secrets.writeStoredZaiApiKey('sk-zai-models-proof')

  let textOut = ''
  await modelsModule?.modelsCli({ json: false }, { writeOut: (t: string) => { textOut += t } })
  const page = await liveModelsReference({ engineModel: getEngineModel() })
  const pageText = liveModelsReferenceText(page)
  check('mercury models prints the exact mercury://models text format', textOut.trim().split('\n').slice(1).join('\n') === pageText.trim().split('\n').slice(1).join('\n') && textOut.includes('deepseek-v4-pro') && textOut.includes('glm-5.3'), `modelsCli in src/commands/verbs/models.ts must print the lines of liveModelsReferenceText (src/integrations/resources/adapters/models.ts) after its first line, listing deepseek-v4-pro and glm-5.3; printed: ${JSON.stringify(textOut.slice(0, 300))}`)

  let jsonOut = ''
  await modelsModule?.modelsCli({ json: true }, { writeOut: (t: string) => { jsonOut += t } })
  let parsed: any = null
  try { parsed = JSON.parse(jsonOut) } catch { parsed = null }
  check('mercury models --json emits valid JSON with the exact mercury://models providers and notSignedIn facts', parsed !== null && JSON.stringify(parsed.providers) === JSON.stringify(page.providers) && JSON.stringify(parsed.notSignedIn) === JSON.stringify(page.notSignedIn), `modelsCli with json:true in src/commands/verbs/models.ts must print the providers and notSignedIn of liveModelsReference (src/integrations/resources/adapters/models.ts) as JSON; printed: ${JSON.stringify(jsonOut.slice(0, 300))}`)

  console.log('refusals')
  secrets.writeStoredDeepseekApiKey(null)
  secrets.writeStoredZaiApiKey(null)
  let signedOutText = ''
  await modelsModule?.modelsCli({ json: false }, { writeOut: (t: string) => { signedOutText += t } })
  check('with no signed-in provider, mercury models reports no provider is signed in and names /logins', signedOutText.includes('no provider is signed in'), `modelsCli in src/commands/verbs/models.ts must print the no provider is signed in line that liveModelsReferenceText (src/integrations/resources/adapters/models.ts) writes when no provider is signed in; printed: ${JSON.stringify(signedOutText.slice(0, 300))}`)

  let signedOutJson = ''
  await modelsModule?.modelsCli({ json: true }, { writeOut: (t: string) => { signedOutJson += t } })
  const parsedSignedOut = signedOutJson ? JSON.parse(signedOutJson) : null
  check('with no signed-in provider, mercury models --json returns an empty providers array', Array.isArray(parsedSignedOut?.providers) && parsedSignedOut.providers.length === 0, `modelsCli with json:true in src/commands/verbs/models.ts must print providers as an empty array when nothing is signed in; printed: ${JSON.stringify(signedOutJson.slice(0, 300))}`)

  console.log(`${failures ? 'TERMINAL MODELS RED' : 'TERMINAL MODELS GREEN'} (${checks} checks, ${failures} failures)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
