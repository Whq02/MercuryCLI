#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname as dirnameOf, join, resolve } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'keystab-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = resolve(import.meta.dir, '..', '..')
const { getProjectDir, projectSlug, sanitizePath } = await import(
  join(ROOT, 'src/sessions/transcripts/sessionStoragePortable.ts')
)
const { getMercuryHome } = await import(join(ROOT, 'src/platform/environment/envUtils.ts'))
const projectsDir = join(getMercuryHome(), 'projects')
mkdirSync(projectsDir, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond && hint) console.log(`         change: ${hint}`)
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
  const hashless = join(projectsDir, sanitizePath(canonical))
  mkdirSync(hashless)
  writeFileSync(join(hashless, '00000000-0000-0000-0000-000000000003.jsonl'), '')
  const k1 = getProjectDir(straddle)
  mkdirSync(join(projectsDir, projectSlug(canonical)))
  const k2 = getProjectDir(straddle + '/')
  check('§1 THE STRADDLE: canonical-equal spellings resolve ONE key across a store birth (the memo keys identity, not first-call state)', k1 === k2, `k1=${basename(k1)} k2=${basename(k2)}`, 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must memoise by canonical identity so two spellings of one folder return the same key')
  check('§1 the one key is the hashed store, before and after its birth; the hash-less directory is not read', k1 === join(projectsDir, projectSlug(canonical)) && k2 !== hashless, basename(k2), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must return the projectSlug (hashed) directory and never the hash-less sanitizePath directory')

  mkdirSync(join(scratchReal, 'real-root'))
  symlinkSync(join(scratchReal, 'real-root'), join(scratchReal, 'alias-root'), 'junction')
  const aliasSpelling = join(scratchReal, 'alias-root', 'late-born-project')
  const trueDir = join(scratchReal, 'real-root', 'late-born-project')
  const deadKey = getProjectDir(aliasSpelling)
  mkdirSync(trueDir)
  const aliveKey = getProjectDir(aliasSpelling)
  const trueKey = getProjectDir(trueDir)
  check('§2 NO FREEZE: the dead-spelling answer is not frozen — once the folder exists the spelling resolves its TRUE canonical key', aliveKey === trueKey, `alive=${basename(aliveKey)} true=${basename(trueKey)}`, 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must memoise a spelling only when identity.exists, so a key computed before the folder existed is recomputed')
  check('§2 the dead answer differed (the leg has teeth: dead raw-slug vs alive canonical)', deadKey !== aliveKey, basename(deadKey), 'the proof fixture no longer separates the dead and alive answers; check that getProjectDir (src/sessions/transcripts/sessionStoragePortable.ts) still derives a raw-slug key for a spelling whose folder does not exist')

  const aOrder1 = join(scratchReal, 'real-root', 'alias-one')
  mkdirSync(aOrder1)
  const aliasOne = join(scratchReal, 'alias-root', 'alias-one')
  check('§3 the alias pair is a real pair: the two spellings DIFFER and canonicalize to ONE folder', aliasOne !== aOrder1 && realpathSync(aliasOne) === realpathSync(aOrder1), `${basename(dirnameOf(aliasOne))}/ vs ${basename(dirnameOf(aOrder1))}/`, 'the alias-root junction in the scratch dir did not resolve to real-root; this is a fixture or filesystem problem, not getProjectDir')
  check('§3 canonical-first order: the alias spelling joins the canonical resolution', getProjectDir(aOrder1) === getProjectDir(aliasOne), basename(getProjectDir(aliasOne)), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must resolve an alias spelling to the canonical key already memoised')
  const aOrder2 = join(scratchReal, 'real-root', 'alias-two')
  mkdirSync(aOrder2)
  const aliasTwo = join(scratchReal, 'alias-root', 'alias-two')
  check('§3 the second pair differs in spelling too', aliasTwo !== aOrder2 && realpathSync(aliasTwo) === realpathSync(aOrder2), '', 'the alias-root junction in the scratch dir did not resolve to real-root; this is a fixture or filesystem problem, not getProjectDir')
  check('§3 alias-first order: the canonical spelling joins the alias resolution', getProjectDir(aliasTwo) === getProjectDir(aOrder2), basename(getProjectDir(aOrder2)), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must key the alias spelling by its canonical identity, not its raw slug')
  check('§3 the shared resolution is the CANONICAL key (the alias never wins its own raw slug)', getProjectDir(aliasTwo) === join(projectsDir, projectSlug(realpathSync(aOrder2).normalize('NFC'))), basename(getProjectDir(aliasTwo)), 'getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts must derive projectSlug from identity.canonical (the realpath), not from the spelling given')

  const pathsLayer = await import(join(ROOT, 'src/sessions/transcripts/paths.ts'))
  const wAlias = join(scratchReal, 'alias-root', 'wrapper-late-project')
  const wTrue = join(scratchReal, 'real-root', 'wrapper-late-project')
  const wDead = pathsLayer.getProjectDir(wAlias)
  mkdirSync(wTrue)
  const wAlive = pathsLayer.getProjectDir(wAlias)
  const wTruth = pathsLayer.getProjectDir(wTrue)
  check('§4 THE WRAPPER: paths.getProjectDir never freezes a failed-canonicalization answer (the consumer layer obeys the §2 law)', wAlive === wTruth, `alive=${basename(wAlive)} true=${basename(wTruth)}`, 'getProjectDir in src/sessions/transcripts/paths.ts must stay a plain delegate to getProjectDir in src/sessions/transcripts/sessionStoragePortable.ts with no cache of its own; the freeze, if any, is in the portable one')
  check('§4 the dead answer differed (the leg has teeth: dead raw-slug vs alive canonical)', wDead !== wAlive, basename(wDead), 'the proof fixture no longer separates the dead and alive answers; check that getProjectDir in src/sessions/transcripts/paths.ts still reaches the raw-slug key for a missing folder')
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL KEY-STABILITY PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
