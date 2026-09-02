#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-project-home-fold.ts
//  PROOF (the concourse re-home bug, ruled): THE CONFIG-HOME FOLD — a
//  directory that IS a project-config home (`.mercury`) is never a project
//  of its own; it keys to its PARENT at the ONE shared derivation
//  (getProjectDir), exactly as the ruled naming precedent already displays
//  it (projectDisplayName wears the parent's name). The disease this fences:
//  a session born with the config home as its workspace minted a TWIN store
//  (`…-One-Shot-Prompt--mercury-…` beside `…-One-Shot-Prompt-…` on the
//  operator's own disk) and classed as ANOTHER project wearing the SAME
//  display name — "1 running in <project>" on that project's own board.
//    §1 the fold at the key: `.mercury` tail keys to the parent; the name
//       and the key agree (the coherence law).
//    §2 the canonical side folds too: a symlink resolving INTO a config
//       home keys to the parent.
//    §3 the naming rule's own guard: a root-level config dir stands
//       unfolded; a self-named parent stands unfolded.
//    §4 POISON CONTROL: an ordinary subdir still keys to ITSELF
//       (folder-as-project stands — the fold is config-home-tails ONLY).
//    §5 the adoption ladder rides the FOLDED spelling: the parent's legacy
//       store is honoured for a config-home spelling.
//    §6 THE WRITE-SIDE HEAL (the ruling's rider): the transcript-home pin
//       (MERCURY_SESSION_HOME = getProjectDir(workspaceId)) stores a
//       `.mercury`-grounded birth PARENT-side — derivation + source seam.
//  LIVE: sessionStoragePortable is pure Node (the portability contract).
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// Proof hygiene (.claude/rules/proof-hygiene.md): pin the config home to a
// scratch root BEFORE the imports — the ladder legs create store dirs, and
// those writes must never land in the operator's real home.
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'homefold-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = resolve(import.meta.dir, '..', '..')
const { getProjectDir, foldProjectConfigHomeTail, sanitizePath } = await import(
  join(ROOT, 'src/utils/sessionStoragePortable.ts')
)
const { projectDisplayName } = await import(join(ROOT, 'src/utils/bootCardFacts.ts'))
const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' the config-home fold — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'homefold-'))
try {
  // §1 — the fold at the key + the coherence law.
  const root = join(scratch, 'One Shot Prompt')
  const configHome = join(root, '.mercury')
  mkdirSync(configHome, { recursive: true })
  check('§1 a `.mercury` tail keys to its PARENT (one project, one key)', getProjectDir(configHome) === getProjectDir(root), `${basename(getProjectDir(configHome))} vs ${basename(getProjectDir(root))}`)
  check('§1 COHERENCE: the key folds exactly where the ruled naming rule folds — the name and the key can never contradict on one frame', projectDisplayName(configHome) === basename(root) && getProjectDir(configHome) === getProjectDir(root))
  check('§1 the pure fold names the parent', foldProjectConfigHomeTail(configHome) === root)
  check('§1 a trailing separator folds the same', getProjectDir(configHome + '/') === getProjectDir(root))

  // §2 — the canonical side: a symlink resolving INTO a config home.
  const link = join(scratch, 'door-to-home')
  symlinkSync(configHome, link)
  check('§2 a symlink resolving INTO a config home keys to the parent (the canonical spelling folds too)', getProjectDir(link) === getProjectDir(root), basename(getProjectDir(link)))

  // §3 — the guard, mirrored from the naming rule.
  check('§3 a root-level config dir stands unfolded (no parent name to wear)', foldProjectConfigHomeTail('/.mercury') === '/.mercury')
  const selfNamed = join(scratch, '.mercury', '.mercury')
  check('§3 a self-named parent stands unfolded (the naming rule\'s own guard)', foldProjectConfigHomeTail(selfNamed) === selfNamed)

  // §4 — POISON CONTROL: folder-as-project stands for ordinary subdirs.
  const sub = join(root, 'csgo-prototype')
  mkdirSync(sub, { recursive: true })
  check('§4 an ordinary subdir still keys to ITSELF (the fold is config-home tails only — folder-as-project stands)', getProjectDir(sub) !== getProjectDir(root) && basename(getProjectDir(sub)).includes('csgo-prototype'), basename(getProjectDir(sub)))

  // §5 — the ladder rides the folded spelling: the PARENT's legacy store is
  // honoured when a config-home spelling resolves.
  const legacyRoot = join(scratch, 'legacy-era-project')
  const legacyHome = join(legacyRoot, '.mercury')
  mkdirSync(legacyHome, { recursive: true })
  const projectsDir = join(getMercuryHome(), 'projects')
  const legacyStore = join(projectsDir, sanitizePath(legacyRoot))
  mkdirSync(legacyStore, { recursive: true })
  // Adoption needs a store FACT (a transcript inside) — FC-007.
  writeFileSync(join(legacyStore, '00000000-0000-0000-0000-000000000002.jsonl'), '')
  try {
    check('§5 the adoption ladder rides the FOLDED spelling: a config-home spelling adopts the PARENT\'s legacy store in place', getProjectDir(legacyHome) === legacyStore, getProjectDir(legacyHome))
  } finally {
    rmSync(legacyStore, { recursive: true, force: true })
  }

  // §6 — THE WRITE-SIDE HEAL (the ruling's rider): the transcript-home pin
  // derivation stores a `.mercury`-grounded birth parent-side …
  check('§6 the transcript-home derivation stores a `.mercury`-grounded birth PARENT-side (MERCURY_SESSION_HOME\'s value)', getProjectDir(configHome) === getProjectDir(root) && getProjectDir(configHome).includes(sanitizePath(root).slice(0, 20)))
  // … and the daemon's spawn seam pins the home through THAT derivation (the
  // fold's consumer names the law beside the pin).
  const supervisor = readFileSync(join(ROOT, 'src/daemon/concourseSupervisor.ts'), 'utf8')
  check('§6 SOURCE SEAM: the spawn pins MERCURY_SESSION_HOME via getProjectDir(args.workspaceId) and names the config-home fold beside it', supervisor.includes('MERCURY_SESSION_HOME: getProjectDir(args.workspaceId)') && supervisor.includes('config-home fold'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL CONFIG-HOME FOLD PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
