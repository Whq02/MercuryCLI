
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { globalConfigFileIn } from '../env.js'
import { getMercuryHome } from '../envUtils.js'

export type ScopeIdentity = { uuid?: string; email?: string }

export type AccountScope = {
  name: string
  dir: string
  isCurrent: boolean
  hasConfig: boolean
  authed: boolean
  email?: string
  uuid?: string
  foreignHarness: boolean
}

const FOREIGN_HARNESS_HOMES = new Set(['.claude', '.codex', '.gemini', '.copilot', '.cursor', '.kiro', '.cline', '.continue', '.qwen', '.pi', '.omp'])
const FOREIGN_HARNESS_CONFIG_HOMES = new Set(['opencode', 'amp', 'goose'])
export function isForeignHarnessDir(dir: string): boolean {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const base = basename(trimmed)
  const parent = basename(dirname(trimmed))
  if ([base, parent].some(s => FOREIGN_HARNESS_HOMES.has(s) || s.startsWith('.claude-'))) return true
  return parent === '.config' && FOREIGN_HARNESS_CONFIG_HOMES.has(base)
}

export function readScopeIdentity(configFile: string): ScopeIdentity {
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as {
      oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown }
    }
    const oa = parsed.oauthAccount
    if (oa && typeof oa.accountUuid === 'string' && oa.accountUuid.trim()) {
      return {
        uuid: oa.accountUuid.trim(),
        ...(typeof oa.emailAddress === 'string' && oa.emailAddress.trim()
          ? { email: oa.emailAddress.trim() }
          : {}),
      }
    }
  } catch {
  }
  return {}
}

export interface ScopeAuthReads {
  storedLogin?: (dir: string) => boolean
}

export function scopeIdentityFile(dir: string): string {
  return globalConfigFileIn(dir)
}

export function probeScopeAuth(
  dir: string,
  reads: ScopeAuthReads = {},
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(scopeIdentityFile(dir))
  const authed = (reads.storedLogin ?? storedLoginLive)(dir)
  return {
    authed,
    ...(id.uuid ? { uuid: id.uuid } : {}),
    ...(id.email ? { email: id.email } : {}),
  }
}

function storedLoginLive(dir: string): boolean {
  try {
    if (resolve(dir) === resolve(getMercuryHome())) {
      const { hasStoredOAuthToken } = require('../auth.js') as typeof import('../auth.js')
      return hasStoredOAuthToken()
    }
    const { readAccountOAuthCreds } =
      require('./scopedCredentialRead.js') as typeof import('./scopedCredentialRead.js')
    return readAccountOAuthCreds(dir) !== undefined
  } catch {
    return false
  }
}

export function scanAccountScopes(reads: ScopeAuthReads = {}): AccountScope[] {
  const dir = resolve(getMercuryHome())
  return [
    {
      name: 'primary',
      dir,
      isCurrent: true,
      hasConfig: existsSync(globalConfigFileIn(dir)),
      foreignHarness: isForeignHarnessDir(dir),
      ...probeScopeAuth(dir, reads),
    },
  ]
}
