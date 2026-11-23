export function footerNoticeLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' · ')
}

import { basename } from 'node:path'
import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useClaim, useTimer } from '../../hooks/effects.js'
import { Box, Text } from '../../ink.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import type { Message } from '../../types/message.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { useAnthropicLimits } from '../../services/anthropicLimitsHook.js'
import { useNotifications, type Notification } from '../../context/notifications.js'
import {
  getApiKeyHelperElapsedMs,
  getConfiguredApiKeyHelper,
  getSubscriptionType,
} from '../../utils/auth.js'
import { useFocusedContextFill } from '../../hooks/useDisplayedSessionModel.js'
import { notLoggedInGateDecision, walletEntries, type NotLoggedInGate } from '../../services/wallet/wallet.js'
import { sessionAccountFamily } from '../../services/accounts/sessionAccount.js'
import { useSignInEpoch } from '../../utils/accounts/useSignInEpoch.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import { getEngineModel } from '../../services/model/model.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { RowErrorBoundary } from '../RowErrorBoundary.js'
import { TokenWarning } from '../TokenWarning.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { startInterval, stopInterval } from '../../utils/timers.js'

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000

export function noticeRowText(current: Notification | null): React.ReactNode | null {
  if (current === null) return null
  if ('jsx' in current) {
    return React.isValidElement(current.jsx) && current.jsx.type === Text ? current.jsx : null
  }
  const line = footerNoticeLine(current.text)
  return current.color === undefined ? line : <Text color={current.color}>{line}</Text>
}

export function noticeRowDetail(current: Notification | null): React.ReactNode | null {
  if (current === null || 'jsx' in current || current.detail === undefined) return null
  return current.color === undefined ? current.detail : <Text color={current.color}>{current.detail}</Text>
}

export function noticeRowWayOut(current: Notification | null): React.ReactNode | null {
  if (current === null || 'jsx' in current || current.wayOut === undefined || current.wayOut === '') return null
  return current.color === undefined ? current.wayOut : <Text color={current.color}>{current.wayOut}</Text>
}

export function NoticeWords({ seam, words, wayOut, muted }: { seam: boolean; words: React.ReactNode; wayOut: React.ReactNode | null; muted: string }): React.ReactNode {
  return (
    <Box flexShrink={1} minWidth={0}>
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate-end">
          {seam ? <Text color={muted}> · </Text> : null}
          {words}
        </Text>
      </Box>
      {wayOut !== null ? (
        <Box flexShrink={0} maxWidth="100%">
          <Text dimColor wrap="truncate-end">
            <Text color={muted}> · </Text>
            {wayOut}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

const NOTICE_BLOCK_MAX_ROWS = 3

function noticeBlockChildren(block: React.ReactNode): React.ReactNode[] | null {
  if (!React.isValidElement(block)) return null
  const children = (block.props as { children?: React.ReactNode }).children
  return React.Children.toArray(children)
}

export function noticeRowBlock(current: Notification | null): React.ReactNode | null {
  if (current === null || !('jsx' in current)) return null
  if (!React.isValidElement(current.jsx) || current.jsx.type === Text) return React.isValidElement(current.jsx) ? null : current.jsx
  const rows = noticeBlockChildren(current.jsx)
  if (rows === null || rows.length <= NOTICE_BLOCK_MAX_ROWS) return current.jsx
  return React.cloneElement(current.jsx as React.ReactElement<{ children?: React.ReactNode }>, undefined, ...rows.slice(0, NOTICE_BLOCK_MAX_ROWS - 1), rows[rows.length - 1])
}

export function noticeBlockRows(current: Notification | null): number {
  const block = noticeRowBlock(current)
  if (block === null) return 0
  const rows = noticeBlockChildren(block)
  return rows === null ? 1 : Math.min(NOTICE_BLOCK_MAX_ROWS, Math.max(1, rows.length))
}

const SLOW_HELPER_THRESHOLD_MS = 10_000

const LOGIN_COMMAND = '/logins'

const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedModel = (): string => getFocusedSessionConnector().modelFacts().effective

function FaultInjector(): React.ReactNode {
  if (flagEnv('MERCURY_RENDER_FAULT') === 'message') {
    throw new Error('MERCURY_RENDER_FAULT: injected notifications fault')
  }
  return null
}

const EXTRA_USAGE_TEXT = 'Anthropic says this account is on extra usage'

type NotificationsProps = {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  alignStart?: boolean
  compact?: boolean
}

function NotificationsColumn({
  apiKeyStatus,
  debug,
  verbose,
  messages,
  isInputWrapped = false,
  alignStart = false,
  compact = false,
}: NotificationsProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const focusedModel = useSyncExternalStore(
    subscribeFocusedModel,
    getFocusedModel,
    getFocusedModel,
  )
  const model = focusedModel !== '' ? focusedModel : getEngineModel()
  const limits = useAnthropicLimits()
  const currentNotification = useAppState(
    (s: AppState) => s.notifications.current,
  )
  const { addNotification, removeNotification } = useNotifications()

  const hasKeyHelper = getConfiguredApiKeyHelper() !== undefined
  const [helperElapsedMs, setHelperElapsedMs] = useState<number>(() =>
    hasKeyHelper ? getApiKeyHelperElapsedMs() : 0,
  )
  useTimer(() => {
    if (!hasKeyHelper) {
      setHelperElapsedMs(0)
      return
    }
    setHelperElapsedMs(getApiKeyHelperElapsedMs())
    const timer = startInterval(() => {
      setHelperElapsedMs(getApiKeyHelperElapsedMs())
    }, 1000)
    return () => {
      stopInterval(timer)
    }
  }, [hasKeyHelper])
  const showSlowHelper =
    hasKeyHelper && helperElapsedMs >= SLOW_HELPER_THRESHOLD_MS

  const subscriptionType = getSubscriptionType()
  const showExtraUsage =
    limits.isUsingOverage &&
    subscriptionType !== 'team' &&
    subscriptionType !== 'enterprise' &&
    currentNotification?.key !== 'limit-reached'

  const signInEpoch = useSignInEpoch()
  const catalogueEpoch = useCatalogueEpoch()
  const accountGate = useMemo<NotLoggedInGate>(() => {
    if (apiKeyStatus !== 'invalid' && apiKeyStatus !== 'missing') {
      return { state: 'ok' }
    }
    try {
      return notLoggedInGateDecision(
        walletEntries(),
        sessionAccountFamily(model),
      )
    } catch {
      return { state: 'not-logged-in' }
    }
  }, [apiKeyStatus, model, signInEpoch, catalogueEpoch])
  const accountBlocked = accountGate.state !== 'ok'

  const fill = useFocusedContextFill(messages, model)
  const tokenUsage = fill.usedTokens ?? 0
  const tokenWarning = calculateTokenWarningState(tokenUsage, model)

  const editorChord = useShortcutDisplay(
    'chat:externalEditor',
    'Chat',
    'ctrl+x ctrl+e',
  )
  const env = hostEnv()
  const rawEditor = env.VISUAL || env.EDITOR || ''
  const trimmedEditor = rawEditor.trim()
  const editorBin = trimmedEditor.split(/\s+/)[0] ?? ''
  const editorName = editorBin !== '' ? basename(editorBin) || 'editor' : 'editor'
  const shouldShowEditorHint =
    isInputWrapped &&
    tokenWarning.level === 'ok' &&
    !accountBlocked &&
    trimmedEditor !== ''

  const noticeOpsRef = useRef({ addNotification, removeNotification })
  noticeOpsRef.current = { addNotification, removeNotification }

  useClaim(() => {
    if (shouldShowEditorHint) {
      noticeOpsRef.current.addNotification({
        key: 'external-editor-hint',
        text: `${editorChord} edits in ${editorName}`,
        priority: 'immediate',
        timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
      })
    } else {
      noticeOpsRef.current.removeNotification('external-editor-hint')
    }
    return () => {
      noticeOpsRef.current.removeNotification('external-editor-hint')
    }
  }, [shouldShowEditorHint, editorChord, editorName])

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      alignItems={alignStart ? 'flex-start' : 'flex-end'}
      overflow="hidden"
    >
      <FaultInjector />
      {showExtraUsage ? (
        <Text dimColor wrap="truncate-end">
          {EXTRA_USAGE_TEXT}
        </Text>
      ) : null}
      {showSlowHelper ? (
        <Text color={tokens.warning} wrap="truncate-end">
          {'waiting on credentials.keyCommand '}
          <Text dimColor>
            ({formatDuration(helperElapsedMs, { mostSignificantOnly: true })})
          </Text>
        </Text>
      ) : null}
      {accountGate.state === 'not-logged-in' ? (
        <Text color={tokens.failureText} wrap="truncate-end">
          Not logged in · Run {LOGIN_COMMAND}
        </Text>
      ) : accountGate.state === 'provider-missing' ? (
        accountGate.steering.split(' · ').map((segment, index) => (
          <Text key={index} color={tokens.warning} wrap="truncate-end">
            {segment}
          </Text>
        ))
      ) : null}
      {debug ? (
        <Text color={tokens.warning} wrap="truncate-end">
          debug mode
        </Text>
      ) : null}
      {verbose && !accountBlocked && !compact ? (
        <Text dimColor wrap="truncate-end">
          {formatNumber(tokenUsage)} tokens
        </Text>
      ) : null}
      <TokenWarning tokenUsage={tokenUsage} model={model} />
    </Box>
  )
}

export function Notifications(props: NotificationsProps): React.ReactNode {
  return (
    <RowErrorBoundary>
      <NotificationsColumn {...props} />
    </RowErrorBoundary>
  )
}
