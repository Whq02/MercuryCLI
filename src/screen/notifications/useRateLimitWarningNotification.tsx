
import { useRef, useSyncExternalStore } from 'react'
import { usePublish } from '../effects/effects.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { GLYPH } from '../theme/glyphs.js'
import { useNowTick } from '../widgets/components.js'
import { useNotifications } from './notifications.js'
import { Text } from '../themedRenderer.js'
import { useSessionConnector } from '../focused-session/useSessionConnector.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../models/roads/anthropic/anthropicLimits.js'
import { useAnthropicLimits } from '../composer/anthropicLimitsHook.js'
import { preferSessionLimitWarning, providerLimitWarning, takeUsageWarning, usageWarningEmissionKey } from '../../models/roads/limitWarning.js'
import { getOpenaiObservedVersion, subscribeOpenaiObserved } from '../../models/roads/openai/openaiLimitState.js'
import { getUsingOverageText } from '../../models/roads/anthropic/rateLimitMessages.js'
import { getSubscriptionType } from '../../models/sign-in/credentials/auth.js'
import { hasConsoleBillingAccess } from '../../models/usage/billing.js'

const OVERAGE_KEY = 'limit-reached'
const WARNING_KEY = 'rate-limit-warning'

const ENGINE_FEEDER_REREAD_MS = 15_000

export function useRateLimitWarningNotification(model: string): void {
  const { addNotification } = useNotifications()
  const limits = useAnthropicLimits()
  const tick = useNowTick(ENGINE_FEEDER_REREAD_MS)
  const connector = useSessionConnector()
  const usageRecordVersion = useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const openaiObservedVersion = useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)
  const overageShownRef = useRef(false)
  const warningKeysRef = useRef(new Set<string>())

  usePublish(() => {
    if (getIsRemoteMode()) return
    if (!limits?.isUsingOverage) {
      overageShownRef.current = false
      return
    }
    if (overageShownRef.current) return
    const subscriptionType = getSubscriptionType()
    const isOrgAccount =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    if (isOrgAccount && !hasConsoleBillingAccess()) return
    overageShownRef.current = true
    addNotification({
      key: OVERAGE_KEY,
      text: getUsingOverageText(limits),
      priority: 'immediate',
    })
  }, [limits, addNotification])

  usePublish(() => {
    if (getIsRemoteMode()) return
    const warning = preferSessionLimitWarning(
      connector.usage().limitWarning,
      providerLimitWarning({
        model,
        reads: { anthropicLimits: () => limits },
      }),
    )
    if (warning === null || !takeUsageWarning(warningKeysRef.current, warning)) return
    addNotification({
      key: `${WARNING_KEY}|${usageWarningEmissionKey(warning)}`,
      priority: 'high',
      jsx: (
        <Text color="warning">
          {GLYPH.warn} {warning.text}
        </Text>
      ),
    })
  }, [limits, model, tick, connector, addNotification, usageRecordVersion, openaiObservedVersion])
}
