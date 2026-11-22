#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'extension-only-policy-home-'))
const PROJECT = mkdtempSync(join(tmpdir(), 'extension-only-policy-project-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJECT)
const { CUSTOMIZATION_SURFACES } = await import('../../src/utils/settings/types.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { setMdmSettingsCache, clearMdmSettingsCache } = await import('../../src/utils/settings/mdm/settings.ts')
const { isRestrictedToExtensionsOnly, isSourceAdminTrusted } = await import('../../src/utils/settings/extensionOnlyPolicy.ts')

const WHERE = 'src/utils/settings/extensionOnlyPolicy.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const policy = (settings: Record<string, unknown> | null): void => {
  if (settings === null) clearMdmSettingsCache()
  else setMdmSettingsCache({ settings, errors: [] }, { settings: {}, errors: [] })
  resetSettingsCache()
}
const locked = (): string => CUSTOMIZATION_SURFACES.filter(surface => isRestrictedToExtensionsOnly(surface)).join(',')

section('§1 which surfaces the policy holds to extensions only')
{
  check('the surfaces are skills, agents, hooks and mcp, in that order', JSON.stringify(CUSTOMIZATION_SURFACES) === '["skills","agents","hooks","mcp"]', JSON.stringify(CUSTOMIZATION_SURFACES))
  policy(null)
  check('with no policy, none', locked() === '', locked())
  policy({ engine: { model: 'policy-model' } })
  check('with a policy that says nothing about extensions, none', locked() === '', locked())
  policy({ extensions: { exclusive: true } })
  check('exclusive: true holds all four', locked() === 'skills,agents,hooks,mcp', `${locked()}; see isRestrictedToExtensionsOnly in ${WHERE}`)
  policy({ extensions: { exclusive: false } })
  check('exclusive: false holds none', locked() === '', locked())
  policy({ extensions: { exclusive: ['skills', 'hooks'] } })
  check('a list holds the surfaces it names and no other', locked() === 'skills,hooks', `${locked()}; see isRestrictedToExtensionsOnly in ${WHERE}`)
  policy({ extensions: { exclusive: ['mcp'] } })
  check('a list of one holds that one', locked() === 'mcp', locked())
  policy({ extensions: { exclusive: [] } })
  check('an empty list holds none', locked() === '', locked())
  policy({ extensions: {} })
  check('extensions with no exclusive member holds none', locked() === '', locked())
}

section('§2 only the policy can say it')
{
  policy(null)
  mkdirSync(join(PROJECT, '.mercury'), { recursive: true })
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ extensions: { exclusive: true } }))
  writeFileSync(join(PROJECT, '.mercury', 'settings.json'), JSON.stringify({ extensions: { exclusive: ['skills'] } }))
  writeFileSync(join(PROJECT, '.mercury', 'settings.local.json'), JSON.stringify({ extensions: { exclusive: true } }))
  resetSettingsCache()
  check('the same words in the user, project and local settings files hold nothing', locked() === '', `${locked()}; ${WHERE} reads the policy source alone`)
  policy({ extensions: { exclusive: ['agents'] } })
  check('and when the policy speaks, the other files add nothing to it', locked() === 'agents', locked())
  policy(null)
  check('the policy taken away again, none is held', locked() === '', locked())
}

section('§3 which sources an administrator stands behind')
{
  const trusted = ['extension', 'policySettings', 'built-in', 'builtin', 'bundled']
  check('extension, policySettings, built-in, builtin and bundled are trusted', trusted.every(source => isSourceAdminTrusted(source)), `${trusted.filter(source => !isSourceAdminTrusted(source)).join(',')}; see isSourceAdminTrusted in ${WHERE}`)
  const others = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'user', 'project', 'local', 'plugin', 'mcp', '', ' extension', 'Extension', 'BUNDLED', 'built in', 'policy']
  check('every other source is not, whatever its case or spacing', others.every(source => !isSourceAdminTrusted(source)), others.filter(source => isSourceAdminTrusted(source)).join(','))
  check('no source at all is not trusted', isSourceAdminTrusted(undefined) === false)
}

if (failures > 0) {
  console.error(`\nprove-extension-only-policy-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-extension-only-policy-behaviour: all green')
