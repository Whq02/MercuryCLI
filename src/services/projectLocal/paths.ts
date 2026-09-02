// ============================================================================
//  services/projectLocal/paths.ts — the ONE path owner of the project-local
//  working-state directory: `<root>/.mercury/`.
//
//  `.mercury/` is the official durable project-local home — where Mercury's
//  own per-project artifacts (Apollo specs, doctor state) and the MAIN
//  agent's durable working state (handoff notes, plans, working specs) live.
//  Its laws, owned here:
//
//    · ORGANIC BIRTH — the directory is created on FIRST USE (a spec written,
//      a doctor artifact persisted, a note the agent files), NEVER on a bare
//      boot. Booting Mercury in a virgin project must leave the tree exactly
//      as it found it; projectLocalEstateExists() is the gate boot-time
//      writers consult.
//    · NO GITIGNORE TOUCHING — whether the estate is checked in is the
//      operator's call; nothing here writes ignore rules.
//    · ONE NAME — the directory name derives from projectConfig's
//      MERCURY_PROJECT_DIR (config READ resolution stays with projectConfig;
//      the alias-refusing write resolver stays with projectStoreAdoption).
//
//  Consumers: pure derivations for surfaces that only NAME a path (Apollo's
//  spec home), the write verb for stores that are about to WRITE (doctor
//  artifacts), and the estate-exists gate for bare-boot writers.
// ============================================================================
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { MERCURY_PROJECT_DIR, PROJECT_CONFIG_DIR_NAMES, projectConfigDirs } from '../../utils/projectConfig.js'
import { adoptiveProjectPath } from '../../utils/projectStoreAdoption.js'

/** `<root>/.mercury` — pure derivation; never probes, never creates. */
export function projectLocalDir(root: string): string {
  return join(root, MERCURY_PROJECT_DIR)
}

/** `<root>/.mercury/<segments>` — pure derivation for surfaces that name a
 *  path without writing it (the writer that follows creates on first use). */
export function projectLocalPath(root: string, ...segments: string[]): string {
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

/** The canonical WRITE home for a project-local store, with the alias
 *  refusal (projectStoreAdoption owns it). For callers about to persist —
 *  resolving is pure. */
export function adoptiveProjectLocalPath(root: string, ...segments: string[]): string {
  return adoptiveProjectPath(root, ...segments)
}

/** True when the project-local estate is already ESTABLISHED under `root`
 *  (`.mercury/` exists). The bare-boot gate: boot-time housekeeping may
 *  refresh artifacts inside an existing estate but must never be the
 *  estate's creator. */
export function projectLocalEstateExists(root: string): boolean {
  return projectConfigDirs(root).some(home => existsSync(home))
}

/** THE ESTATE'S BIRTH — the ONE creator of `<root>/.mercury/` (the
 *  folder-as-project law): the catalog owner
 *  (utils/bootCardFacts catalogFirstChat) calls this after the FIRST chat
 *  is born in `root`; no boot-time writer ever does. The minimal shape is
 *  the directory itself — nothing speculative inside; the stores that live
 *  here keep creating their own files on first use. Idempotent: an
 *  existing estate answers `created: false`.
 *
 *  Refused (null), by design: a root that IS a project-config home (a
 *  terminal opened inside `.mercury` works in its parent's project — never
 *  a nested home); the home directory (the config home's own default seat,
 *  and trust never persists there either); a filesystem root; an alias into
 *  a foreign harness dir (the adoption owner's refusal); a folder that
 *  cannot take a directory (vanished, read-only). The estate stays the
 *  operator's: no ignore rules are written and nothing here deletes. */
export function initializeProjectLocalEstate(root: string): { dir: string; created: boolean } | null {
  if ((PROJECT_CONFIG_DIR_NAMES as readonly string[]).includes(basename(root))) return null
  const absolute = resolve(root)
  if (dirname(absolute) === absolute) return null
  let home = ''
  try {
    home = resolve(homedir())
  } catch {
    /* no home to refuse */
  }
  if (home !== '' && absolute === home) return null
  if (projectLocalEstateExists(root)) return { dir: projectLocalDir(root), created: false }
  let dir: string
  try {
    dir = adoptiveProjectPath(root)
  } catch {
    return null
  }
  try {
    mkdirSync(dir)
  } catch (error) {
    return (error as { code?: string }).code === 'EEXIST' ? { dir, created: false } : null
  }
  return { dir, created: true }
}
