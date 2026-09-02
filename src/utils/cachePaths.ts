import { join } from 'node:path'

import envPaths from 'env-paths'

import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'

/**
 * Per-project cache directory roots for error logs, message logs and MCP
 * logs.
 *
 * The on-disk name carries the `-nodejs` suffix the platform-paths
 * convention appends by default, so the directory that actually exists is
 * `mercury-nodejs`. The boot prover
 * `scripts/tree-ownership/prove-mercury-only-boot.ts` pins `mercury-nodejs` as
 * the one sanctioned cache-home spelling. (There is no
 * `claude-cli-nodejs` read — this tree holds
 * only regenerable logs.)
 */

const mercuryPaths = envPaths('mercury')

// Resolved once at module load.
const cacheRoot = mercuryPaths.cache

const MAX_DIR_NAME_LENGTH = 200

function sanitizeDirName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_DIR_NAME_LENGTH) return sanitized
  // The shared hash module's djb2Hash over the raw (unsanitised) name —
  // the two modules must agree on the formula.
  const suffix = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_DIR_NAME_LENGTH)}-${suffix}`
}

// The working directory here is the PROCESS working directory as the
// filesystem abstraction reports it — not the shell-tracked directory the
// attribution code follows. Each accessor reads it at call time.
function projectCacheBase(): string {
  return join(cacheRoot, sanitizeDirName(getFsImplementation().cwd()))
}

export const CACHE_PATHS = {
  baseLogs(): string {
    return projectCacheBase()
  },
  errors(): string {
    return join(projectCacheBase(), 'errors')
  },
  messages(): string {
    return join(projectCacheBase(), 'messages')
  },
  mcpLogs(serverName: string): string {
    return join(projectCacheBase(), `mcp-logs-${sanitizeDirName(serverName)}`)
  },
}
