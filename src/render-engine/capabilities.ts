// ============================================================================
//  render-engine/capabilities.ts — the paint profile, probed ONCE (spec 03).
//
//  Synchronized output (DEC private mode 2026) is negotiated exactly once at
//  attach: one DECRQM query through the door, one bounded wait for the
//  DECRPM reply. A reply naming the mode supported (set or reset) arms the
//  per-frame bracket; silence, "not recognized", or a profile that withholds
//  the probe leaves it off — and an unarmed engine writes ZERO 2026 bytes,
//  ever. The Apple-Terminal capability class withholds the probe entirely:
//  that terminal family consumes the DECRQM form as garbage on screen, so
//  the query itself is the hazard there. Dumb pipes (no TTY) never probe.
// ============================================================================

import type { EngineClock, EngineProfile } from './contracts.js'
import type { WriteDoor } from './door.js'

/** CSI ? 2026 $ p — DECRQM for synchronized output. */
export const SYNC_PROBE = '\x1b[?2026$p'

const DECRPM_2026 = /\x1b\[\?2026;(\d+)\$y/

export interface ProbePolicy {
  /** False for capability classes whose parsers eat the DECRQM form (the
   *  Apple-Terminal class) and for dumb pipes — the probe is never sent. */
  readonly probeAllowed: boolean
  /** Reply budget before the engine settles on OFF. */
  readonly budgetMs: number
}

export const APPLE_TERMINAL_CLASS_POLICY: ProbePolicy = {
  probeAllowed: false,
  budgetMs: 0,
}

export const MODERN_PROBE_POLICY: ProbePolicy = {
  probeAllowed: true,
  budgetMs: 250,
}

/**
 * Negotiate the profile once. `replyFeed` registers a listener on the
 * terminal's input bytes (the host owns stdin routing); the probe resolves
 * on the first DECRPM 2026 reply or when the budget lapses. The decision is
 * FINAL for the engine's lifetime — nothing re-probes mid-session.
 */
export function probeProfile(
  door: WriteDoor,
  policy: ProbePolicy,
  replyFeed: (listener: (chunk: string) => void) => () => void,
  clock: EngineClock,
): Promise<EngineProfile> {
  if (!policy.probeAllowed) {
    return Promise.resolve({
      syncOutput: false,
      syncWhy: 'profile withholds the probe (Apple-Terminal capability class or non-TTY)',
    })
  }
  return new Promise(resolve => {
    let settled = false
    const finish = (profile: EngineProfile, unhook: () => void, timer: unknown): void => {
      if (settled) return
      settled = true
      unhook()
      if (timer !== null) clock.clearTimeout(timer)
      resolve(profile)
    }
    let carry = ''
    let timer: unknown = null
    const unhook = replyFeed(chunk => {
      carry = (carry + chunk).slice(-256)
      const m = DECRPM_2026.exec(carry)
      if (!m) return
      const state = m[1]
      const supported = state === '1' || state === '2'
      finish(
        supported
          ? { syncOutput: true, syncWhy: 'DECRQM 2026 probe reply' }
          : { syncOutput: false, syncWhy: `DECRPM answered mode-state ${state} (not supported)` },
        unhook,
        timer,
      )
    })
    timer = clock.setTimeout(() => {
      finish({ syncOutput: false, syncWhy: 'DECRQM 2026 probe went unanswered' }, unhook, null)
    }, policy.budgetMs)
    door.enqueue({ kind: 'probe', bytes: SYNC_PROBE })
  })
}
