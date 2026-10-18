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
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import(`${root}/src/services/providers/credentialEnvSpellings.ts`)
for (const key of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_/.test(key)) delete process.env[key]

const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
await import(`${root}/src/services/resources/registry.ts`)
const { liveModelsReference, liveModelsReferenceText } = await import(`${root}/src/services/resources/adapters/models.ts`)
const { getEngineModel } = await import(`${root}/src/utils/model/model.ts`)
const secrets = await import(`${root}/src/services/providers/providerSecrets.ts`)
const modelsModule = existsSync(`${root}/src/cli/handlers/models.ts`)
  ? await import(`${root}/src/cli/handlers/models.ts`)
  : undefined

let checks = 0
let failures = 0
function check(name: string, pass: unknown) {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`)
}

try {
  check('models CLI handler exists', modelsModule !== undefined)

  secrets.writeStoredDeepseekApiKey('sk-deepseek-models-proof')
  secrets.writeStoredZaiApiKey('sk-zai-models-proof')

  let textOut = ''
  await modelsModule?.modelsCli({ json: false }, { writeOut: (t: string) => { textOut += t } })
  const page = await liveModelsReference({ engineModel: getEngineModel() })
  const pageText = liveModelsReferenceText(page)
  check('mercury models prints the exact mercury://models text format', textOut.trim().split('\n').slice(1).join('\n') === pageText.trim().split('\n').slice(1).join('\n') && textOut.includes('deepseek-v4-pro') && textOut.includes('glm-5.3'))

  let jsonOut = ''
  await modelsModule?.modelsCli({ json: true }, { writeOut: (t: string) => { jsonOut += t } })
  let parsed: any = null
  try { parsed = JSON.parse(jsonOut) } catch { parsed = null }
  check('mercury models --json emits valid JSON with the exact mercury://models providers and notSignedIn facts', parsed !== null && JSON.stringify(parsed.providers) === JSON.stringify(page.providers) && JSON.stringify(parsed.notSignedIn) === JSON.stringify(page.notSignedIn))

  console.log('refusals')
  secrets.writeStoredDeepseekApiKey(null)
  secrets.writeStoredZaiApiKey(null)
  let signedOutText = ''
  await modelsModule?.modelsCli({ json: false }, { writeOut: (t: string) => { signedOutText += t } })
  check('with no signed-in provider, mercury models reports no provider is signed in and names /logins', signedOutText.includes('no provider is signed in'))

  let signedOutJson = ''
  await modelsModule?.modelsCli({ json: true }, { writeOut: (t: string) => { signedOutJson += t } })
  const parsedSignedOut = signedOutJson ? JSON.parse(signedOutJson) : null
  check('with no signed-in provider, mercury models --json returns an empty providers array', Array.isArray(parsedSignedOut?.providers) && parsedSignedOut.providers.length === 0)

  console.log(`${failures ? 'TERMINAL MODELS RED' : 'TERMINAL MODELS GREEN'} (${checks} checks, ${failures} failures)`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
