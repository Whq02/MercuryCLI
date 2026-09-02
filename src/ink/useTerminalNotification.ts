// Terminal notifications and progress: five stable callbacks closing over
// the raw-write function the instance supplies through context.

import { createContext, useCallback, useContext, useMemo } from 'react'
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

  // Deliberately NOT wrapped: inside a multiplexer the raw byte triggers the
  // multiplexer's own bell action, and wrapping would lose that fallback.
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
