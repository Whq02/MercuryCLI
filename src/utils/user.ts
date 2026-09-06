
import memoize from 'lodash-es/memoize.js'

import { getSessionId } from '../bootstrap/state.js'
import { getOauthAccountInfo, getRateLimitTier, getSubscriptionType } from './auth.js'
import { getOrCreateUserID } from './config.js'
import { getCwd } from './cwd.js'
import { getHostPlatformForAnalytics } from './env.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'


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
  userType: 'external'
  subscriptionType?: string
  rateLimitTier?: string
  githubActionsMetadata?: GitHubActionsMetadata
}

let resolvedEmail: string | undefined
let emailResolution: Promise<void> | null = null

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

export async function initUser(): Promise<void> {
  if (emailResolution === null) {
    emailResolution = (async () => {
      resolvedEmail = getOauthAccountInfo()?.emailAddress
      getCoreUserData.cache?.clear?.()
    })()
  }
  await emailResolution
}

export function resetUserCache(): void {
  resolvedEmail = undefined
  emailResolution = null
  void resolvedEmail
  getCoreUserData.cache?.clear?.()
  getGitEmail.cache?.clear?.()
}

export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  const result = await execFileNoThrowWithCwd(gitExe(), ['config', '--get', 'user.email'], {
    cwd: getCwd(),
    preserveOutputOnError: false,
  })
  if (result.code !== 0) return undefined
  const trimmed = result.stdout.trim()
  return trimmed !== '' ? trimmed : undefined
})
