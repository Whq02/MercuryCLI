import React, { createContext, Suspense, useCallback, useContext, useMemo, useState } from 'react'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import { useNotifications, type Notification } from '../../context/notifications.js'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { Message } from '../../types/message.js'
import { closeSettingsPopup, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'
import { estateGroundBg } from '../../utils/mercuryTokens.js'
import { createCommandInputMessage, createUserMessage } from '../../utils/messages.js'
import { formatCommandLoadingMetadata } from '../../utils/processUserInput/processSlashCommand.js'
import { cutToWidth } from '../MercuryFilesMenu.js'
import { ProductLockup } from '../mercury-ui/components.js'
import { useElevatedSurface } from '../mercury-ui/useElevatedSurface.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import type { SettingsPopupPlacement } from '../SettingsPopupSlot.js'

export type SettingsTabName = 'Status' | 'Config' | 'Usage'

let settingsOpens = 0
export function nextSettingsOpen(): number {
  settingsOpens += 1
  return settingsOpens
}

export type SettingsPopupFrame = {
  close: (summary?: string) => void
  setLine: (line: string | null) => void
  setOwnsEscape: (owns: boolean) => void
}

const SettingsPopupFrameContext = createContext<SettingsPopupFrame | null>(null)

export function useSettingsPopupFrame(): SettingsPopupFrame {
  const frame = useContext(SettingsPopupFrameContext)
  if (frame === null) throw new Error('useSettingsPopupFrame must be used inside the settings popup')
  return frame
}

const RECEIPT_TIMEOUT_MS = 8000

type PaintsRows = { addDisplayRow?: (row: Message) => void }

export function settingsPopupReceipt(
  view: string,
  summary: string,
  addNotification: (notification: Notification) => void,
  focused: PaintsRows = getFocusedSessionConnector() as PaintsRows,
): 'rows' | 'notification' | 'none' {
  const lines = summary.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines.length === 0) return 'none'
  if (lines.length > 1) {
    if (typeof focused.addDisplayRow === 'function') {
      focused.addDisplayRow(createUserMessage({ content: formatCommandLoadingMetadata(view, '') }))
      focused.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${summary}</${LOCAL_COMMAND_STDOUT_TAG}>`))
      return 'rows'
    }
    addNotification({ key: `command-${view}`, text: summary, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS })
    return 'notification'
  }
  addNotification({ key: `command-${view}`, text: summary, priority: 'immediate' })
  return 'notification'
}

export function Settings({
  request,
  geometry,
}: {
  request: SettingsPopupRequest
  geometry: SettingsPopupPlacement
}): React.ReactNode {
  const tok = useMercuryTokens()
  const token = useRegisterOverlay('settings')
  const surfaceRef = useElevatedSurface()
  const { addNotification } = useNotifications()
  const [line, setLine] = useState<string | null>(null)
  const [bodyOwnsEscape, setOwnsEscape] = useState(false)
  const view = request.view
  const close = useCallback(
    (summary?: string): void => {
      closeSettingsPopup()
      if (summary !== undefined) settingsPopupReceipt(view, summary, addNotification)
    },
    [view, addNotification],
  )
  const frame = useMemo<SettingsPopupFrame>(() => ({ close, setLine, setOwnsEscape }), [close])
  useKeybinding(
    'confirm:no',
    () => {
      if (token !== null && !isTopOverlayNow(token)) return false
      close()
    },
    { context: 'Settings', isActive: !bodyOwnsEscape },
  )
  useExitOnCtrlCD(useKeybindings)
  const ground = estateGroundBg(tok)
  const inner = geometry.inner
  const fixed = geometry.rows !== null
  return (
    <Box
      ref={surfaceRef}
      flexDirection="column"
      width={geometry.width}
      {...(fixed ? { height: geometry.rows as number } : {})}
      flexShrink={0}
      borderStyle="round"
      borderColor={tok.borderStrong}
      paddingX={1}
      opaque={true}
      {...(ground !== undefined ? { backgroundColor: ground } : {})}
    >
      <ProductLockup view={view} separator=" · " />
      <Box height={1}>
        <Text color={tok.textMuted} wrap="truncate-end">{cutToWidth(line ?? request.line, inner)}</Text>
      </Box>
      <Box height={1} />
      <Box flexDirection="column" width={inner + 2} marginLeft={-1} marginRight={-1} paddingX={1} flexShrink={0} overflow="hidden" {...(fixed ? { flexGrow: 1, minHeight: 0 } : { maxHeight: geometry.rowBudget })}>
        <SettingsPopupFrameContext.Provider value={frame}>
          <Suspense fallback={null}>{request.body(geometry)}</Suspense>
        </SettingsPopupFrameContext.Provider>
      </Box>
      <Box height={1} />
      <Box height={1} width={inner + 1} marginRight={-1}>
        <Text color={tok.textMuted}>{cutToWidth(request.hint, inner + 1)}</Text>
      </Box>
    </Box>
  )
}
