#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-project-key-stability.ts
//  PROOF (the concourse re-home bug, second concern): THE KEY IS A STABLE
//  FUNCTION OF FOLDER IDENTITY — never of call order or of the filesystem
//  state at each spelling's FIRST call. The disease this fences (proven
//  live in the lane census, one process): the adoption ladder's memo was
//  keyed on the raw spelling and froze the state at first call, so two
//  canonical-EQUAL spellings first-called around a store birth resolved
//  DIFFERENT keys forever — one project, two keys, one process — and a
//  spelling whose canonicalization failed TRANSIENTLY (an unmaterialized
//  or momentarily unreadable folder) froze its wrong raw-slug key for the
//  process lifetime.
//    §1 THE STRADDLE: legacy store present, hashed store born between two
//       canonical-equal spellings' first calls — ONE key, both spellings.
//    §2 NO FREEZE ON FAILURE: a spelling first seen while its folder is
//       missing re-resolves after the folder appears (the true canonical
//       key, not the frozen raw-slug one).
//    §3 THE CANONICAL SLOT: alias spellings share one resolution in both
//       call orders (the memo keys identity, not spelling).
//    §4 THE CONSUMER WRAPPER: sessionStorage/paths re-exports the ladder to
//       every product surface — the same no-freeze law must hold THERE (a
//       second memo above the ladder once re-froze the failed answer §2
//       outlaws).
//  LIVE: sessionStoragePortable is pure Node (the portability contract);
//  §4 imports the paths layer (bootstrap-state carrying, still node-safe).
// ============================================================================

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// Proof hygiene: pin the config home to a scratch root BEFORE the imports —
// the straddle legs create store dirs, and those writes must never land in
// the operator's real home.
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

// mkdtempSync answers under /var/folders on macOS while the canonical truth
// is /private/var/… — the natural alias pair the legs below lean on.
const scratch = mkdtempSync(join(tmpdir(), 'keystab-'))
const scratchReal = realpathSync(scratch)
try {
  // §1 — THE STRADDLE: a legacy (hash-less) store stands; the hashed store
  // is born BETWEEN the first calls of two canonical-equal spellings.
  const straddle = join(scratchReal, 'straddle-project')
  mkdirSync(straddle)
  const canonical = realpathSync(straddle).normalize('NFC')
  const legacyStore = join(projectsDir, sanitizePath(canonical))
  mkdirSync(legacyStore)
  // Adoption needs a store FACT (a transcript inside) — FC-007.
  writeFileSync(join(legacyStore, '00000000-0000-0000-0000-000000000003.jsonl'), '')
  const k1 = getProjectDir(straddle) // first spelling: hashed absent -> legacy
  mkdirSync(join(projectsDir, projectSlug(canonical))) // the hashed twin is born
  const k2 = getProjectDir(straddle + '/') // canonical-equal second spelling
  check('§1 THE STRADDLE: canonical-equal spellings resolve ONE key across a store birth (the memo keys identity, not first-call state)', k1 === k2, `k1=${basename(k1)} k2=${basename(k2)}`)
  check('§1 the one key is the FIRST resolution (the standing store keeps its sessions — no mid-process migration)', k2 === legacyStore, basename(k2))

  // §2 — NO FREEZE ON FAILURE: a spelling first seen while its folder is
  // missing must re-resolve once the folder exists. The alias spelling
  // canonicalizes DIFFERENTLY dead vs alive, so a frozen first answer is
  // visibly wrong afterwards. The alias is MINTED (a symlinked segment the
  // prover creates): the old tmp-alias shape (`/var/…` for `/private/var/…`)
  // was macOS-only — linux /tmp is already canonical, so dead and alive
  // answered the SAME slug and the teeth legs read a lawful ladder as red
  // (gate run 1 s10). A junction-typed link keeps win32 in the same law.
  mkdirSync(join(scratchReal, 'real-root'))
  symlinkSync(join(scratchReal, 'real-root'), join(scratchReal, 'alias-root'), 'junction')
  const aliasSpelling = join(scratchReal, 'alias-root', 'late-born-project') // the symlinked spelling
  const trueDir = join(scratchReal, 'real-root', 'late-born-project')
  const deadKey = getProjectDir(aliasSpelling) // folder missing: raw-slug fallback
  mkdirSync(trueDir) // the folder appears (materialized)
  const aliveKey = getProjectDir(aliasSpelling)
  const trueKey = getProjectDir(trueDir)
  check('§2 NO FREEZE: the dead-spelling answer is not frozen — once the folder exists the spelling resolves its TRUE canonical key', aliveKey === trueKey, `alive=${basename(aliveKey)} true=${basename(trueKey)}`)
  check('§2 the dead answer differed (the leg has teeth: dead raw-slug vs alive canonical)', deadKey !== aliveKey, basename(deadKey))

  // §3 — THE CANONICAL SLOT, both call orders.
  const aOrder1 = join(scratchReal, 'alias-one') // canonical spelling first
  mkdirSync(aOrder1)
  const aliasOne = join(scratch, 'alias-one')
  check('§3 canonical-first order: the alias spelling joins the canonical resolution', getProjectDir(aOrder1) === getProjectDir(aliasOne), basename(getProjectDir(aliasOne)))
  const aOrder2 = join(scratchReal, 'alias-two')
  mkdirSync(aOrder2)
  const aliasTwo = join(scratch, 'alias-two')
  check('§3 alias-first order: the canonical spelling joins the alias resolution', getProjectDir(aliasTwo) === getProjectDir(aOrder2), basename(getProjectDir(aOrder2)))

  // §4 — THE CONSUMER WRAPPER RIDES THE SAME LAW: the product imports
  // getProjectDir through sessionStorage/paths, not the ladder directly.
  // §2's leg replayed through the wrapper: a memo at that layer keyed by
  // the raw spelling would freeze the failed-canonicalization answer the
  // ladder deliberately refuses to cache.
  const pathsLayer = await import(join(ROOT, 'src/utils/sessionStorage/paths.ts'))
  // The same minted-alias teeth as §2 (the symlinked segment differs dead
  // vs alive on every platform; the bare tmp alias did not off-mac).
  const wAlias = join(scratchReal, 'alias-root', 'wrapper-late-project') // the symlinked spelling
  const wTrue = join(scratchReal, 'real-root', 'wrapper-late-project')
  const wDead = pathsLayer.getProjectDir(wAlias) // folder missing: raw-slug fallback
  mkdirSync(wTrue) // the folder appears (materialized)
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
