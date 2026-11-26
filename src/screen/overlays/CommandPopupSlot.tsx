import * as React from 'react'
import { useClaim } from '../effects/effects.js'
import type { MeasuredHost } from './PopupHost.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { ModalContext } from './modalContext.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { holdCommandPopup, releaseCommandPopup, type CommandPopupShape } from '../cockpit/commandPopup.js'
import { POPUP_GUTTER, PopupGutter, popupCover, type PopupBounds, popupGeometry } from './PopupGutter.js'

type CommandPopupGeometry = { left: number; top: number; width: number; rows: number }

export function commandPopupGeometry(host: PopupBounds, terminalRows: number, shape: CommandPopupShape): CommandPopupGeometry {
  const width = shape.width(host.columns)
  const rows = Math.max(0, Math.min(shape.rows(terminalRows), host.rows - 2 * POPUP_GUTTER))
  return popupGeometry(host, { width, rows })
}

export function CommandPopupLease({ token, children }: { token: number; children: React.ReactNode }): React.ReactNode {
  useClaim(() => {
    holdCommandPopup(token)
    return () => releaseCommandPopup(token)
  }, [token])
  return <>{children}</>
}

export function CommandPopupSlot({
  host,
  scrollRef,
  shape,
  children,
}: {
  host: MeasuredHost | null
  scrollRef: React.RefObject<ScrollBoxHandle | null> | null
  shape: CommandPopupShape
  children: React.ReactNode
}): React.ReactNode {
  const { rows: terminalRows } = useTerminalSize()
  if (!host) return null
  const geometry = commandPopupGeometry(host, terminalRows, shape)
  return (
    <PopupGutter {...geometry} cover={popupCover(host, geometry, host.band)}>
      <ModalContext.Provider value={{ rows: geometry.rows, columns: geometry.width, scrollRef }}>
        {children}
      </ModalContext.Provider>
    </PopupGutter>
  )
}
