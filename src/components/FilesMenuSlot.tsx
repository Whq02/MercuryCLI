import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { measureElement, type DOMElement } from '../ink.js'
import { useFocusedWorkspaceCwd } from '../hooks/useFocusedWorkspaceCwd.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { closeFilesMenu, filesMenuVersion, isFilesMenuOpen, subscribeFilesMenu } from '../utils/cockpit/filesMenu.js'
import { insertAtComposerCaret } from './PromptInput/composerInsert.js'
import { FILES_MENU_CHROME_ROWS, FILES_MENU_WIDTH, MercuryFilesMenu } from './MercuryFilesMenu.js'
import { PopupGutter, popupGeometry } from './PopupGutter.js'

export const FILES_MENU_INSET_ROWS = 4

export type FilesMenuGeometry = { left: number; top: number; width: number; rowBudget: number }

export function filesMenuGeometry(cols: number, rows: number): FilesMenuGeometry {
  const spare = rows - FILES_MENU_CHROME_ROWS
  const roomy = spare - 2 * FILES_MENU_INSET_ROWS
  const geometry = popupGeometry({ left: 0, top: 0, columns: cols, rows }, { width: FILES_MENU_WIDTH, rows: FILES_MENU_CHROME_ROWS + Math.max(0, roomy >= 1 ? roomy : spare - 2) }, FILES_MENU_INSET_ROWS)
  return { left: geometry.left, top: geometry.top, width: geometry.width, rowBudget: Math.max(0, geometry.rows - FILES_MENU_CHROME_ROWS) }
}

export function FilesMenuSlot({ hostRef, framed }: { hostRef: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeFilesMenu, filesMenuVersion, filesMenuVersion)
  const open = isFilesMenuOpen()
  const root = useFocusedWorkspaceCwd()
  const elevatedRef = useElevatedSurface()
  const [host, setHost] = useState<{ columns: number; rows: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const element = hostRef.current
    if (!element) return
    const measured = measureElement(element)
    if (measured.width <= 0 || measured.height <= 0) return
    if (host === null || host.columns !== measured.width || host.rows !== measured.height) {
      setHost({ columns: measured.width, rows: measured.height })
    }
  })
  if (!open || host === null) return null
  const inset = framed ? 1 : 0
  const geometry = filesMenuGeometry(host.columns - 2 * inset, host.rows - 2 * inset)
  return (
    <PopupGutter contentRef={elevatedRef} {...geometry} rows={geometry.rowBudget + FILES_MENU_CHROME_ROWS}>
      <MercuryFilesMenu
        key={root}
        root={root}
        width={geometry.width}
        rowBudget={geometry.rowBudget}
        onClose={closeFilesMenu}
        onPick={path => {
          closeFilesMenu()
          insertAtComposerCaret(`@${path} `)
        }}
      />
    </PopupGutter>
  )
}
