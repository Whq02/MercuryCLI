import { noteOpenaiSourceIdentity, openaiLimitWindow, type OpenaiLimitSource, type OpenaiLimitWindow } from './openaiLimitState.js'
import { openaiSourceIdentity, resolveOpenaiAccount } from './openaiAccounts.js'

export type OpenaiWindowFact = { source: OpenaiLimitSource; resetsAtMs: number; observedAtMs: number }

export interface OpenaiWindowReads {
  activeSource: () => OpenaiLimitSource | undefined
  window: (source: OpenaiLimitSource) => OpenaiLimitWindow
}

function liveOpenaiWindowReads(): OpenaiWindowReads {
  return {
    activeSource: () => {
      const active = resolveOpenaiAccount()
      if (active === undefined) return undefined
      noteOpenaiSourceIdentity(active.kind, openaiSourceIdentity(active.kind))
      return active.kind
    },
    window: source => openaiLimitWindow(source),
  }
}

export function activeOpenaiWindow(reads: OpenaiWindowReads = liveOpenaiWindowReads()): OpenaiLimitWindow {
  const source = reads.activeSource()
  return source === undefined ? { state: 'clear' } : reads.window(source)
}

export function openaiWindowFact(reads: OpenaiWindowReads = liveOpenaiWindowReads()): OpenaiWindowFact | undefined {
  const source = reads.activeSource()
  if (source === undefined) return undefined
  const window = reads.window(source)
  return window.state === 'limited' ? { source, resetsAtMs: window.resetsAtMs, observedAtMs: window.observedAtMs } : undefined
}
