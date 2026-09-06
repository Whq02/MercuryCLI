
import memoize from 'lodash-es/memoize.js'

import { getSessionId } from '../bootstrap/state.js'
import { getOauthAccountInfo, getRateLimitTier, getSubscriptionType } from './auth.js'
import { getCwd } from './cwd.js'
import { getHostPlatformForAnalytics } from './env.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'


export type CoreUserData = {
  sessionId: string
  email?: string
  appVersion: string
  platform: string
  organizationUuid?: string
  accountUuid?: string
  userType: 'external'
  subscriptionType?: string
  rateLimitTier?: string
}

let resolvedEmail: string | undefined
let emailResolution: Promise<void> | null = null

export const getCoreUserData = memoize(
  (includeAnalyticsMetadata?: boolean): CoreUserData => {
    const account = getOauthAccountInfo()
    return {
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
    }
  },
)

export function getUserForGrowthBook(): CoreUserData {
  return getCoreUserData(true)
}

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
