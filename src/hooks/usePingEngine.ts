// ============================================================================
//  usePingEngine — the VISIBLE process's pings tap.
//
//  Mounts the one ping engine over the attention view: every snapshot folds
//  through the engine (seed-silent at arm; ring once per new needs-you
//  subject / finished-run event; taps within a second ring once — the
//  engine's whole policy lives in services/pings/pingEngine.ts). The bell
//  is the BEL byte through the frame writer's own emission door (termWrite
//  kind 'bell' — the one-door FIFO frames ride), never an OS notifier and
//  never a network. The /pings setting is read live at tap time, so the
//  toggle acts on the very next event without a repaint of anything.
//
//  Workers are headless and never mount this hook — the tap belongs to the
//  one visible process (the useObligationSignals law).
// ============================================================================
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
// The owner-family gatherers the engine watches register at module scope —
// a consumer must IMPORT them or the store holds only its built-in queue
// gatherer (the WORK-panel retirement orphaned these imports and the
// attention view went blind to obligations and run manifests).
import '../services/crew/obligationsBridge.js'
import '../services/workbench/attentionBridge.js'

export function usePingEngine(): void {
  useEffect(() => {
    const engine = createPingEngine({
      // Through the ONE bell tap: the notifier's terminal_bell floor rings
      // there too, so one event never beeps twice across the two writers.
      ringBell: () => tapTerminalBell(() => termWrite(process.stdout, BEL, 'bell')),
      bellEnabled: pingsBellEnabled,
    })
    const observe = (): void => {
      engine.observe(pingSliceOf(cachedAttentionView().attention))
    }
    // The seed: what already stands arms silently (the badge and the board
    // carry it); only events from here on tap.
    observe()
    return subscribeAttentionView(observe)
  }, [])
}
