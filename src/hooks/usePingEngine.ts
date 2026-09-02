import { useEffect } from 'react'
import {
  cachedAttentionView,
  subscribeAttentionView,
} from '../services/attention/viewModel.js'
import { BEL } from '../ink/termio/ansi.js'
import { termWrite } from '../render-engine/cockpit/terminalOut.js'
import { tapTerminalBell } from '../services/pings/bellTap.js'
import { createPingEngine, pingSliceOf } from '../services/pings/pingEngine.js'
import { pingsBellEnabled } from '../services/pings/pingsGate.js'
import '../services/crew/obligationsBridge.js'
import '../services/workbench/attentionBridge.js'

export function usePingEngine(): void {
  useEffect(() => {
    const engine = createPingEngine({
      ringBell: () => tapTerminalBell(() => termWrite(process.stdout, BEL, 'bell')),
      bellEnabled: pingsBellEnabled,
    })
    const observe = (): void => {
      engine.observe(pingSliceOf(cachedAttentionView().attention))
    }
    observe()
    return subscribeAttentionView(observe)
  }, [])
}
