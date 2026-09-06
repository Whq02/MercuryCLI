import { flagEnabled } from '../substrate/flagRegistry.js'


const EXCLUDED_ENTRYPOINTS = new Set(['headless', 'local-agent'])

export function hasEmbeddedSearchTools(): boolean {
  if (!flagEnabled('MERCURY_EMBEDDED_SEARCH_TOOLS')) return false
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint !== undefined && EXCLUDED_ENTRYPOINTS.has(entrypoint)) return false
  return true
}

export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
