#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-honesty-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-honesty-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ engine: { model: 'user-pinned-model' } }))
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(join(PROJ, '.mercury', 'settings.json'), JSON.stringify({ engine: { model: 'project-pinned-model' } }))
process.chdir(PROJ)

const { setFlagSettingsPath, setSessionTrustAccepted: trustTheProofFolder } = await import('../../src/boot/process-state/processState.ts')
trustTheProofFolder(true)
const { getSettingsWithErrors } = await import('../../src/platform/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const { readSessionOption } = await import('../../src/boot/sessionArgs.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 FC-027 — a cascade-member flag file keeps flag priority')
{
  resetSettingsCache()
  const withoutFlag = getSettingsWithErrors()
  check('control: without the flag, project wins the pin', withoutFlag.settings.engine?.model === 'project-pinned-model', String(withoutFlag.settings.engine?.model), 'getSettingsWithErrors in src/platform/settings/settings.ts must let the project settings file beat the user file when no flag path is set')

  setFlagSettingsPath(join(HOME, 'settings.json'))
  resetSettingsCache()
  const withFlag = getSettingsWithErrors()
  check(
    "--config <the user file> applies at FLAG priority (beats project — FC-027)",
    withFlag.settings.engine?.model === 'user-pinned-model',
    String(withFlag.settings.engine?.model),
    'getSettingsWithErrors in src/platform/settings/settings.ts must apply the file named by getFlagSettingsPath at flag priority, above project settings, even when that file is also a cascade member',
  )
  check('and its errors do not double-count', withFlag.errors.length === 0, JSON.stringify(withFlag.errors), 'getSettingsWithErrors in src/platform/settings/settings.ts must not report an error twice when the flag file is also a cascade member')
  setFlagSettingsPath(undefined as never)
  resetSettingsCache()
}

section('§2 FC-028 — both flag spellings read')
{
  for (const name of ['--config', '--config-layers']) {
    const spaced = readSessionOption([name, 'value-a'], name)
    const equals = readSessionOption([`${name}=value-a`], name)
    check(`${name} reads the same through both spellings`, spaced.value === 'value-a' && equals.value === 'value-a', JSON.stringify([spaced, equals]), 'readSessionOption in src/boot/sessionArgs.ts must return the same value for the spaced and the equals spelling of the flag')
    check(`${name} after -- is an operand, not the option`, readSessionOption(['--', name, 'value-a'], name).present === false, '', 'readSessionOption in src/boot/sessionArgs.ts must stop reading options after the -- token (see optionIndexes there)')
    check(`a repeated ${name} is last-wins`, readSessionOption([name, 'first', `${name}=last`], name).value === 'last', '', 'readSessionOption in src/boot/sessionArgs.ts must let the last occurrence of a repeated flag win')
  }
}


rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-cascade-flag-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cascade-flag-honesty: all green')
