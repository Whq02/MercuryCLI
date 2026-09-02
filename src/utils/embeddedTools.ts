import { isEnvTruthy } from './envUtils.js'

/**
 * Whether this build embeds alternative find/search binaries inside the
 * runtime executable, and where they live.
 *
 * When true (enforced elsewhere): the shell's find and search commands are
 * shadowed by functions invoking the runtime binary under a different
 * argv-zero; the dedicated file-discovery and search tools are removed from
 * the registry; and the prompt guidance steering the model away from the
 * shell equivalents is omitted.
 */

// Entrypoint markers set by the SDK and agent launchers.
const EXCLUDED_ENTRYPOINTS = new Set(['sdk', 'local-agent'])

export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint !== undefined && EXCLUDED_ENTRYPOINTS.has(entrypoint)) return false
  return true
}

/** The binary containing the embedded tools; meaningful only when embedded. */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
