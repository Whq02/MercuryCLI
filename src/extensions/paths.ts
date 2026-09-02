import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'

export const MANIFEST_FILE = 'mercury-extension.json'
export const CATALOGUE_FILE = 'mercury-extensions.json'
export const PROJECT_EXTENSIONS_DIR = 'extensions'
export const SOURCES_FILE = 'sources.json'
export const INSTALLED_FILE = 'installed.json'

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

export function getExtensionsLog(): string {
  return join(getExtensionsRoot(), 'extensions.log')
}

export class VersionFolderTraversalError extends Error {
  constructor(version: string) {
    super(`version ${JSON.stringify(version)} cannot name an install folder — refused`)
    this.name = 'VersionFolderTraversalError'
  }
}

export function versionFolderName(version: string): string {
  const folded = version.replace(/[^A-Za-z0-9._-]/g, '_')
  if (folded === '' || folded === '.' || folded === '..') throw new VersionFolderTraversalError(version)
  return folded
}

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

export function getExtensionDataDir(id: string): string {
  return join(getDataDir(), idFolderName(id))
}

export function getBundledVersionDir(name: string, mercuryVersion: string): string {
  return join(getBundledDir(), idFolderName(name), versionFolderName(mercuryVersion))
}
