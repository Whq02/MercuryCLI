// ============================================================================
//  src/extensions/paths.ts — the ONE path owner for the extensions estate.
//
//  Everything lives under <config home>/extensions (or the directory
//  MERCURY_EXTENSIONS_DIR names):
//
//    sources.json          the source records
//    installed.json        the installed records
//    sources/<label>/      a git or archive source's cached checkout
//    installed/<id>/<ver>/ an installed extension's immutable copy
//    data/<id>/            an extension's persistent data folder
//    bundled/<name>/<v>/   a bundled extension's extracted copy
//
//  No other module spells these names; consumers ask here.
// ============================================================================
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'

export const MANIFEST_FILE = 'mercury-extension.json'
export const CATALOGUE_FILE = 'mercury-extensions.json'
export const PROJECT_EXTENSIONS_DIR = 'extensions'
export const SOURCES_FILE = 'sources.json'
export const INSTALLED_FILE = 'installed.json'

/** The estate root: MERCURY_EXTENSIONS_DIR wins; else <config home>/extensions. */
export function getExtensionsRoot(): string {
  const override = process.env.MERCURY_EXTENSIONS_DIR
  if (override && override.trim() !== '') return override.trim()
  return join(getMercuryHome(), 'extensions')
}

export function getSourcesFile(): string {
  return join(getExtensionsRoot(), SOURCES_FILE)
}

export function getInstalledFile(): string {
  return join(getExtensionsRoot(), INSTALLED_FILE)
}

export function getSourcesDir(): string {
  return join(getExtensionsRoot(), 'sources')
}

export function getInstalledDir(): string {
  return join(getExtensionsRoot(), 'installed')
}

export function getDataDir(): string {
  return join(getExtensionsRoot(), 'data')
}

export function getBundledDir(): string {
  return join(getExtensionsRoot(), 'bundled')
}

/** The extensions log: one line per act (add, install, approve, uninstall, reconcile). */
export function getExtensionsLog(): string {
  return join(getExtensionsRoot(), 'extensions.log')
}

/**
 * Thrown by `versionFolderName` when the folded version would be a path
 * word (`.`, `..`, empty) — a spelling that would aim the install/update
 * rename-and-delete pair at `installed/` or `installed/<id>/` itself. A
 * hostile version string is a refusal, never a rename.
 */
export class VersionFolderTraversalError extends Error {
  constructor(version: string) {
    super(`version ${JSON.stringify(version)} cannot name an install folder — refused`)
    this.name = 'VersionFolderTraversalError'
  }
}

/**
 * A version string as a folder name: `[A-Za-z0-9._-]`, every other
 * character becomes `_`. The manifest's version is the thing the operator
 * sees; this is only the folder it lands in. The fold REFUSES (typed) any
 * spelling whose folded form is `.`, `..` or empty: those resolve to the
 * id directory or to `installed/` itself, and every caller joins the
 * result under `installed/<id>/`.
 */
export function versionFolderName(version: string): string {
  const folded = version.replace(/[^A-Za-z0-9._-]/g, '_')
  if (folded === '' || folded === '.' || folded === '..') throw new VersionFolderTraversalError(version)
  return folded
}

/**
 * An id as a folder name. The id `<name>@<label>` is already restricted to
 * `[a-z0-9-]` on both halves by the name and label grammars, joined by `@`
 * (path-safe on every supported filesystem); anything else becomes `_`.
 */
export function idFolderName(id: string): string {
  return id.replace(/[^A-Za-z0-9@._-]/g, '_')
}

export function getSourceCacheDir(label: string): string {
  return join(getSourcesDir(), idFolderName(label))
}

export function getInstalledVersionDir(id: string, version: string): string {
  return join(getInstalledDir(), idFolderName(id), versionFolderName(version))
}

export function getInstalledIdDir(id: string): string {
  return join(getInstalledDir(), idFolderName(id))
}

/** The persistent data folder for one extension (not created here). */
export function getExtensionDataDir(id: string): string {
  return join(getDataDir(), idFolderName(id))
}

export function getBundledVersionDir(name: string, mercuryVersion: string): string {
  return join(getBundledDir(), idFolderName(name), versionFolderName(mercuryVersion))
}
