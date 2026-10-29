import { join } from 'node:path'

import envPaths from 'env-paths'

import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'


const mercuryPaths = envPaths('mercury')

const cacheRoot = mercuryPaths.cache

const MAX_DIR_NAME_LENGTH = 200

function sanitizeDirName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_DIR_NAME_LENGTH) return sanitized
  const suffix = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_DIR_NAME_LENGTH)}-${suffix}`
}

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
