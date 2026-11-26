import * as React from 'react'
import { useSyncExternalStore } from 'react'
import type { MeasuredHost } from '../overlays/PopupHost.js'
import { useFocusedWorkspaceCwd } from '../focused-session/useFocusedWorkspaceCwd.js'
import { useElevatedSurface } from '../widgets/useElevatedSurface.js'
import { closeFilesMenu, filesMenuVersion, isFilesMenuOpen, subscribeFilesMenu } from '../cockpit/filesMenu.js'
import { insertAtComposerCaret } from '../composer/composerInsert.js'
import { FILES_MENU_CHROME_ROWS, FILES_MENU_WIDTH, MercuryFilesMenu } from './MercuryFilesMenu.js'
import { PopupGutter, popupGeometry } from '../overlays/PopupGutter.js'

const FILES_MENU_INSET_ROWS = 4

type FilesMenuGeometry = { left: number; top: number; width: number; rowBudget: number }

function filesMenuGeometry(cols: number, rows: number): FilesMenuGeometry {
  const spare = rows - FILES_MENU_CHROME_ROWS
  const roomy = spare - 2 * FILES_MENU_INSET_ROWS
  const geometry = popupGeometry({ left: 0, top: 0, columns: cols, rows }, { width: FILES_MENU_WIDTH, rows: FILES_MENU_CHROME_ROWS + Math.max(0, roomy >= 1 ? roomy : spare - 2) }, FILES_MENU_INSET_ROWS)
  return { left: geometry.left, top: geometry.top, width: geometry.width, rowBudget: Math.max(0, geometry.rows - FILES_MENU_CHROME_ROWS) }
}

export function FilesMenuSlot({ host }: { host: MeasuredHost | null }): React.ReactNode {
  useSyncExternalStore(subscribeFilesMenu, filesMenuVersion, filesMenuVersion)
  const open = isFilesMenuOpen()
  const root = useFocusedWorkspaceCwd()
  const elevatedRef = useElevatedSurface()
  if (!open || !host) return null
  const geometry = filesMenuGeometry(host.columns, host.rows)
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
