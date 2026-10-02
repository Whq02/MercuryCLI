
import { createContext, useContext, useEffect, useRef } from 'react'
import { noteModeAcquired, noteModeReleased } from './root/terminalModeLedger.js'
import { isProgressReportingAvailable } from './session/capabilities.js'
import { ITERM2, osc, OSC, PROGRESS, wrapForMultiplexer } from './termio/osc.js'

export type TerminalWrite = (data: string) => void

export const TerminalWriteContext = createContext<TerminalWrite | null>(null)
export const TerminalWriteProvider = TerminalWriteContext.Provider


export type TabRing = {
  hold(token: symbol, live: boolean): void
  release(token: symbol): void
  ringing(): boolean
}

export function createTabRing(write: TerminalWrite, available: () => boolean): TabRing {
  const holders = new Set<symbol>()
  let ringing = false
  const emit = (state: number): void => {
    write(wrapForMultiplexer(osc(OSC.ITERM2, ITERM2.PROGRESS, state, 0)))
  }
  const settle = (): void => {
    const live = holders.size > 0
    if (live === ringing) return
    if (live) {
      if (!available()) return
      ringing = true
      emit(PROGRESS.INDETERMINATE)
      noteModeAcquired('tab-ring', 'progress-ring')
    } else {
      ringing = false
      emit(PROGRESS.CLEAR)
      noteModeReleased('tab-ring', 'progress-ring')
    }
  }
  return {
    hold(token, live) {
      if (live) holders.add(token)
      else holders.delete(token)
      settle()
    },
    release(token) {
      holders.delete(token)
      settle()
    },
    ringing: () => ringing,
  }
}

let processRing: TabRing | null = null
let processRingWrite: TerminalWrite | null = null
function ringOver(write: TerminalWrite): TabRing {
  if (processRing === null || processRingWrite !== write) {
    processRing = createTabRing(write, () => isProgressReportingAvailable())
    processRingWrite = write
  }
  return processRing
}

export function useTabRing(live: boolean): void {
  const write = useContext(TerminalWriteContext)
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('tab-ring-holder')
  const token = tokenRef.current
  useEffect(() => {
    if (write === null) return
    ringOver(write).hold(token, live)
  }, [write, live, token])
  useEffect(
    () => () => {
      if (write !== null) ringOver(write).release(token)
    },
    [write, token],
  )
}
