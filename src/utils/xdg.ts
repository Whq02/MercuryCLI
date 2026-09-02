import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * XDG base-directory resolution with injectable env/home for testing.
 *
 * Two shipped subtleties, both deliberate to preserve: the effective home
 * NEVER consults the injected env object (only the `homedir` option moves
 * it — a `HOME` inside the injected env silently exercises the real home);
 * and empty-string env values count as SET (nullish coalescing), so an
 * explicitly empty XDG variable yields an empty base path.
 */

export type XdgOptions = {
  env?: Record<string, string | undefined>
  homedir?: string
}

function resolveHome(options?: XdgOptions): string {
  return options?.homedir ?? process.env.HOME ?? homedir()
}

export function getXDGStateHome(options?: XdgOptions): string {
  const env = options?.env ?? process.env
  return env.XDG_STATE_HOME ?? join(resolveHome(options), '.local', 'state')
}

export function getXDGDataHome(options?: XdgOptions): string {
  const env = options?.env ?? process.env
  return env.XDG_DATA_HOME ?? join(resolveHome(options), '.local', 'share')
}

/** Not an XDG variable — the conventional user bin location; only the home override affects it. */
export function getUserBinDir(options?: XdgOptions): string {
  return join(resolveHome(options), '.local', 'bin')
}
