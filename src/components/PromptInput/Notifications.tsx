
export function footerNoticeLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' · ')
}

import { basename } from 'node:path'
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { Message } from '../../types/message.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js'
import { useNotifications } from '../../context/notifications.js'
import {
  registerHookEventHandler,
  type HookExecutionEvent,
} from '../../utils/hooks/hookEvents.js'
import {
  getApiKeyHelperElapsedMs,
  getConfiguredApiKeyHelper,
  getSubscriptionType,
} from '../../utils/auth.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { notLoggedInGateDecision, walletEntries, type NotLoggedInGate } from '../../services/wallet/wallet.js'
import { sessionAccountFamily } from '../../utils/accounts/sessionAccount.js'
import { useSignInEpoch } from '../../utils/accounts/useSignInEpoch.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { RowErrorBoundary } from '../RowErrorBoundary.js'
import { IdeStatusIndicator } from '../IdeStatusIndicator.js'
import { TokenWarning } from '../TokenWarning.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js'

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000

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

function NotificationsColumn({
  apiKeyStatus,
  debug,
  verbose,
  messages,
  ideSelection,
  mcpClients,
  isInputWrapped = false,
  alignStart = false,
  compact = false,
}: {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  alignStart?: boolean
  compact?: boolean
}): React.ReactNode {
  void isInputWrapped
  const tokens = useMercuryTokens()
  const { addNotification, removeNotification } = useNotifications()
  const current = useAppState(
    (state: AppState) => state.notifications.current,
  )
  const mainLoopModel = useSyncExternalStore(subscribeFocusedModel, getFocusedModel, getFocusedModel)
  const limits = useClaudeAiLimits()

  const addRef = useRef(addNotification)
  addRef.current = addNotification
  useEffect(() => {
    const handler = (event: HookExecutionEvent): void => {
      if (event.type !== 'response') return
      const text = (event.output || event.stderr || '').trim()
      if (text === '') return
      if (event.outcome === 'error') {
        addRef.current({
          key: 'env-hook',
          text,
          color: 'error',
          priority: 'medium',
          timeoutMs: 8000,
        })
      } else {
        addRef.current({
          key: 'env-hook',
          text,
          priority: 'low',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
        })
      }
    }
    registerHookEventHandler(handler)
    return () => registerHookEventHandler(null)
  }, [])

  const helperConfigured = getConfiguredApiKeyHelper() !== undefined
  const [helperElapsedMs, setHelperElapsedMs] = useState(0)
  useEffect(() => {
    if (!helperConfigured) return
    const timer = setInterval(() => {
      setHelperElapsedMs(getApiKeyHelperElapsedMs())
    }, 1000)
    return () => clearInterval(timer)
  }, [helperConfigured])
  const helperSlow = helperConfigured && helperElapsedMs >= SLOW_HELPER_THRESHOLD_MS

  const plan = getSubscriptionType()
  const overageLine =
    limits.isUsingOverage &&
    plan !== 'team' &&
    plan !== 'enterprise' &&
    current?.key !== 'limit-reached'
  const notAuthenticated =
    apiKeyStatus === 'invalid' || apiKeyStatus === 'missing'
  const signInEpoch = useSignInEpoch()
  const catalogueEpoch = useCatalogueEpoch()
  const walletGate = useMemo((): NotLoggedInGate => {
    if (!notAuthenticated) return { state: 'ok' }
    try {
      return notLoggedInGateDecision(
        walletEntries(),
        sessionAccountFamily(mainLoopModel ?? getMainLoopModel()),
      )
    } catch {
      return { state: 'not-logged-in' }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notAuthenticated, mainLoopModel, signInEpoch, catalogueEpoch])
  const sessionBlocked = walletGate.state !== 'ok'
  const tokenUsage = tokenCountWithEstimation(messages)
  const showTokenCount = verbose && !sessionBlocked && !compact

  const editorConfigured = process.env.VISUAL ?? process.env.EDITOR
  const warningLevel = calculateTokenWarningState(tokenUsage, mainLoopModel ?? '').level
  const editorHintLive =
    isInputWrapped &&
    warningLevel === 'ok' &&
    !sessionBlocked &&
    editorConfigured !== undefined &&
    editorConfigured !== ''
  const editorChord = useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+x ctrl+e')
  const removeRef = useRef(removeNotification)
  removeRef.current = removeNotification
  useEffect(() => {
    if (!editorHintLive) {
      removeRef.current('external-editor-hint')
      return
    }
    const editorName = basename(editorConfigured as string) || 'editor'
    addRef.current({
      key: 'external-editor-hint',
      text: `${editorChord} edits in ${editorName}`,
      priority: 'immediate',
      timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
    })
    return () => removeRef.current('external-editor-hint')
  }, [editorHintLive, editorConfigured, editorChord])

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      alignItems={alignStart ? 'flex-start' : 'flex-end'}
    >
      <FaultInjector />
      <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />
      {overageLine ? (
        <Text dimColor wrap="truncate-end">
          Anthropic says this account is on extra usage
        </Text>
      ) : null}
      {helperSlow ? (
        <Text color={tokens.warning} wrap="truncate-end">
          waiting on apiKeyHelper{' '}
          <Text dimColor>
            ({formatDuration(helperElapsedMs, { mostSignificantOnly: true })})
          </Text>
        </Text>
      ) : null}
      {walletGate.state === 'not-logged-in' ? (
        <Text color={tokens.failure} wrap="truncate-end">
          Not logged in · Run {LOGIN_COMMAND}
        </Text>
      ) : null}
      {walletGate.state === 'provider-missing' ? (
        <Box flexDirection="column" alignItems={alignStart ? 'flex-start' : 'flex-end'}>
          {walletGate.steering.split(' · ').map(segment => (
            <Text key={segment} color={tokens.warning} wrap="truncate-end">
              {segment}
            </Text>
          ))}
        </Box>
      ) : null}
      {debug ? (
        <Text color={tokens.warning} wrap="truncate-end">
          debug mode
        </Text>
      ) : null}
      {showTokenCount ? (
        <Text dimColor wrap="truncate-end">
          {formatNumber(tokenUsage)} tokens
        </Text>
      ) : null}
      <TokenWarning tokenUsage={tokenUsage} model={mainLoopModel ?? ''} />
      <SandboxPromptFooterHint />
      {current !== null ? (
        'jsx' in current ? (
          <Box>{current.jsx}</Box>
        ) : (
          <Text
            color={current.color}
            dimColor={current.color === undefined}
            wrap="truncate-end"
          >
            {footerNoticeLine(current.text)}
          </Text>
        )
      ) : null}
    </Box>
  )
}

export function Notifications(props: {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  alignStart?: boolean
  compact?: boolean
}): React.ReactNode {
  return (
    <RowErrorBoundary>
      <NotificationsColumn {...props} />
    </RowErrorBoundary>
  )
}
