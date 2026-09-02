
import * as React from 'react'
import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { useSessionConnector } from '../useSessionConnector.js'
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js'
import { preferSessionLimitWarning, providerLimitWarning } from '../../services/providers/limitWarning.js'
import { getUsingOverageText } from '../../services/rateLimitMessages.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasConsoleBillingAccess } from '../../utils/billing.js'

const OVERAGE_KEY = 'limit-reached'
const WARNING_KEY = 'rate-limit-warning'

const ENGINE_FEEDER_REREAD_MS = 15_000

export function useRateLimitWarningNotification(model: string): void {
  const { addNotification } = useNotifications()
  const limits = useClaudeAiLimits()
  const tick = useNowTick(ENGINE_FEEDER_REREAD_MS)
  const connector = useSessionConnector()
  const overageShownRef = useRef(false)
  const lastWarningRef = useRef<string | null>(null)

  useEffect(() => {
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

  useEffect(() => {
    if (getIsRemoteMode()) return
    const warning = preferSessionLimitWarning(
      connector.usage().limitWarning,
      providerLimitWarning({
        model,
        reads: { anthropicLimits: () => limits },
      }),
    )
    if (warning === null || warning.text === lastWarningRef.current) return
    lastWarningRef.current = warning.text
    addNotification({
      key: WARNING_KEY,
      priority: 'high',
      jsx: (
        <Text color="warning">
          {GLYPH.warn} {warning.text}
        </Text>
      ),
    })
  }, [limits, model, tick, connector, addNotification])
}
