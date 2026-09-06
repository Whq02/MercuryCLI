
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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

export function scopeIdentityFile(dir: string, reads: ScopeAuthReads = {}): string {
  const file = globalConfigFileIn(dir)
  adoptRetiredIdentitySnapshot(dir, file, reads)
  return file
}

const adoptionChecked = new Set<string>()

function adoptRetiredIdentitySnapshot(dir: string, file: string, reads: ScopeAuthReads): void {
  const key = resolve(dir)
  if (adoptionChecked.has(key)) return
  adoptionChecked.add(key)
  if (isClaudeFamilyDir(dir)) return
  if (readScopeIdentity(file).uuid !== undefined) return
  const retired = readScopeIdentity(join(dir, '.claude.json'))
  if (retired.uuid === undefined || retired.email === undefined) return
  if (!(reads.storedLogin ?? storedLoginLive)(dir)) return
  const { healScopeIdentitySnapshot } =
    require('./accountIdentity.js') as typeof import('./accountIdentity.js')
  healScopeIdentitySnapshot(dir, { email: retired.email, uuid: retired.uuid })
}

export function _resetIdentityAdoptionForTesting(): void {
  adoptionChecked.clear()
}

export function probeScopeAuth(
  dir: string,
  reads: ScopeAuthReads = {},
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(scopeIdentityFile(dir, reads))
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
      claudeFamily: isClaudeFamilyDir(dir),
      ...probeScopeAuth(dir, reads),
    },
  ]
}
