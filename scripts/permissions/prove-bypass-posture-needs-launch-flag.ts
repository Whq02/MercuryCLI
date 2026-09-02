#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'sovereign-flag-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'sovereign-flag-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(
  join(PROJ, '.mercury', 'settings.json'),
  JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
)
process.chdir(PROJ)

const { initialPermissionModeFromCLI } = await import('../../src/utils/permissions/permissionSetup.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 THE CLI SPELLING')
{
  const flagless = initialPermissionModeFromCLI({
    permissionModeCli: 'bypassPermissions',
    dangerouslySkipPermissions: false,
  })
  check(
    'flagless --permission-mode bypassPermissions does NOT boot sovereign',
    flagless.mode !== 'sovereign',
    `mode=${flagless.mode}`,
  )
  check(
    'the refusal is NAMED (a notification, not silence)',
    typeof flagless.notification === 'string' && flagless.notification.includes('--dangerously-skip-permissions'),
    JSON.stringify(flagless.notification),
  )

  const flagged = initialPermissionModeFromCLI({
    permissionModeCli: 'bypassPermissions',
    dangerouslySkipPermissions: true,
  })
  check('WITH the launch flag the same spelling still boots sovereign', flagged.mode === 'sovereign', `mode=${flagged.mode}`)
}

section('§2 THE SETTINGS ROAD')
{
  const settingsBorne = initialPermissionModeFromCLI({
    permissionModeCli: undefined,
    dangerouslySkipPermissions: false,
  })
  check(
    'settings defaultMode=bypassPermissions cannot arm sovereign flagless (FC-001)',
    settingsBorne.mode !== 'sovereign',
    `mode=${settingsBorne.mode}`,
  )
  check(
    'the settings-borne refusal is named too',
    typeof settingsBorne.notification === 'string' && settingsBorne.notification.includes('--dangerously-skip-permissions'),
    JSON.stringify(settingsBorne.notification),
  )

  writeFileSync(
    join(PROJ, '.mercury', 'settings.json'),
    JSON.stringify({ permissions: { defaultMode: 'implement' } }),
  )
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  resetSettingsCache()
  const control = initialPermissionModeFromCLI({
    permissionModeCli: undefined,
    dangerouslySkipPermissions: false,
  })
  check('control: a non-bypass settings defaultMode still applies', control.mode === 'implement', `mode=${control.mode}`)
}

section('§3 WIRING')
{
  const setupSrc = readFileSync(join(import.meta.dir, '../../src/utils/permissions/permissionSetup.ts'), 'utf8')
  const sovereignBranch = setupSrc.slice(
    setupSrc.indexOf("if (candidate === 'sovereign')"),
    setupSrc.indexOf("if (candidate === 'autopilot')"),
  )
  check(
    'the sovereign candidate branch itself carries the launch-flag guard',
    sovereignBranch.includes('if (!dangerouslySkipPermissions)'),
  )
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-bypass-posture-needs-launch-flag: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-bypass-posture-needs-launch-flag: all green')
