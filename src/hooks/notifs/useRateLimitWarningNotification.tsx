// Rate-limit warning + overage-in-use notice. The warning half is the
// provider-breadth owner's line (services/providers/limitWarning): it fires
// for WHICHEVER provider the session runs on, from that provider's own
// signals, in the one ruled grammar — the Anthropic subscription meters,
// the OpenAI observed bands, the OpenRouter credit cap, the Kimi managed
// windows; a lane serving no usage signal warns never (capability
// honesty). This hook only decides WHEN to show the line. Unlike the
// deprecation notice, the warning latch is never cleared, so the same
// warning text will not re-notify later in the session. The overage-in-use
// notice stays the Anthropic account's own (subscription/billing gated).
//
// THE FOCUSED SESSION'S OWN FACT FIRST: on a daemon-hosted chat the runner
// observes the wire (the header states, the x-codex bands, the probe
// refreshes its dispatch fires) and answers its own line inside
// session_facts (UsageFactsV1.limitWarning); this process's stores see
// only the /usage mount and the boot probe. The precedence is the owner's
// (preferSessionLimitWarning): a runner fact wins, else this derivation.

import * as React from 'react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { useNowTick } from '../../components/mercury-ui/components.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { useSessionConnector } from '../useSessionConnector.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../services/claudeAiLimits.js'
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js'
import { preferSessionLimitWarning, providerLimitWarning } from '../../services/providers/limitWarning.js'
import { getOpenaiObservedVersion, subscribeOpenaiObserved } from '../../services/providers/openai/openaiLimitState.js'
import { getUsingOverageText } from '../../services/rateLimitMessages.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasConsoleBillingAccess } from '../../utils/billing.js'

const OVERAGE_KEY = 'limit-reached'
const WARNING_KEY = 'rate-limit-warning'

/** The engine feeders are last-observed records (per-response headers, the
 *  polled credit cap), not events — a slow tick re-reads them so a window
 *  crossing the threshold mid-session reaches the strip without a repaint
 *  from elsewhere. The anthropic feeder stays event-driven via the limits
 *  subscription. */
const ENGINE_FEEDER_REREAD_MS = 15_000

export function useRateLimitWarningNotification(model: string): void {
  const { addNotification } = useNotifications()
  const limits = useClaudeAiLimits()
  const tick = useNowTick(ENGINE_FEEDER_REREAD_MS)
  const connector = useSessionConnector()
  // The usage RECORDS' own change signals: the anthropic record's version
  // (a fold of the subscription usage endpoint lands the per-model pools —
  // a Fable seat's binding window — with no latch change and no repaint),
  // and the OpenAI lane's observed version (the bands a facts read adopts).
  // Without them the warning waited for the slow tick or a repaint from
  // elsewhere, and a capture on a slow runner found the strip empty beside
  // a rail that already showed the pool at 87%.
  const usageRecordVersion = useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const openaiObservedVersion = useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)
  const overageShownRef = useRef(false)
  const lastWarningRef = useRef<string | null>(null)

  // Overage in use.
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

  // The approaching-limit warning for the current model's provider: the
  // focused session's own fact (its runner's usage readout, republished at
  // turn cadence and re-read on the engine tick) ahead of this process's
  // derivation.
  useEffect(() => {
    if (getIsRemoteMode()) return
    const warning = preferSessionLimitWarning(
      connector.usage().limitWarning,
      providerLimitWarning({
        model,
        // The subscription-render copy of the limits record (this hook's own
        // reactive read), so the effect and the derivation see one truth.
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
  }, [limits, model, tick, connector, addNotification, usageRecordVersion, openaiObservedVersion])
}
