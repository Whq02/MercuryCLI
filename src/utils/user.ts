
import memoize from 'lodash-es/memoize.js'

import { getSessionId } from '../bootstrap/state.js'
import { getOauthAccountInfo, getRateLimitTier, getSubscriptionType } from './auth.js'
import { getOrCreateUserID } from './config.js'
import { getCwd } from './cwd.js'
import { getHostPlatformForAnalytics } from './env.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * Analytics "core user" identity: the memoized core record, the email
 * lifecycle (initializer/reset) and the git-email helper. The record's
 * field names are the analytics wire — do not rename them.
 */

export type GitHubActionsMetadata = {
  actor?: string
  actorId?: string
  repository?: string
  repositoryId?: string
  repositoryOwner?: string
  repositoryOwnerId?: string
}

export type CoreUserData = {
  deviceId: string
  sessionId: string
  email?: string
  appVersion: string
  platform: string
  organizationUuid?: string
  accountUuid?: string
  /** A constant, never derived from the account. */
  userType: 'external'
  subscriptionType?: string
  rateLimitTier?: string
  githubActionsMetadata?: GitHubActionsMetadata
}

let resolvedEmail: string | undefined
let emailResolution: Promise<void> | null = null

/**
 * The GitHub Actions block: present ONLY when `GITHUB_ACTIONS` is truthy
 * (the shared env-truthiness predicate); it carries the six GitHub-named
 * variables verbatim — an unset variable stays undefined. When the gate is
 * not truthy the whole block is omitted (the key must not appear at all).
 */
function getGitHubActionsMetadata(): GitHubActionsMetadata | undefined {
  if (!isEnvTruthy(process.env.GITHUB_ACTIONS)) return undefined
  return {
    actor: process.env.GITHUB_ACTOR,
    actorId: process.env.GITHUB_ACTOR_ID,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER,
    repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
  }
}

/**
 * The core user record. Memoized on its single argument — the argument value
 * IS the cache key, so `true`, `false` and no-argument are three independent
 * entries. Synchronous by contract: while the async email resolution is
 * unresolved it reads the OAuth email directly (never blocks). Subscription
 * type and rate-limit tier are read ONLY when `includeAnalyticsMetadata` is
 * true.
 */
export const getCoreUserData = memoize(
  (includeAnalyticsMetadata?: boolean): CoreUserData => {
    const account = getOauthAccountInfo()
    const github = getGitHubActionsMetadata()
    return {
      deviceId: getOrCreateUserID(),
      sessionId: getSessionId(),
      ...(resolvedEmail !== undefined
        ? { email: resolvedEmail }
        : account?.emailAddress
          ? { email: account.emailAddress }
          : {}),
      appVersion: MACRO.VERSION,
      platform: getHostPlatformForAnalytics(),
      ...(account?.organizationUuid ? { organizationUuid: account.organizationUuid } : {}),
      ...(account?.accountUuid ? { accountUuid: account.accountUuid } : {}),
      userType: 'external',
      ...(includeAnalyticsMetadata === true
        ? {
            ...(getSubscriptionType() !== null ? { subscriptionType: getSubscriptionType() as string } : {}),
            ...(getRateLimitTier() !== null ? { rateLimitTier: getRateLimitTier() as string } : {}),
          }
        : {}),
      ...(github !== undefined ? { githubActionsMetadata: github } : {}),
    }
  },
)

/** The feature-gate variant always requests the analytics metadata. */
export function getUserForGrowthBook(): CoreUserData {
  return getCoreUserData(true)
}

/**
 * Resolves the user email once, asynchronously, so synchronous readers
 * never block. The only source is the OAuth account's email address —
 * "OAuth email or nothing"; git-email and internal-address
 * fallbacks are deliberately not part of this resolution. Once it lands,
 * the record memo is cleared so the next read picks the email up.
 */
export async function initUser(): Promise<void> {
  if (emailResolution === null) {
    emailResolution = (async () => {
      resolvedEmail = getOauthAccountInfo()?.emailAddress
      getCoreUserData.cache?.clear?.()
    })()
  }
  await emailResolution
}

/** Called on every auth change (login, logout, account switch) so the next read picks up fresh credentials. */
export function resetUserCache(): void {
  resolvedEmail = undefined
  emailResolution = null
  void resolvedEmail
  getCoreUserData.cache?.clear?.()
  getGitEmail.cache?.clear?.()
}

/**
 * `git config --get user.email` in the state cwd — spawned at most once
 * per process, as a direct argv invocation through the shared git resolver
 * (live consumer: the example commands surface). Trimmed value on success;
 * undefined on a non-zero exit or empty output.
 */
export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  const result = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'user.email'], {
    cwd: getCwd(),
    preserveOutputOnError: false,
  })
  if (result.code !== 0) return undefined
  const trimmed = result.stdout.trim()
  return trimmed !== '' ? trimmed : undefined
})
