
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { noteModeAcquired, noteModeReleased } from './root/terminalModeLedger.js'
import { isProgressReportingAvailable, type Progress } from './session/capabilities.js'
import { BEL } from './termio/ansi.js'
import { ITERM2, osc, OSC, PROGRESS, wrapForMultiplexer } from './termio/osc.js'

export type TerminalWrite = (data: string) => void

export const TerminalWriteContext = createContext<TerminalWrite | null>(null)
export const TerminalWriteProvider = TerminalWriteContext.Provider

export type TerminalNotification = {
  notifyITerm2: (options: { message: string; title?: string }) => void
  notifyKitty: (options: { message: string; title: string; id: number }) => void
  notifyGhostty: (options: { message: string; title: string }) => void
  notifyBell: () => void
  progress: (state: Progress['state'] | null, percentage?: number) => void
}

export function useTerminalNotification(): TerminalNotification {
  const write = useContext(TerminalWriteContext)
  if (!write) {
    throw new Error(
      'useTerminalNotification must be used within a TerminalWriteProvider',
    )
  }

  const notifyITerm2 = useCallback(
    ({ message, title }: { message: string; title?: string }) => {
      const text = title ? `${title}:\n${message}` : message
      write(wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${text}`)))
    },
    [write],
  )

  const notifyKitty = useCallback(
    ({ message, title, id }: { message: string; title: string; id: number }) => {
      write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)))
      write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:p=body`, message)))
      write(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=1:a=focus`, '')))
    },
    [write],
  )

  const notifyGhostty = useCallback(
    ({ message, title }: { message: string; title: string }) => {
      write(wrapForMultiplexer(osc(OSC.GHOSTTY, 'notify', title, message)))
    },
    [write],
  )

  const notifyBell = useCallback(() => {
    write(BEL)
  }, [write])

  const progress = useCallback(
    (state: Progress['state'] | null, percentage?: number) => {
      if (!isProgressReportingAvailable()) return
      const emit = (sequence: string) => write(wrapForMultiplexer(sequence))
      if (state === null) {
        emit(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''))
        return
      }
      const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)))
      switch (state) {
        case 'completed':
          emit(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''))
          return
        case 'error':
          emit(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.ERROR, pct))
          return
        case 'indeterminate':
          emit(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.INDETERMINATE, ''))
          return
        case 'running':
          emit(osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.SET, pct))
          return
      }
    },
    [write],
  )

  return useMemo(
    () => ({ notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress }),
    [notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress],
  )
}


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
