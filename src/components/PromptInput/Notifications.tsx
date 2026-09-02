// The one-line notice column. Order is the contract: IDE status,
// the standing overage line, the slow API-key-helper line, the
// not-authenticated line, debug, the verbose token count, the token
// warning, the sandbox hint, and LAST the current transient — in
// fullscreen this column is seen through a one-row bottom-anchored window,
// so the lowest row is the row the operator sees; a standing row below the
// transient would hide every receipt the composer emits.

/** ONE ROW is the transient's contract:
 *  wrap="truncate-end" truncates per LINE and does not collapse newlines,
 *  so a hook's multi-line stdout painted N footer rows and shoved the
 *  transcript above it. Every newline run folds to the house ' · ' seam
 *  and the one truncate-end row sheds the tail honestly. Pure and
 *  exported — prove-size-honesty drives it. */
export function footerNoticeLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join(' · ')
}

import { basename } from 'node:path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, measureElement } from '../../ink.js'
import type { DOMElement } from '../../ink/dom.js'
import { publishNotificationRows } from './notificationRowsMirror.js'
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
import { useSignInEpoch } from '../../utils/accounts/useSignInEpoch.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { SentryErrorBoundary } from '../SentryErrorBoundary.js'
import { IdeStatusIndicator } from '../IdeStatusIndicator.js'
import { TokenWarning } from '../TokenWarning.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js'

/** The shared transient-toast duration. */
export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000

/** Helper line appears only once the helper has run at least this long. */
const SLOW_HELPER_THRESHOLD_MS = 10_000

/** Contract data: the login command the not-authenticated line names. */
const LOGIN_COMMAND = '/logins'

function FaultInjector(): React.ReactNode {
  // The crash-surface prover needs a REAL render error to walk the genuine
  // recovery path. Unset costs exactly one environment read.
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
}: {
  apiKeyStatus: VerificationStatus
  debug: boolean
  verbose: boolean
  messages: Message[]
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
  isInputWrapped?: boolean
  /** Left-align the column: the narrow stacked footer AND the fullscreen
   *  cockpit, where the operator's whole stack is left-anchored — a
   *  right-floating notice reads as detached from the composer it
   *  belongs to. The inline two-column footer keeps its right column. */
  alignStart?: boolean
}): React.ReactNode {
  void isInputWrapped
  const tokens = useMercuryTokens()
  const { addNotification, removeNotification } = useNotifications()
  const current = useAppState(
    (state: AppState) => state.notifications.current,
  )
  // The column's rendered height is a fact other surfaces budget against
  // (the `?` grid beneath it): measured after every paint, published to the
  // mirror, zeroed on unmount.
  const columnRef = useRef<DOMElement | null>(null)
  useEffect(() => {
    const element = columnRef.current
    if (!element) return
    try {
      publishNotificationRows(measureElement(element).height)
    } catch {
      /* an unmeasurable node reads as no rows */
    }
  })
  useEffect(() => () => publishNotificationRows(0), [])
  const mainLoopModel = useAppState((state: AppState) => state.mainLoopModel)
  const limits = useClaudeAiLimits()

  // ── environment-hook notifier (uninstalled on unmount) ───────────────────
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

  // ── slow API-key helper (1 Hz poll, only when configured) ────────────────
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

  // ── standing rows ────────────────────────────────────────────────────────
  const plan = getSubscriptionType()
  const overageLine =
    limits.isUsingOverage &&
    plan !== 'team' &&
    plan !== 'enterprise' &&
    current?.key !== 'limit-reached'
  const notAuthenticated =
    apiKeyStatus === 'invalid' || apiKeyStatus === 'missing'
  // Wallet-aware gate: "logged in" is
  // no longer "Anthropic logged in". With NO provider connected the full
  // refusal fires; with another provider connected the row depends on the
  // SESSION MODEL's provider — missing ⇒ a provider-specific steering line
  // (/model uses the connected provider, /logins adds the missing one);
  // connected ⇒ no row at all. Memoized: the wallet enumeration reads the
  // filesystem, and it only matters while the Anthropic state is broken.
  // Keyed on the sign-in epoch too: a credential landing or leaving in this
  // process (a chat's /logins, a board sign-out) re-derives the row at once
  // — before it, the "No <family> account" steering stood until a NEW
  // session re-mounted the composer.
  const signInEpoch = useSignInEpoch()
  const walletGate = useMemo((): NotLoggedInGate => {
    if (!notAuthenticated) return { state: 'ok' }
    try {
      return notLoggedInGateDecision(
        walletEntries(),
        // Resolve absence FIRST (the session's actual default), then
        // classify — never classify no-model-at-all onto a lane.
        declaredRouteOf(mainLoopModel ?? getMainLoopModel()),
      )
    } catch {
      // An enumeration failure falls back to the pre-wallet behaviour: the
      // Anthropic-state refusal (never a silently-suppressed warning).
      return { state: 'not-logged-in' }
    }
    // signInEpoch is the re-derive key (the reads inside are live owners).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notAuthenticated, mainLoopModel, signInEpoch])
  // The session is BLOCKED only when its model's provider has no account —
  // the cosmetic rows (token count, editor hint) key on this, not on the
  // Anthropic-only state (an OpenAI session runs fine without Claude).
  const sessionBlocked = walletGate.state !== 'ok'
  // The trigger's own count (the tail after the last usage included), so
  // the warning ladder and the compaction decision never disagree.
  const tokenUsage = tokenCountWithEstimation(messages)
  const showTokenCount = verbose && !sessionBlocked

  // ── external-editor hint: input wrapped, warning at its lowest, key ok,
  // editor configured — removed the moment any leg stops holding. ─────────
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
      ref={columnRef}
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
        // Width policy: the ~100-char steering line splits at its ' · '
        // seams — one fact/action per row — so no terminal width can cut a
        // command name mid-word or shed the actionable tail (truncate-end
        // dropped '/logins adds …' entirely at 80 columns).
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
}): React.ReactNode {
  // The whole column degrades to a one-line fallback on a render crash; the
  // crash report is kept and the session continues.
  return (
    <SentryErrorBoundary>
      <NotificationsColumn {...props} />
    </SentryErrorBoundary>
  )
}
