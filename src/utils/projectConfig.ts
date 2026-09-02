// ============================================================================
//  projectConfig — Mercury's project-config dir.
//
//  Mercury is a sovereign harness; its per-project files live under
//  `<project>/.mercury/`, the one project-config home. An external
//  harness's project dir (`.claude`) is never a Mercury home.
//
//  Three verbs cover the estate:
//
//    resolveProjectConfigPath  READ resolution for a config file/dir:
//                              `.mercury/<p>` when it exists, else null.
//    (write homes)             Mercury-owned stores write under
//                              `.mercury/<p>` — see
//                              utils/projectStoreAdoption.adoptiveProjectPath.
//    projectConfigCandidates   every existing home, `.mercury` first — for
//                              loaders that MERGE (skills/commands/agents:
//                              an earlier-home entry shadows a same-named
//                              later-home one at the loader's dedup seam).
//
//  Pure path logic + existsSync only; no writes here.
// ============================================================================
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { projectLocalPath } from '../services/projectLocal/paths.js'

export const MERCURY_PROJECT_DIR = '.mercury'

/** The home DIR NAMES in read-precedence order — for loaders that iterate
 *  relative names rather than joined paths. */
export const PROJECT_CONFIG_DIR_NAMES = [MERCURY_PROJECT_DIR] as const

/** All project-config homes under `root`, read-precedence order. */
export function projectConfigDirs(root: string): [string] {
  return [join(root, MERCURY_PROJECT_DIR)]
}

/** The Apollo spec-file home for a project root: `<root>/.mercury/apollo/`.
 *  ONE derivation — the mode appendix names it, the interview pack writes
 *  under it, and the write-permission ladder's mode consent is scoped to it
 *  (a drifted spelling would either ask for the mode's own artifacts or
 *  quietly widen the consent). */
export function apolloSpecDirectory(projectRoot: string): string {
  // Delegates to the crowned project-local path owner — one derivation for
  // the appendix, the pack, and the ladder's mode consent alike (a cyclic
  // import is safe here: both sides are hoisted function declarations).
  return projectLocalPath(projectRoot, 'apollo')
}

/** READ resolution: the first EXISTING `<home>/<segments>` (`.mercury` wins),
 *  else null. For config the caller only reads. */
export function resolveProjectConfigPath(root: string, ...segments: string[]): string | null {
  for (const home of projectConfigDirs(root)) {
    const candidate = join(home, ...segments)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every EXISTING `<home>/<segments>`, `.mercury` first — for merging loaders. */
export function projectConfigCandidates(root: string, ...segments: string[]): string[] {
  return projectConfigDirs(root)
    .map(home => join(home, ...segments))
    .filter(p => existsSync(p))
}

/** Every `<home>/<segments>` REGARDLESS of existence — for WATCHERS, which
 *  must see a home that does not exist yet: its creation is the event they
 *  wait for (release-hardening audit rank 28). Loaders keep
 *  projectConfigCandidates (existing only). */
export function projectConfigCandidatePaths(root: string, ...segments: string[]): string[] {
  return projectConfigDirs(root).map(home => join(home, ...segments))
}
