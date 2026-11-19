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

const { setFlagSettingsPath, setSessionTrustAccepted: trustTheProofFolder } = await import('../../src/bootstrap/state.ts')
trustTheProofFolder(true)
const { getSettingsWithErrors } = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { readSessionOption } = await import('../../src/cli/sessionArgs.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 FC-027 — a cascade-member flag file keeps flag priority')
{
  resetSettingsCache()
  const withoutFlag = getSettingsWithErrors()
  check('control: without the flag, project wins the pin', withoutFlag.settings.engine?.model === 'project-pinned-model', String(withoutFlag.settings.engine?.model))

  setFlagSettingsPath(join(HOME, 'settings.json'))
  resetSettingsCache()
  const withFlag = getSettingsWithErrors()
  check(
    "--config <the user file> applies at FLAG priority (beats project — FC-027)",
    withFlag.settings.engine?.model === 'user-pinned-model',
    String(withFlag.settings.engine?.model),
  )
  check('and its errors do not double-count', withFlag.errors.length === 0, JSON.stringify(withFlag.errors))
  setFlagSettingsPath(undefined as never)
  resetSettingsCache()
}

section('§2 FC-028 — both flag spellings read')
{
  for (const name of ['--config', '--config-layers']) {
    const spaced = readSessionOption([name, 'value-a'], name)
    const equals = readSessionOption([`${name}=value-a`], name)
    check(`${name} reads the same through both spellings`, spaced.value === 'value-a' && equals.value === 'value-a', JSON.stringify([spaced, equals]))
    check(`${name} after -- is an operand, not the option`, readSessionOption(['--', name, 'value-a'], name).present === false)
    check(`a repeated ${name} is last-wins`, readSessionOption([name, 'first', `${name}=last`], name).value === 'last')
  }
}


rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-cascade-flag-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cascade-flag-honesty: all green')
