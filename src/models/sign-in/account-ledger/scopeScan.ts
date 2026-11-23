
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { globalConfigFileIn } from '../../../platform/environment/env.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type ScopeIdentity = { uuid?: string; email?: string }

export type AccountScope = {
  name: string
  dir: string
  isCurrent: boolean
  hasConfig: boolean
  authed: boolean
  unreadError?: string
  email?: string
  uuid?: string
  foreignHarness: boolean
}

const FOREIGN_HARNESS_HOMES = new Set(['.codex', '.gemini', '.copilot', '.cursor', '.kiro', '.cline', '.continue', '.qwen', '.pi', '.omp'])
const FOREIGN_HARNESS_CONFIG_HOMES = new Set(['opencode', 'amp', 'goose'])
export function isForeignHarnessDir(dir: string): boolean {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const base = basename(trimmed)
  const parent = basename(dirname(trimmed))
  if ([base, parent].some(s => FOREIGN_HARNESS_HOMES.has(s))) return true
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
  } catch (error) {
    passedOver(error)
  }
  return {}
}

interface ScopeAuthReads {
  storedLogin?: (dir: string) => boolean
}

export function scopeIdentityFile(dir: string): string {
  return globalConfigFileIn(dir)
}

export function probeScopeAuth(
  dir: string,
  reads: ScopeAuthReads = {},
): { authed: boolean; unreadError?: string; email?: string; uuid?: string } {
  const id = readScopeIdentity(scopeIdentityFile(dir))
  const login = reads.storedLogin ? { authed: reads.storedLogin(dir) } : storedLoginLive(dir)
  return {
    authed: login.authed,
    ...(login.unreadError !== undefined ? { unreadError: login.unreadError } : {}),
    ...(id.uuid ? { uuid: id.uuid } : {}),
    ...(id.email ? { email: id.email } : {}),
  }
}

function storedLoginLive(dir: string): { authed: boolean; unreadError?: string } {
  try {
    if (resolve(dir) === resolve(getMercuryHome())) {
      const { hasStoredOAuthToken } = require('../credentials/auth.js') as typeof import('../credentials/auth.js')
      if (hasStoredOAuthToken()) return { authed: true }
      const { credentialStoreUnread } =
        require('../../../platform/secure-storage/index.js') as typeof import('../../../platform/secure-storage/index.js')
      const unread = credentialStoreUnread()
      return unread !== null
        ? { authed: false, unreadError: unread.message ?? unread.code }
        : { authed: false }
    }
    const { readAccountOAuthCreds } =
      require('./scopedCredentialRead.js') as typeof import('./scopedCredentialRead.js')
    return { authed: readAccountOAuthCreds(dir) !== undefined }
  } catch (error) {
    passedOver(error)
    return { authed: false, unreadError: error instanceof Error ? error.message : String(error) }
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
