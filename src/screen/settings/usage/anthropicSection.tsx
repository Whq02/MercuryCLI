import React, { useCallback, useRef, useState } from 'react'
import { useClaim, useLoad } from '../../effects/effects.js'
import { Box, Text } from '../../themedRenderer.js'
import { useKeybinding } from '../../keys/useKeybinding.js'
import type { Utilization } from '../../../models/usage/anthropicUsageFetch.js'
import { isClaudeAISubscriber } from '../../../models/sign-in/credentials/auth.js'
import { anthropicPoolWindowViews, anthropicWindowViews, providerUsageView, refreshProviderUsage, usageForProvider } from '../../../models/roads/providerUsage.js'
import { ConfigurableShortcutHint } from '../../keys/ConfigurableShortcutHint.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { useUsageLayout, humanizeUsageError, SlotHeading, IdentityLine, SlotSpend, absentSlotLine, ApiKeySlot, FullWindowLine, ObservedWindowMeter } from './lines.js'

const askedOpens = new Set<number>()
export function markOpenAsked(token: number): boolean {
  if (askedOpens.has(token)) return false
  askedOpens.add(token)
  if (askedOpens.size > 64) {
    const oldest = askedOpens.values().next().value
    if (oldest !== undefined) askedOpens.delete(oldest)
  }
  return true
}

export function AnthropicUsageSection({ width, openToken }: { width?: number; openToken?: number }): React.ReactNode {
  useUsageLayout()
  const tokens = useMercuryTokens()
  const subscriber = isClaudeAISubscriber()
  const [state, setState] = useState<{
    loading: boolean
    error: unknown
    data: Utilization | null
  }>({ loading: subscriber, error: null, data: null })

  const disposedRef = useRef(false)
  useClaim(() => () => {
    disposedRef.current = true
  }, [])

  const settle = useCallback((): void => {
    if (disposedRef.current) return
    const note = usageForProvider('anthropic').readerNote
    setState(note !== undefined ? { loading: false, error: note, data: null } : { loading: false, error: null, data: {} })
  }, [])
  const load = useCallback((): void => {
    if (!subscriber) return
    setState(previous => ({ ...previous, loading: true, error: null }))
    void refreshProviderUsage('anthropic', { reason: 'operator' }).then(settle)
  }, [subscriber, settle])
  useLoad(() => {
    if (!subscriber) return
    if (openToken !== undefined && !markOpenAsked(openToken)) {
      void refreshProviderUsage('anthropic', { reason: 'open' }).then(settle)
      return
    }
    load()
  }, [load, subscriber, openToken, settle])

  const showingError = !state.loading && state.error !== null
  useKeybinding(
    'settings:retry',
    () => {
      load()
    },
    { context: 'Settings', isActive: showingError },
  )

  const anthropicSection = ((): React.ReactNode => {
    if (!subscriber) {
      return <Text dimColor>{absentSlotLine('/logins anthropic connects a subscription account')}</Text>
    }
    if (state.loading) {
      return <Text dimColor>loading usage…</Text>
    }
    if (showingError) {
      const readerWords = typeof state.error === 'string' ? state.error : (humanizeUsageError(state.error) ?? '')
      const raw = state.error instanceof Error ? state.error.message : ''
      const isWait = usageForProvider('anthropic').readerWait === true
      return (
        <Box flexDirection="column">
          <Text color={isWait ? tokens.warning : tokens.failure}>
            {readerWords !== '' ? readerWords : `Failed to load usage${raw !== '' ? `: ${raw}` : ''}`}
          </Text>
          <Text dimColor>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            {' · '}
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="esc"
              description="cancel"
            />
          </Text>
        </Box>
      )
    }

    const ownerWindows = anthropicWindowViews().filter(w => w.state === 'live')
    const fiveHourView = ownerWindows.find(w => w.key === '5h')
    const sevenDayView = ownerWindows.find(w => w.key === '7d')
    const poolViews = anthropicPoolWindowViews().filter(w => w.state === 'live')
    const hasAnyLimit = ownerWindows.length > 0 || poolViews.length > 0
    if (!hasAnyLimit) {
      return (
        <Text dimColor>
          Usage limits are only available on subscription plans.
        </Text>
      )
    }
    return (
      <Box flexDirection="column">
        {fiveHourView !== undefined ? (
          <ObservedWindowMeter window={fiveHourView} title="Current session" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {sevenDayView !== undefined ? (
          <ObservedWindowMeter window={sevenDayView} title="Current week (all models)" {...(width !== undefined ? { maxWidth: width } : {})} />
        ) : null}
        {poolViews.map(w => (
          <ObservedWindowMeter key={w.key} window={w} title={`Current week (${w.label})`} {...(width !== undefined ? { maxWidth: width } : {})} />
        ))}
        <FullWindowLine usage={usageForProvider('anthropic')} />
      </Box>
    )
  })()

  const view = providerUsageView('anthropic')
  const keyEntry = view.entries.find(e => e.kind === 'api-key')
  const owner = usageForProvider('anthropic')
  return (
    <Box flexDirection="column">
      <Text bold>Anthropic usage</Text>
      <IdentityLine family="anthropic" />
      <Box flexDirection="column" marginTop={1}>
        <SlotHeading text="Subscription" />
        {anthropicSection}
        {subscriber ? <SlotSpend active={view.activeEntry?.kind === 'subscription-oauth'} route="anthropic" spend={view.sessionSpend} withCost={false} /> : null}
      </Box>
      <ApiKeySlot
        presentLabel={keyEntry?.label}
        isActive={view.activeEntry?.kind === 'api-key'}
        route="anthropic"
        spend={view.sessionSpend}
        {...(owner.absence !== undefined ? { note: owner.absence } : {})}
      />
    </Box>
  )
}
