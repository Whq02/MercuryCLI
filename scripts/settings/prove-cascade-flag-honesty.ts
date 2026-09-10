#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeOnlyText } from '../lib/codeText.ts'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-honesty-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'cascade-honesty-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ model: 'user-pinned-model' }))
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
writeFileSync(join(PROJ, '.mercury', 'settings.json'), JSON.stringify({ model: 'project-pinned-model' }))
process.chdir(PROJ)

const { setFlagSettingsPath } = await import('../../src/bootstrap/state.ts')
const { getSettingsWithErrors } = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 FC-027 — a cascade-member flag file keeps flag priority')
{
  resetSettingsCache()
  const withoutFlag = getSettingsWithErrors()
  check('control: without the flag, project wins the pin', withoutFlag.settings.model === 'project-pinned-model', String(withoutFlag.settings.model))

  setFlagSettingsPath(join(HOME, 'settings.json'))
  resetSettingsCache()
  const withFlag = getSettingsWithErrors()
  check(
    "--settings <the user file> applies at FLAG priority (beats project — FC-027)",
    withFlag.settings.model === 'user-pinned-model',
    String(withFlag.settings.model),
  )
  check('and its errors do not double-count', withFlag.errors.length === 0, JSON.stringify(withFlag.errors))
  setFlagSettingsPath(undefined as never)
  resetSettingsCache()
}

section('§2 FC-028 — both flag spellings read')
{
  const main = src('src/main.tsx')
  const eagerStart = main.indexOf('function eagerLoadSettings')
  const eager = main.slice(eagerStart, main.indexOf("profileCheckpoint('eagerLoadSettings_end')", eagerStart))
  check(
    'the eager reader resolves BOTH spellings through one helper (call-shaped)',
    /startsWith\(`\$\{name\}=`\)/.test(eager),
    eager.slice(0, 80).replace(/\s+/g, ' '),
  )
  check("and --settings rides it", /eagerFlagValue\('--settings'\)/.test(eager))
  check("and --setting-sources rides it", /eagerFlagValue\('--setting-sources'\)/.test(eager))
}

section('§3 FC-029 — the full env applies under standing trust, headless too')
{
  const init = codeOnlyText('src/entrypoints/init.ts', src('src/entrypoints/init.ts'))
  const safeAt = init.indexOf('applySafeConfigEnvironmentVariables()')
  const safeEnd = init.indexOf("profileCheckpoint('init_safe_env_applied')", safeAt)
  check('the safe-env block is bounded by the safe pass and its own checkpoint', safeAt >= 0 && safeEnd > safeAt, `${safeAt}..${safeEnd}`)
  const safeBlock = init.slice(safeAt, safeEnd)
  check(
    'init applies the FULL merged env ONLY behind the standing-trust check, inside the safe-env block (the guarded call itself, not two names anywhere)',
    /if\s*\(\s*checkHasTrustDialogAccepted\(\)\s*\)\s*applyConfigEnvironmentVariables\(\)/.test(safeBlock),
    safeBlock.replace(/\s+/g, ' ').slice(0, 200),
  )
  check(
    'the full-env call has no unguarded twin anywhere in init',
    (init.match(/applyConfigEnvironmentVariables\(\)/g) ?? []).length === 1,
    String((init.match(/applyConfigEnvironmentVariables\(\)/g) ?? []).length),
  )
  const managedEnv = src('src/utils/managedEnv.ts')
  check('the SAFE pre-trust pass itself is unchanged (untrusted stays safe-only)', /applySafeConfigEnvironmentVariables/.test(managedEnv))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-cascade-flag-honesty: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cascade-flag-honesty: all green')
