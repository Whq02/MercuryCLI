
import { useCallback, useRef, useState } from 'react'
import { useTimer } from '../effects.js'
import { getIsRemoteMode, getIsScrollDraining } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { Text } from '../../ink.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  getInitializationStatus,
  getLspServerManager,
} from '../../services/lsp/manager.js'
import { logForDebugging } from '../../utils/debug.js'
import { pollUntil } from '../../utils/deadline.js'

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

  const poll = useCallback((): boolean => {
    if (getIsRemoteMode()) return false
    if (getIsScrollDraining()) return false
    const initialization = getInitializationStatus()
    if (initialization.status === 'failed') {
      recordError('lsp-manager', String(initialization.error))
      setPollingEnabled(false)
      return true
    }
    if (
      initialization.status === 'pending' ||
      initialization.status === 'not-started'
    ) {
      return false
    }
    const manager = getLspServerManager()
    if (!manager) return false
    for (const [name, server] of manager.getAllServers()) {
      if (server.state === 'error' && server.lastError) {
        recordError(name, String(server.lastError))
      }
    }
    return false
  }, [recordError])

  useTimer(() => {
    if (!pollingEnabled) return
    const controller = new AbortController()
    let firstLook = true
    void pollUntil(
      () => {
        if (firstLook) {
          firstLook = false
          return undefined
        }
        return poll() ? true : undefined
      },
      POLL_INTERVAL_MS,
      Infinity,
      () => undefined,
      { signal: controller.signal, onAbort: () => undefined },
    )
    return () => controller.abort()
  }, [pollingEnabled, poll])
}
