
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

export function probeScopeAuth(
  dir: string,
): { authed: boolean; email?: string; uuid?: string } {
  const id = readScopeIdentity(join(dir, '.claude.json'))
  if (id.uuid) {
    return { authed: true, uuid: id.uuid, ...(id.email ? { email: id.email } : {}) }
  }
  const credFile = existsSync(join(dir, '.credentials.json'))
  return { authed: credFile }
}

export function scanAccountScopes(): AccountScope[] {
  const dir = resolve(getMercuryHome())
  return [
    {
      name: 'primary',
      dir,
      isCurrent: true,
      hasConfig: existsSync(join(dir, '.claude.json')),
      claudeFamily: isClaudeFamilyDir(dir),
      ...probeScopeAuth(dir),
    },
  ]
}
