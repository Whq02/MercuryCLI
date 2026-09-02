// Polls LSP manager/server health and notifies once per distinct
// (source, message); the extensions health owner reads the manager's live
// states itself. Polling starts enabled
// unconditionally; a manager-init failure records once and stops the poll.
// The per-commit extra poll is harmless because the dedupe set carries the
// real once-per-condition guarantee.

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getIsRemoteMode, getIsScrollDraining } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  getInitializationStatus,
  getLspServerManager,
} from '../../services/lsp/manager.js'
import { logForDebugging } from '../../utils/debug.js'

const POLL_INTERVAL_MS = 5000
const NOTIFICATION_TIMEOUT_MS = 8000

export function useLspInitializationNotification(): void {
  const { addNotification } = useNotifications()
  const [pollingEnabled, setPollingEnabled] = useState(true)
  const seenRef = useRef(new Set<string>())

  const recordError = useCallback(
    (source: string, message: string): void => {
      const seenKey = `${source}\x00${message}`
      if (seenRef.current.has(seenKey)) return
      seenRef.current.add(seenKey)
      logForDebugging(`LSP error from ${source}: ${message}`)
      const displaySource = source.startsWith('ext:')
        ? source.slice('ext:'.length)
        : source
      addNotification({
        key: `lsp-error-${source}`,
        priority: 'medium',
        timeoutMs: NOTIFICATION_TIMEOUT_MS,
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text> LSP failed for{' '}
            {displaySource}
            <Text dimColor> — /health for details</Text>
          </Text>
        ),
      })
    },
    [addNotification],
  )

  const poll = useCallback((): void => {
    if (getIsRemoteMode()) return
    if (getIsScrollDraining()) return
    const initialization = getInitializationStatus()
    if (initialization.status === 'failed') {
      recordError('lsp-manager', String(initialization.error))
      setPollingEnabled(false)
      return
    }
    if (
      initialization.status === 'pending' ||
      initialization.status === 'not-started'
    ) {
      return
    }
    const manager = getLspServerManager()
    if (!manager) return
    for (const [name, server] of manager.getAllServers()) {
      if (server.state === 'error' && server.lastError) {
        recordError(name, String(server.lastError))
      }
    }
  }, [recordError])

  useEffect(() => {
    if (!pollingEnabled) return
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [pollingEnabled, poll])
  // The interval is the whole polling contract (L4): no per-commit poll.
}
