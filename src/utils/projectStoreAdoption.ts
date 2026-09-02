// ============================================================================
//  projectStoreAdoption — the canonical-write project resolver.
//
//  Mercury-owned project stores write under `<project>/.mercury/`, and this
//  module is the ONE owner of that path for callers about to WRITE:
//
//    adoptiveProjectPath(root, ...segments)
//      → `<root>/.mercury/<segments>` ALWAYS (the write home), after the
//        alias refusal below.
//
//  Laws:
//    · pure — no directory is created here; the writer that follows creates
//      on first use;
//    · never writes through an alias — a `.mercury` that is a link into an
//      external harness's `.claude` dir would silently deposit Mercury
//      stores inside a foreign tool's estate, so it is refused before any
//      mutation.
// ============================================================================
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'

/** A configured canonical root that RESOLVES into a foreign harness dir —
 *  through a symlink, junction, or case alias — must never be written
 *  through. Typed error, raised before any mutation. */
export class CanonicalRootAliasError extends Error {
  constructor(
    readonly canonicalDir: string,
    readonly aliasedInto: string,
  ) {
    super(
      `canonical project home ${canonicalDir} resolves into ${aliasedInto} — ` +
        `refusing to write through an alias (create a real .mercury directory or remove the link)`,
    )
    this.name = 'CanonicalRootAliasError'
  }
}

/** Refuse when `.mercury` is an alias into an external harness's `.claude`
 *  dir: the dir is nobody's import source, but a `.mercury` symlink into it
 *  would still silently deposit Mercury stores inside a foreign tool's
 *  estate. */
function assertCanonicalRootNotAliased(root: string): void {
  const canonicalDir = join(root, MERCURY_PROJECT_DIR)
  if (!existsSync(canonicalDir)) return
  let real: string
  try {
    real = realpathSync(canonicalDir)
  } catch {
    return
  }
  const source = join(root, '.claude')
  if (!existsSync(source)) return
  let realSource: string
  try {
    realSource = realpathSync(source)
  } catch {
    return
  }
  if (real === realSource) throw new CanonicalRootAliasError(canonicalDir, source)
}

/**
 * The canonical HOME of a Mercury-owned project store: always
 * `.mercury/<segments>`. Throws CanonicalRootAliasError when `.mercury` is a
 * link into a foreign harness dir (the write-through refusal).
 */
export function adoptiveProjectPath(root: string, ...segments: string[]): string {
  assertCanonicalRootNotAliased(root)
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

/**
 * The canonical project path for ephemeral machinery (worktrees, scratch
 * checkouts) — the same resolution and the same alias refusal as
 * adoptiveProjectPath.
 */
export function nonAdoptiveProjectPath(
  root: string,
  ...segments: string[]
): string {
  return adoptiveProjectPath(root, ...segments)
}
