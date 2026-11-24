import { useCallback, useRef, useState } from 'react'
import { useTimer } from '../effects/effects.js'
import { getIsRemoteMode, getIsScrollDraining } from '../../boot/process-state/processState.js'
import { useNotifications } from './notifications.js'
import { Text } from '../themedRenderer.js'
import { GLYPH } from '../theme/glyphs.js'
import {
  getInitializationStatus,
  getLspServerManager,
} from '../../integrations/lsp/serverManagerLifecycle.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { pollUntil } from '../../platform/async/deadline.js'

const POLL_INTERVAL_MS = 5000
const NOTIFICATION_TIMEOUT_MS = 8000

export function useLspFailureNotice(): void {
  const { addNotification } = useNotifications()
  const reportedRef = useRef<Set<string>>(new Set())
  const [shouldPoll, setShouldPoll] = useState(true)

  const reportError = useCallback(
    (source: string, message: string) => {
      const dedupeKey = `${source}\0${message}`
      if (reportedRef.current.has(dedupeKey)) return
      reportedRef.current.add(dedupeKey)
      logForDebugging(`LSP error from ${source}: ${message}`)
      const displaySource = source.startsWith('ext:') ? source.slice(4) : source
      addNotification({
        key: `lsp-error-${source}`,
        priority: 'medium',
        timeoutMs: NOTIFICATION_TIMEOUT_MS,
        jsx: (
          <Text>
            <Text color="error">{GLYPH.fail}</Text>
            {` LSP failed for ${displaySource}`}
            <Text dimColor>{' — /health for details'}</Text>
          </Text>
        ),
      })
    },
    [addNotification],
  )

  const checkForErrors = useCallback((): boolean => {
    if (getIsRemoteMode() || getIsScrollDraining()) return false
    const status = getInitializationStatus()
    if (status.status === 'pending' || status.status === 'not-started') return false
    if (status.status === 'failed') {
      reportError('lsp-manager', status.error.message)
      setShouldPoll(false)
      return true
    }
    const manager = getLspServerManager()
    if (!manager) return false
    for (const [source, server] of manager.getAllServers()) {
      if (server.state === 'error' && server.lastError) {
        reportError(source, server.lastError.message)
      }
    }
    return false
  }, [reportError])

  useTimer(signal => {
    if (!shouldPoll) return
    let skipImmediate = true
    void pollUntil(
      () => {
        if (skipImmediate) {
          skipImmediate = false
          return undefined
        }
        return checkForErrors() ? true : undefined
      },
      POLL_INTERVAL_MS,
      Number.POSITIVE_INFINITY,
      () => undefined,
      { signal, onAbort: () => undefined },
    )
  }, [shouldPoll, checkForErrors])
}
