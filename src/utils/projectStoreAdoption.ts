import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { MERCURY_PROJECT_DIR } from './projectConfig.js'

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

export function adoptiveProjectPath(root: string, ...segments: string[]): string {
  assertCanonicalRootNotAliased(root)
  return join(root, MERCURY_PROJECT_DIR, ...segments)
}

export function nonAdoptiveProjectPath(
  root: string,
  ...segments: string[]
): string {
  return adoptiveProjectPath(root, ...segments)
}
