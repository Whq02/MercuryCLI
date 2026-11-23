#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' provider-key isolation — derived, unconditional for LSP')
console.log('============================================================')

const spellings = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
const idSpaces = await import('../../src/models/roads/idSpaces.ts')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')

section('§1 the strip set derives from the route-law family table')
{
  const routes = new Set([
    ...(idSpaces.PROVIDER_ID_SPACES as Array<{ route: string }>).map(space => space.route),
    'anthropic',
  ])
  check('the credential table covers exactly the declared family union', routes.size === Object.keys(spellings.PROVIDER_CREDENTIAL_ENV_VARS).length && Object.keys(spellings.PROVIDER_CREDENTIAL_ENV_VARS).every(route => routes.has(route)), [...routes].join(',') + ' — make PROVIDER_CREDENTIAL_ENV_VARS in src/models/sign-in/credentials/credentialEnvSpellings.ts list exactly the routes of PROVIDER_ID_SPACES (src/models/roads/idSpaces.ts) plus anthropic')
  for (const route of routes) {
    const vars = (spellings.PROVIDER_CREDENTIAL_ENV_VARS as Record<string, readonly string[]>)[route]
    check(`route '${route}' carries at least one credential spelling`, Array.isArray(vars) && vars.length > 0, JSON.stringify(vars) + ' — add this route\'s key spellings to PROVIDER_CREDENTIAL_ENV_VARS in src/models/sign-in/credentials/credentialEnvSpellings.ts')
    for (const name of vars ?? []) {
      check(`  '${name}' lands in the flat derived set`, spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name), 'ALL_PROVIDER_CREDENTIAL_ENV_VARS in src/models/sign-in/credentials/credentialEnvSpellings.ts must be derived from every route in PROVIDER_CREDENTIAL_ENV_VARS')
    }
  }
  const seven = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_API_KEY']
  check('the seven previously-missing spellings are all covered', seven.every(name => spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name)), 'missing: ' + seven.filter(name => !spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name)).join(',') + ' — add them to PROVIDER_CREDENTIAL_ENV_VARS in src/models/sign-in/credentials/credentialEnvSpellings.ts')
}

const subEnvModule = await import('../../src/platform/processes/subprocessEnv.ts')
const SPELLINGS = [...spellings.ALL_PROVIDER_CREDENTIAL_ENV_VARS]
const cleanTriggers = (): void => {
  delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
  delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
  delete process.env.MERCURY_OAUTH_TOKEN
  delete process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OTEL_') || key.startsWith('MERCURY_BROWSER_SECRET_')) delete process.env[key]
  }
  for (const name of subEnvModule.ALWAYS_STRIP_TOKEN_VARS) delete process.env[name]
}

section('§2 language servers: stripped with NO flag armed; the default path unchanged')
{
  cleanTriggers()
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-secret'
  process.env.HF_TOKEN = 'fixture-hf-secret'
  const forLs = subEnvModule.languageServerEnv()
  check('the language-server env carries NO provider key', SPELLINGS.every(name => forLs[name] === undefined), JSON.stringify(SPELLINGS.filter(n => forLs[n] !== undefined)))
  check('startup facts survive (PATH intact)', forLs.PATH === process.env.PATH, 'languageServerEnv in src/platform/processes/subprocessEnv.ts must delete only the provider credential names and keep PATH')
  const forChild = subEnvModule.subprocessEnv()
  check('the DEFAULT child path still inherits (unchanged this release)', forChild.DEEPSEEK_API_KEY === 'fixture-deepseek-secret' && forChild.HF_TOKEN === 'fixture-hf-secret', 'subprocessEnv in src/platform/processes/subprocessEnv.ts must keep provider keys when neither MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION nor the CI scrub is set; only languageServerEnv strips them unconditionally')
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.HF_TOKEN
}

section('§3 the isolation flag and the hot path')
{
  cleanTriggers()
  process.env.OPENROUTER_API_KEY = 'fixture-openrouter-secret'
  process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION = '1'
  const isolated = subEnvModule.subprocessEnv()
  check('armed: the provider set is absent from every child env', SPELLINGS.every(name => isolated[name] === undefined), 'with MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION=1 subprocessEnv in src/platform/processes/subprocessEnv.ts must delete every ALL_PROVIDER_CREDENTIAL_ENV_VARS name: ' + JSON.stringify(SPELLINGS.filter(n => isolated[n] !== undefined)))
  check('armed: non-credential env survives', isolated.PATH === process.env.PATH, 'the isolation strip in subprocessEnv (src/platform/processes/subprocessEnv.ts) must delete only credential names')
  delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION
  const ambient = subEnvModule.subprocessEnv()
  check('unarmed: ambient inheritance, byte-identical', ambient.OPENROUTER_API_KEY === 'fixture-openrouter-secret', 'without the flag subprocessEnv in src/platform/processes/subprocessEnv.ts must pass provider keys through untouched')
  delete process.env.OPENROUTER_API_KEY
  const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
  setIsInteractive(true)
  const hot = subEnvModule.subprocessEnv()
  check('the hot path returns the LIVE env by reference when nothing needs stripping (an interactive session: a headless one owes its children the non-interactive stamps and is a copy)', hot === process.env, 'subprocessEnv in src/platform/processes/subprocessEnv.ts must return process.env itself (no copy) when no strip, scrub or owed default applies')
  setIsInteractive(false)
}

section('§4 the CI scrub armed: every spelling and its INPUT_ twin')
{
  cleanTriggers()
  process.env.MERCURY_SUBPROCESS_ENV_SCRUB = '1'
  for (const name of SPELLINGS) {
    process.env[name] = `fixture-${name}`
    process.env[`INPUT_${name}`] = `fixture-input-${name}`
  }
  const scrubbed = subEnvModule.subprocessEnv()
  check('all spellings absent', SPELLINGS.every(name => scrubbed[name] === undefined), JSON.stringify(SPELLINGS.filter(n => scrubbed[n] !== undefined)))
  check('all INPUT_-prefixed twins absent', SPELLINGS.every(name => scrubbed[`INPUT_${name}`] === undefined), 'with MERCURY_SUBPROCESS_ENV_SCRUB=1 the scrub in src/platform/processes/subprocessEnv.ts must also delete the INPUT_ twin of every name it strips')
  for (const name of SPELLINGS) {
    delete process.env[name]
    delete process.env[`INPUT_${name}`]
  }
  delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
}

section('§5 the wiring, structural')
{
  const isolationRow = getFlagSpec('MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION')
  check('the isolation flag is registered with its off arm', isolationRow !== undefined && isolationRow.off.includes('ambient inheritance, byte-identical'), 'register MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION with an off text containing "ambient inheritance, byte-identical" in FLAG_REGISTRY')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-provider-key-isolation — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-provider-key-isolation — all checks pass')
process.exit(0)
