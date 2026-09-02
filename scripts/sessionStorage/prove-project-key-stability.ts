#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'keystab-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = resolve(import.meta.dir, '..', '..')
const { getProjectDir, projectSlug, sanitizePath } = await import(
  join(ROOT, 'src/utils/sessionStoragePortable.ts')
)
const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))
const projectsDir = join(getMercuryHome(), 'projects')
mkdirSync(projectsDir, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' project-key stability — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'keystab-'))
const scratchReal = realpathSync(scratch)
try {
  const straddle = join(scratchReal, 'straddle-project')
  mkdirSync(straddle)
  const canonical = realpathSync(straddle).normalize('NFC')
  const legacyStore = join(projectsDir, sanitizePath(canonical))
  mkdirSync(legacyStore)
  writeFileSync(join(legacyStore, '00000000-0000-0000-0000-000000000003.jsonl'), '')
  const k1 = getProjectDir(straddle)
  mkdirSync(join(projectsDir, projectSlug(canonical)))
  const k2 = getProjectDir(straddle + '/')
  check('§1 THE STRADDLE: canonical-equal spellings resolve ONE key across a store birth (the memo keys identity, not first-call state)', k1 === k2, `k1=${basename(k1)} k2=${basename(k2)}`)
  check('§1 the one key is the FIRST resolution (the standing store keeps its sessions — no mid-process migration)', k2 === legacyStore, basename(k2))

  mkdirSync(join(scratchReal, 'real-root'))
  symlinkSync(join(scratchReal, 'real-root'), join(scratchReal, 'alias-root'), 'junction')
  const aliasSpelling = join(scratchReal, 'alias-root', 'late-born-project')
  const trueDir = join(scratchReal, 'real-root', 'late-born-project')
  const deadKey = getProjectDir(aliasSpelling)
  mkdirSync(trueDir)
  const aliveKey = getProjectDir(aliasSpelling)
  const trueKey = getProjectDir(trueDir)
  check('§2 NO FREEZE: the dead-spelling answer is not frozen — once the folder exists the spelling resolves its TRUE canonical key', aliveKey === trueKey, `alive=${basename(aliveKey)} true=${basename(trueKey)}`)
  check('§2 the dead answer differed (the leg has teeth: dead raw-slug vs alive canonical)', deadKey !== aliveKey, basename(deadKey))

  const aOrder1 = join(scratchReal, 'alias-one')
  mkdirSync(aOrder1)
  const aliasOne = join(scratch, 'alias-one')
  check('§3 canonical-first order: the alias spelling joins the canonical resolution', getProjectDir(aOrder1) === getProjectDir(aliasOne), basename(getProjectDir(aliasOne)))
  const aOrder2 = join(scratchReal, 'alias-two')
  mkdirSync(aOrder2)
  const aliasTwo = join(scratch, 'alias-two')
  check('§3 alias-first order: the canonical spelling joins the alias resolution', getProjectDir(aliasTwo) === getProjectDir(aOrder2), basename(getProjectDir(aOrder2)))

  const pathsLayer = await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
  const wAlias = join(scratchReal, 'alias-root', 'wrapper-late-project')
  const wTrue = join(scratchReal, 'real-root', 'wrapper-late-project')
  const wDead = pathsLayer.getProjectDir(wAlias)
  mkdirSync(wTrue)
  const wAlive = pathsLayer.getProjectDir(wAlias)
  const wTruth = pathsLayer.getProjectDir(wTrue)
  check('§4 THE WRAPPER: paths.getProjectDir never freezes a failed-canonicalization answer (the consumer layer obeys the §2 law)', wAlive === wTruth, `alive=${basename(wAlive)} true=${basename(wTruth)}`)
  check('§4 the dead answer differed (the leg has teeth: dead raw-slug vs alive canonical)', wDead !== wAlive, basename(wDead))
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL KEY-STABILITY PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
