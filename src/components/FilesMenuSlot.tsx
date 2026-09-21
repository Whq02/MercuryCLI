import * as React from 'react'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { getOriginalCwd } from '../bootstrap/state.js'
import { Box, measureElement, type DOMElement } from '../ink.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { closeFilesMenu, filesMenuVersion, isFilesMenuOpen, subscribeFilesMenu } from '../utils/cockpit/filesMenu.js'
import { insertAtComposerCaret } from './PromptInput/composerInsert.js'
import { FILES_MENU_CHROME_ROWS, FILES_MENU_WIDTH, MercuryFilesMenu } from './MercuryFilesMenu.js'

export const FILES_MENU_INSET_ROWS = 4

export type FilesMenuGeometry = { left: number; top: number; width: number; rowBudget: number }

export function filesMenuGeometry(cols: number, rows: number): FilesMenuGeometry {
  const width = Math.min(FILES_MENU_WIDTH, Math.max(12, cols))
  const left = Math.max(0, Math.floor((cols - width) / 2))
  const spare = rows - FILES_MENU_CHROME_ROWS
  const roomy = spare - 2 * FILES_MENU_INSET_ROWS
  const rowBudget = Math.max(1, roomy >= 1 ? roomy : spare)
  const top = Math.max(0, Math.min(FILES_MENU_INSET_ROWS, spare - rowBudget))
  return { left, top, width, rowBudget }
}

export function FilesMenuSlot({ hostRef, framed }: { hostRef: React.RefObject<DOMElement | null>; framed: boolean }): React.ReactNode {
  useSyncExternalStore(subscribeFilesMenu, filesMenuVersion, filesMenuVersion)
  const open = isFilesMenuOpen()
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
    <Box ref={elevatedRef} position="absolute" top={geometry.top} left={geometry.left} width={geometry.width} flexDirection="column" flexShrink={0}>
      <MercuryFilesMenu
        root={getOriginalCwd()}
        width={geometry.width}
        rowBudget={geometry.rowBudget}
        onClose={closeFilesMenu}
        onPick={path => {
          closeFilesMenu()
          insertAtComposerCaret(`@${path} `)
        }}
      />
    </Box>
  )
}
