#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'store-adopt-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { canonicalizePath, findProjectDir, getProjectDir, MAX_SANITIZED_LENGTH, projectSlug, sanitizePath, shortProjectHash } = await import(
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

section('§1 A MNEME ESTATE IS NOT A STORE')
{
  const hashless = join(projectsDir, sanitizePath(dotProj))
  mkdirSync(join(hashless, 'memory'), { recursive: true })
  check('fixture: the siblings share one sanitized spelling', sanitizePath(dotProj) === sanitizePath(underscoreProj))

  const dotStore = getProjectDir(dotProj)
  const underscoreStore = getProjectDir(underscoreProj)
  check('app.1 does NOT read the mneme estate (FC-007)', dotStore !== hashless, dotStore)
  check('app_1 does NOT read the mneme estate (FC-007)', underscoreStore !== hashless, underscoreStore)

  section('§2 DISTINCT STORES')
  check(
    'the punctuation siblings key to DISTINCT hashed stores',
    dotStore !== underscoreStore && dotStore.endsWith(projectSlug(dotProj)) && underscoreStore.endsWith(projectSlug(underscoreProj)),
    `${dotStore} vs ${underscoreStore}`,
  )
}

section('§3 A HASH-LESS DIRECTORY HOLDING A TRANSCRIPT IS NOT READ')
{
  const proj = join(scratch, 'hashless.proj')
  mkdirSync(proj)
  const hashless = join(projectsDir, sanitizePath(proj))
  mkdirSync(hashless, { recursive: true })
  writeFileSync(join(hashless, '11111111-1111-1111-1111-111111111111.jsonl'), '')
  check('the project keys to its hashed store, never the hash-less directory', getProjectDir(proj) !== hashless && getProjectDir(proj) === join(projectsDir, projectSlug(proj)), getProjectDir(proj))
}

section('§4 AN OVERLONG PATH ADOPTS ONLY A STORE CARRYING ITS OWN HASH SUFFIX')
{
  const long = join(scratch, ...Array.from({ length: 40 }, () => 'segment'))
  const projA = join(long, 'alpha')
  const projB = join(long, 'beta')
  mkdirSync(projA, { recursive: true })
  mkdirSync(projB, { recursive: true })
  check('fixture: both paths sanitise past the cap and share the scanned prefix', sanitizePath(projA).length > MAX_SANITIZED_LENGTH && sanitizePath(projA).slice(0, MAX_SANITIZED_LENGTH) === sanitizePath(projB).slice(0, MAX_SANITIZED_LENGTH))
  const storeB = getProjectDir(projB)
  mkdirSync(storeB, { recursive: true })
  check("A, with no store yet, never adopts B's store", (await findProjectDir(projA)) === undefined, String(await findProjectDir(projA)))
  check('B finds its own store', (await findProjectDir(projB)) === storeB)
  const otherRuntime = join(projectsDir, `${sanitizePath(projA).slice(0, MAX_SANITIZED_LENGTH)}-zz9-${shortProjectHash(await canonicalizePath(projA))}`)
  mkdirSync(otherRuntime, { recursive: true })
  check("A still finds a store another runtime hashed, by its own sha8 tail", (await findProjectDir(projA)) === otherRuntime, String(await findProjectDir(projA)))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-store-not-cross-adopted: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-store-not-cross-adopted: all green')
