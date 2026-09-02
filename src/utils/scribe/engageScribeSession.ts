import {
  type ScribePinSnapshot,
  decideScribeRestore,
  decideScribeSessionModel,
} from './scribeModelPin.js'

export type ScribeSessionStore = {
  getState: () => {
    mainLoopModel?: string | null
    mainLoopModelForSession?: string | null
    effortValue?: string | number | undefined
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setState: (updater: (prev: any) => any) => void
}

let sessionStash: ScribePinSnapshot | null = null

export function __resetScribeSessionStash(): void {
  sessionStash = null
}

export function engageScribeSession(store: ScribeSessionStore): void {
  
  if (sessionStash !== null) return
  const st = store.getState()
  const current: ScribePinSnapshot = {
    model: st.mainLoopModelForSession ?? st.mainLoopModel ?? null,
    effort: st.effortValue as ScribePinSnapshot['effort'],
  }
  const decision = decideScribeSessionModel(current)
  if (!decision) return
  sessionStash = decision.snapshot
  store.setState(prev => ({
    ...prev,
    mainLoopModelForSession: decision.next.model,
    effortValue: decision.next.effort,
  }))
}

export function disengageScribeSession(store: ScribeSessionStore): void {
  
  const st = store.getState()
  const currentModel = st.mainLoopModelForSession ?? st.mainLoopModel ?? null
  const currentEffort = st.effortValue as ScribePinSnapshot['effort']
  const restore = decideScribeRestore(sessionStash, currentModel, currentEffort)
  sessionStash = null
  if (!restore) return
  store.setState(prev => ({
    ...prev,
    mainLoopModelForSession: restore.model,
    effortValue: restore.effort,
  }))
}

export function isScribeSessionPinned(): boolean {
  return sessionStash !== null
}
