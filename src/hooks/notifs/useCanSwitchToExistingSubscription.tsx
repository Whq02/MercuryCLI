// Startup notice: the account has a Claude subscription this session is not
// signed into. Capped at three lifetime showings via the persisted
// `subscriptionNoticeCount` config counter.

import * as React from 'react'
import { Text } from '../../ink.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getOauthProfileFromApiKey } from '../../services/oauth/getOauthProfile.js'
import { useStartupNotification } from './useStartupNotification.js'

const NOTICE_KEY = 'switch-to-subscription'
const MAX_LIFETIME_SHOWINGS = 3

export function useCanSwitchToExistingSubscription(): void {
  useStartupNotification(async () => {
    const config = getGlobalConfig()
    if ((config.subscriptionNoticeCount ?? 0) >= MAX_LIFETIME_SHOWINGS) {
      return null
    }
    // Already signed in as a subscriber — nothing to offer.
    if (getSubscriptionType() !== null) return null

    const profile = await getOauthProfileFromApiKey()
    const tier = profile?.account?.has_claude_max
      ? 'Max'
      : profile?.account?.has_claude_pro
        ? 'Pro'
        : null
    if (!tier) return null

    // Increment the persisted counter before returning the notice, so a
    // session that dies mid-render still consumed one showing.
    saveGlobalConfig(current => ({
      ...current,
      subscriptionNoticeCount: (current.subscriptionNoticeCount ?? 0) + 1,
    }))
    return {
      key: NOTICE_KEY,
      priority: 'low',
      jsx: (
        <Text>
          <Text color="suggestion">
            You have a Claude {tier} plan — it can be used with Mercury.
          </Text>
          <Text dimColor> Run /logins to switch to it.</Text>
        </Text>
      ),
    }
  })
}
