export type LaneWindowFamily = 'gemini' | 'openrouter'

export type LaneLimitWindow = { state: 'limited'; resetsAtMs: number; observedAtMs: number } | { state: 'clear' }

export type LaneWindowFact = { resetsAtMs: number; observedAtMs: number }

export interface LaneWindowReads {
  credentialed: () => boolean
  window: () => LaneLimitWindow
}

const LIVE_READS: Record<LaneWindowFamily, () => LaneWindowReads> = {
  gemini: () => ({
    credentialed: () => {
      const { resolveGeminiAccount } = require('./gemini/geminiAccounts.js') as typeof import('./gemini/geminiAccounts.js')
      return resolveGeminiAccount() !== undefined
    },
    window: () => {
      const { geminiLimitWindow } = require('./gemini/geminiUsageState.js') as typeof import('./gemini/geminiUsageState.js')
      return geminiLimitWindow()
    },
  }),
  openrouter: () => ({
    credentialed: () => {
      const { resolveOpenrouterApiKey } = require('./openrouter/openrouterAccounts.js') as typeof import('./openrouter/openrouterAccounts.js')
      return resolveOpenrouterApiKey() !== undefined
    },
    window: () => {
      const { openrouterLimitWindow } = require('./openrouter/openrouterUsageState.js') as typeof import('./openrouter/openrouterUsageState.js')
      return openrouterLimitWindow()
    },
  }),
}

export function isLaneWindowFamily(family: string | null | undefined): family is LaneWindowFamily {
  return typeof family === 'string' && Object.prototype.hasOwnProperty.call(LIVE_READS, family)
}

export function activeLaneWindow(family: LaneWindowFamily, reads: LaneWindowReads = LIVE_READS[family]()): LaneLimitWindow {
  return reads.credentialed() ? reads.window() : { state: 'clear' }
}

export function laneWindowFact(family: LaneWindowFamily, reads: LaneWindowReads = LIVE_READS[family]()): LaneWindowFact | undefined {
  const window = activeLaneWindow(family, reads)
  return window.state === 'limited' ? { resetsAtMs: window.resetsAtMs, observedAtMs: window.observedAtMs } : undefined
}

export function laneWindowClosedUntil(fact: { resetsAtMs?: unknown } | undefined, nowMs: number): number | undefined {
  if (fact === undefined || typeof fact.resetsAtMs !== 'number' || !Number.isFinite(fact.resetsAtMs)) return undefined
  return fact.resetsAtMs > nowMs ? fact.resetsAtMs : undefined
}
