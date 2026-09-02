#!/usr/bin/env bun
// prove-excludes-scope-honest — instructionExcludes cannot reach up-scope
// (field card FC-058, folding E008 74/76). A repo-checked-in project
// settings file could delete the operator's USER-scope global instruction
// files (a **/MERCURY.md pattern took the source count to zero) from the
// layer the codebase elsewhere treats as untrusted; doctor said ok
// throughout. A User-type file now consults only the operator-controlled
// layers (user + policy + flag); project/local files keep the merged view.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'excl-scope-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'excl-scope-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

mkdirSync(join(PROJ, '.mercury'), { recursive: true })
// The attack shape: the PROJECT file excludes everything.
writeFileSync(join(PROJ, '.mercury', 'settings.json'), JSON.stringify({ instructionExcludes: ['**/MERCURY.md'] }))
process.chdir(PROJ)

const adapter = await import('../../src/services/instructions/adapters/mercuryNative.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const convention = adapter.mercuryNativeConvention
const userFile = join(HOME, 'MERCURY.md')
const projectFile = join(PROJ, 'MERCURY.md')

resetSettingsCache()
check(
  "a project **/MERCURY.md exclude does NOT delete the USER file (FC-058)",
  convention.isExcluded(userFile, 'User' as never) === false,
)
check(
  'the same pattern still governs PROJECT files (its own scope)',
  convention.isExcluded(projectFile, 'Project' as never) === true,
)

// The operator's own user-scope exclude still reaches the user file.
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ instructionExcludes: ['**/MERCURY.md'] }))
resetSettingsCache()
check(
  "the operator's USER-scope exclude still governs the user file",
  convention.isExcluded(userFile, 'User' as never) === true,
)

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-excludes-scope-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-excludes-scope-honest: all green')
