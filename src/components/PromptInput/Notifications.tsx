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
import { notBuilt } from '../../pi/holes.js'

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

export function Notifications(props: {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  alignStart?: boolean
  compact?: boolean
}): React.ReactNode {
  return notBuilt('src/components/PromptInput/Notifications.tsx:262')
}
