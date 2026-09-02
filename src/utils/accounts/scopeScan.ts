
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
  claudeFamily: boolean
}

export function isClaudeFamilyDir(dir: string): boolean {
  const base = basename(dir.replace(/[\\/]+$/, ''))
  return base === '.claude' || base.startsWith('.claude-')
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

export function probeScopeAuth(
  dir: string,
  reads: ScopeAuthReads = {},
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(join(dir, '.claude.json'))
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
      hasConfig: existsSync(join(dir, '.claude.json')),
      claudeFamily: isClaudeFamilyDir(dir),
      ...probeScopeAuth(dir, reads),
    },
  ]
}
