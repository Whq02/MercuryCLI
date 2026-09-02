#!/usr/bin/env bun
// prove-store-not-cross-adopted — punctuation-sibling isolation (field card
// FC-007). Two project directories whose paths differ only in punctuation
// (app.1 · app_1) sanitize to ONE hashless spelling, and memdir plants its
// memory estate at exactly that hashless path (sanitizePathComponent keeps
// `_` where sanitizePath folds it). The adoption ladder treated bare
// directory existence as a legacy store, so the second project adopted the
// first one's directory — `--continue` in one project resumed the other's
// conversation. Adoption now requires a store FACT: a transcript (.jsonl)
// inside. Field-verified on the built artifact before the fix: app_1's
// transcript landed inside the memdir estate minted by a run in app.1.
//
//   §1 a memdir-shaped dir (memory/, no transcript) is NOT adopted.
//   §2 punctuation siblings key to DISTINCT stores with the estate present.
//   §3 a REAL legacy store (transcript inside) still adopts in place.
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
  // Plant exactly what memdir plants: the hashless dir with a memory/ child
  // and no transcript. Both siblings sanitize onto this one path.
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
