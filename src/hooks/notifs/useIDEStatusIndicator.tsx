// IDE connection/installation status notices plus the capped "an IDE is
// available" hint. The hint appears at most five times per installation
// (persisted `ideHintShownCount`), never while an IDE is connected, never on
// a terminal that is itself a known IDE terminal.

import * as React from 'react'
import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  findAvailableIDE,
  isJetBrainsIde,
  isSupportedTerminal,
  type IDEExtensionInstallationStatus,
} from '../../utils/ide.js'
import { useIdeConnectionStatus } from '../useIdeConnectionStatus.js'
import type { IDESelection } from '../useIdeSelection.js'

const HINT_KEY = 'ide-status-hint'
const DISCONNECTED_KEY = 'ide-status-disconnected'
const JETBRAINS_KEY = 'ide-status-jetbrains-disconnected'
const INSTALL_ERROR_KEY = 'ide-status-install-error'

const HINT_MAX_SHOWINGS = 5
const HINT_DELAY_MS = 3000

type Props = {
  ideInstallationStatus: IDEExtensionInstallationStatus | null | undefined
  ideSelection: IDESelection | null | undefined
  mcpClients: MCPServerConnection[]
}

export function useIDEStatusIndicator({
  ideInstallationStatus,
  ideSelection,
  mcpClients,
}: Props): void {
  const { addNotification, removeNotification } = useNotifications()
  const { status, ideName } = useIdeConnectionStatus(mcpClients)
  const hintShownThisSessionRef = useRef(false)

  const connected = status === 'connected'
  const jetBrains = isJetBrainsIde(ideName ?? null)
  const installError = Boolean(ideInstallationStatus?.error)

  const selectionShowable =
    connected &&
    Boolean(
      ideSelection &&
        (ideSelection.filePath ||
          (ideSelection.text && (ideSelection.lineCount ?? 0) > 0)),
    )
  const connectedShowable = connected && !selectionShowable
  const installErrorShowable =
    installError && !jetBrains && !connectedShowable && !selectionShowable
  const jetBrainsInfoShowable =
    jetBrains && !connectedShowable && !selectionShowable

  // The hint.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (isSupportedTerminal() || ideInstallationStatus || jetBrainsInfoShowable) {
      removeNotification(HINT_KEY)
      return
    }
    if (hintShownThisSessionRef.current) return
    if ((getGlobalConfig().ideHintShownCount ?? 0) >= HINT_MAX_SHOWINGS) return
    const timer = setTimeout(() => {
      // The detection continuation is not cancellable; the session guard is
      // re-checked inside it instead.
      void (async () => {
        const ide = await findAvailableIDE()
        if (!ide || hintShownThisSessionRef.current) return
        hintShownThisSessionRef.current = true
        saveGlobalConfig(current => ({
          ...current,
          ideHintShownCount: (current.ideHintShownCount ?? 0) + 1,
        }))
        addNotification({
          key: HINT_KEY,
          priority: 'low',
          jsx: (
            <Text dimColor>
              Run <Text color="ide">/ide</Text> to connect to {ide.name}.
            </Text>
          ),
        })
      })()
    }, HINT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [
    ideInstallationStatus,
    jetBrainsInfoShowable,
    addNotification,
    removeNotification,
  ])

  // Disconnected.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (
      installErrorShowable ||
      jetBrainsInfoShowable ||
      status !== 'disconnected' ||
      !ideName
    ) {
      removeNotification(DISCONNECTED_KEY)
      return
    }
    addNotification({
      key: DISCONNECTED_KEY,
      text: `${ideName} disconnected`,
      color: 'error',
      priority: 'medium',
    })
  }, [
    installErrorShowable,
    jetBrainsInfoShowable,
    status,
    ideName,
    addNotification,
    removeNotification,
  ])

  // JetBrains plugin not connected.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (!jetBrainsInfoShowable) {
      removeNotification(JETBRAINS_KEY)
      return
    }
    addNotification({
      key: JETBRAINS_KEY,
      text: 'IDE plugin not connected — /status for details',
      priority: 'medium',
    })
  }, [jetBrainsInfoShowable, addNotification, removeNotification])

  // Extension install error.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (!installErrorShowable) {
      removeNotification(INSTALL_ERROR_KEY)
      return
    }
    addNotification({
      key: INSTALL_ERROR_KEY,
      text: 'IDE extension install failed — /status for details',
      color: 'error',
      priority: 'medium',
    })
  }, [installErrorShowable, addNotification, removeNotification])
}
