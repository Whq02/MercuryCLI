import { useClaim } from '../effects/effects.js'

import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { declaredRouteOf } from '../../models/roads/callModelRouter.js'
import { watchProviderUsageWhileShown } from '../../models/roads/providerUsage.js'

export function useProviderUsageOnShow(shown: boolean, model?: string): void {
  useClaim(() => {
    if (!shown) return
    return watchProviderUsageWhileShown({
      family: () => declaredRouteOf(model ?? getFocusedSessionConnector().modelFacts().main) ?? 'unrecognised',
    })
  }, [shown, model])
}
