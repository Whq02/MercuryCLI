import { useClaim } from './effects.js'

import { getFocusedSessionConnector } from '../services/engine-connector/focusedConnector.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { watchProviderUsageWhileShown } from '../services/providers/providerUsage.js'

export function useProviderUsageOnShow(shown: boolean, model?: string): void {
  useClaim(() => {
    if (!shown) return
    return watchProviderUsageWhileShown({
      family: () => declaredRouteOf(model ?? getFocusedSessionConnector().modelFacts().main) ?? 'unrecognised',
    })
  }, [shown, model])
}
