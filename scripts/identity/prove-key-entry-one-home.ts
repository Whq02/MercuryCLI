#!/usr/bin/env bun
// gate-watch: src/substrate/flagRegistry.ts src/commands/login/login.tsx src/components/loginFamilyRows.ts src/components/ConsoleOAuthFlow.tsx src/components/XaiConnect.tsx src/components/MistralConnect.tsx src/services/providers/credentialWall.ts src/services/search/searchContract.ts src/utils/healthReport.ts src/utils/projectHomeStores.ts
import { proofHome } from '../lib/hermetic.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
writeFileSync(join(proofHome, 'settings.json'), '{}\n')

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const productFiles = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
  const path = join(dir, entry)
  if (statSync(path).isDirectory()) return productFiles(path)
  return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : []
})
const RETIRED_ENVS = ['MERCURY_ROUTER', 'MERCURY_ROUTER_POSTURE', 'MERCURY_ROUTER_STATE_DIR', 'MERCURY_MISSION_POLICY']
const RETIRED_POSTURES = ['adaptive', 'quality', 'balanced', 'fast', 'fixed']

console.log('entering a provider key has one home: /logins')

{
  console.log('\nthe flags')
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  for (const env of RETIRED_ENVS) {
    check(`the flag registry carries no row for ${env}`, !FLAG_REGISTRY.some(row => row.env === env))
  }
  const spellings = new Map<string, string[]>()
  for (const path of productFiles(join(REPO, 'src'))) {
    const text = readFileSync(path, 'utf8')
    for (const env of RETIRED_ENVS) if (text.includes(env)) spellings.set(env, [...(spellings.get(env) ?? []), relative(REPO, path)])
  }
  check('no product file spells a retired flag', spellings.size === 0, [...spellings].map(([env, paths]) => `${env}: ${paths.join(', ')}`).join(' · '))
  const { PROJECT_HOME_STORES } = await import('../../src/utils/projectHomeStores.ts')
  check('the project home stores carry no route-state store (a folder left on disk is never read)', !PROJECT_HOME_STORES.some(segments => segments.join('/') === 'router'))
}

{
  console.log('\nthe key entry: every family the old masked entry carried has its /logins row and leg')
  const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
  const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.ts')
  const rows = loginFamilyRows({ engineLegs: true }).map(row => row.value)
  const flow = readFileSync(join(REPO, 'src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  const legs = /type EngineLeg =([\s\S]*?)\n\n/.exec(flow)?.[1] ?? ''
  for (const [word, family] of [['zai', 'zai'], ['moonshot', 'moonshot'], ['deepseek', 'deepseek'], ['xai', 'xai'], ['meta', 'meta'], ['huggingface', 'huggingface'], ['mistral', 'mistral'], ['nous', 'nous'], ['zen', 'zen']] as const) {
    check(`/logins ${word} focuses the ${family} row, which the catalogue carries and the card has a leg for`, parseFamilyFocus(word) === family && rows.includes(family) && legs.includes(`'${family}'`))
  }
  const xai = readFileSync(join(REPO, 'src/components/XaiConnect.tsx'), 'utf8')
  check('/logins xai carries the management key as its second step', xai.includes("setStep('management')") && xai.includes('storeXaiManagementKeyLogin'))
  const mistral = readFileSync(join(REPO, 'src/components/MistralConnect.tsx'), 'utf8')
  check('/logins mistral carries the Admin API key beside the inference key', mistral.includes('storeMistralAdminKeyLogin') || mistral.includes('Admin API key'))
  const { reconnectDoorFor } = await import('../../src/services/providers/credentialWall.ts')
  check('the custom endpoint and the local server name their key variable (no sign-in leg exists for them)', reconnectDoorFor('openai-compat') === 'MERCURY_COMPAT_API_KEY' && reconnectDoorFor('local') === 'MERCURY_LOCAL_API_KEY')
  const search = await import('../../src/services/search/searchContract.ts')
  check('the web-search key door names the two variables', search.KEYED_DOOR_COMMANDS === 'BRAVE_API_KEY · TAVILY_API_KEY')
}

{
  console.log('\nthe health certificate')
  const report = await import('../../src/utils/healthReport.ts')
  const sectionIds = (cert: Awaited<ReturnType<typeof report.runHealthReport>>): string[] => cert.sections.map(s => s.id)
  const plain = await report.runHealthReport({ depth: 'fast' })
  check('no section of the certificate is the route section', !sectionIds(plain).includes('router-fast') && !plain.sections.some(s => s.title === 'ROUTER'))
  check('no check id begins with the retired word', !plain.sections.flatMap(s => s.checks).some(c => c.id.startsWith('router-')))
  const slots = plain.sections.flatMap(s => s.checks).find(c => c.id === 'provider-slots')
  check('the provider honesty row lives on under AUTH', slots !== undefined && plain.sections.find(s => s.id === 'auth')?.checks.some(c => c.id === 'provider-slots') === true)
  for (const env of RETIRED_ENVS) process.env[env] = env === 'MERCURY_ROUTER_POSTURE' ? RETIRED_POSTURES[1]! : env === 'MERCURY_MISSION_POLICY' ? 'specialist-sol' : '0'
  const pinned = await report.runHealthReport({ depth: 'fast' })
  for (const env of RETIRED_ENVS) delete process.env[env]
  check('a retired flag set in the environment is an unknown input: the certificate keeps its sections', sectionIds(pinned).join('|') === sectionIds(plain).join('|'), sectionIds(pinned).join('|'))
  const words = pinned.sections.flatMap(s => s.checks).map(c => `${c.evidence ?? ''} ${c.fix ?? ''}`).join('\n')
  check('…and no row answers it with a refusal sentence or names it', !RETIRED_ENVS.some(env => words.includes(env)))
}

console.log(`\nkey-entry-one-home: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
