#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'store-adopt-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { getProjectDir, projectSlug, sanitizePath } = await import(
  join(ROOT, 'src/utils/sessionStoragePortable.ts')
)
const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'store-adopt-proj-')))
const projectsDir = join(getMercuryHome(), 'projects')
const dotProj = join(scratch, 'app.1')
const underscoreProj = join(scratch, 'app_1')
mkdirSync(dotProj)
mkdirSync(underscoreProj)

section('§1 A MEMDIR ESTATE IS NOT A STORE')
{
  const hashless = join(projectsDir, sanitizePath(dotProj))
  mkdirSync(join(hashless, 'memory'), { recursive: true })
  check('fixture: the siblings share one sanitized spelling', sanitizePath(dotProj) === sanitizePath(underscoreProj))

  const dotStore = getProjectDir(dotProj)
  const underscoreStore = getProjectDir(underscoreProj)
  check('app.1 does NOT adopt the memdir estate (FC-007)', dotStore !== hashless, dotStore)
  check('app_1 does NOT adopt the memdir estate (FC-007)', underscoreStore !== hashless, underscoreStore)

  section('§2 DISTINCT STORES')
  check(
    'the punctuation siblings key to DISTINCT hashed stores',
    dotStore !== underscoreStore && dotStore.endsWith(projectSlug(dotProj)) && underscoreStore.endsWith(projectSlug(underscoreProj)),
    `${dotStore} vs ${underscoreStore}`,
  )
}

section('§3 A REAL LEGACY STORE STILL ADOPTS')
{
  const legacyProj = join(scratch, 'legacy.proj')
  mkdirSync(legacyProj)
  const legacyStore = join(projectsDir, sanitizePath(legacyProj))
  mkdirSync(legacyStore, { recursive: true })
  writeFileSync(join(legacyStore, '11111111-1111-1111-1111-111111111111.jsonl'), '')
  check('a hashless dir HOLDING a transcript adopts in place', getProjectDir(legacyProj) === legacyStore, getProjectDir(legacyProj))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-store-not-cross-adopted: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-store-not-cross-adopted: all green')
