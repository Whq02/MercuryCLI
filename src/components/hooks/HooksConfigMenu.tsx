import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { HOOK_EVENTS, type HookEvent } from '../../utils/hooks/contract.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { listHooks, type HookRow } from '../../utils/hooks/hooksSettings.js'
import {
  eventHasMatch,
  groupHooksByEventAndMatch,
  hookEventCards,
  hooksForMatch,
  sortedMatchesForEvent,
} from '../../utils/hooks/hooksConfigManager.js'
import { hooksDisabled, managedHooksOnly } from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import { toTildePath } from '../../utils/path.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { SelectEventMode } from './SelectEventMode.js'
import { SelectMatcherMode } from './SelectMatcherMode.js'
import { SelectHookMode } from './SelectHookMode.js'
import { ViewHookMode } from './ViewHookMode.js'

type Mode =
  | { id: 'select-event' }
  | { id: 'select-match'; event: HookEvent }
  | { id: 'select-hook'; event: HookEvent; match: string }
  | { id: 'view-hook'; event: HookEvent; match: string; hook: HookRow }

function readPolicyAnswers(): { policyDisablesAll: boolean; managedOnly: boolean } {
  return {
    policyDisablesAll: getSettingsForSource('policySettings')?.events?.disabled === true,
    managedOnly: managedHooksOnly(),
  }
}

export function HooksConfigMenu({
  toolNames,
  onExit,
}: {
  toolNames: string[]
  onExit: LocalJSXCommandOnDone
}): React.ReactNode {
  const appState = useAppState(state => state)
  const [mode, setMode] = useState<Mode>({ id: 'select-event' })

  const disabled = hooksDisabled()
  const policy = readPolicyAnswers()
  const allHooks = useMemo(() => listHooks(appState), [appState])
  const totalCount = allHooks.length
  const mcpToolNames = useMemo(() => appState.mcp.tools.map(t => t.name), [appState.mcp.tools])
  const availableToolNames = useMemo(
    () => [...toolNames, ...mcpToolNames],
    [toolNames, mcpToolNames],
  )
  const cards = useMemo(() => hookEventCards(availableToolNames), [availableToolNames])
  const grouped = useMemo(() => groupHooksByEventAndMatch(appState), [appState])
  const moments = useMemo(
    () => Object.fromEntries(HOOK_EVENTS.map(event => [event, cards[event].moment])),
    [cards],
  )
  const countsByEvent = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const event of HOOK_EVENTS) {
      counts[event] = Object.values(grouped[event] ?? {}).reduce(
        (sum, rows) => sum + rows.length,
        0,
      )
    }
    return counts
  }, [grouped])

  const close = (): void => {
    onExit(undefined, { display: 'skip' })
  }

  if (disabled) {
    const disabledSuffix = policy.policyDisablesAll ? ' by a managed settings file' : ''
    const countSentence =
      totalCount > 0
        ? ` ${totalCount} configured ${plural(totalCount, 'hook')} ${totalCount === 1 ? 'is' : 'are'} not running.`
        : ''
    return (
      <Dialog title="Hooks" subtitle="disabled" onCancel={close}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Hooks are disabled{disabledSuffix}.{countSentence}
          </Text>
          <Box flexDirection="column">
            <Text dimColor>· No hook runs.</Text>
            <Text dimColor>· Every moment proceeds without a hook&apos;s word.</Text>
          </Box>
          {!policy.policyDisablesAll ? (
            <Text dimColor>
              Remove events.disabled from settings.json (or ask Mercury) to re-enable them.
            </Text>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  if (mode.id === 'select-event') {
    const userSettingsPath = getSettingsFilePathForSource('userSettings')
    const blockedPaths = [
      ...(userSettingsPath ? [toTildePath(userSettingsPath)] : []),
      getRelativeSettingsFilePathForSource('projectSettings'),
      getRelativeSettingsFilePathForSource('localSettings'),
    ]
    return (
      <Box flexDirection="column">
        {policy.managedOnly ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="warning">Only hooks from managed settings can run right now.</Text>
            <Text dimColor>Blocked: {blockedPaths.join(', ')}</Text>
          </Box>
        ) : null}
        <SelectEventMode
          events={HOOK_EVENTS}
          moments={moments}
          countsByEvent={countsByEvent}
          totalCount={totalCount}
          onSelect={event => {
            if (eventHasMatch(event)) {
              setMode({ id: 'select-match', event })
            } else {
              setMode({ id: 'select-hook', event, match: '' })
            }
          }}
          onExit={close}
        />
      </Box>
    )
  }

  if (mode.id === 'select-match') {
    const matches = sortedMatchesForEvent(grouped, mode.event)
    return (
      <SelectMatcherMode
        event={mode.event}
        card={cards[mode.event]}
        matches={matches}
        hooksByMatch={grouped[mode.event] ?? {}}
        onSelect={match => setMode({ id: 'select-hook', event: mode.event, match })}
        onBack={() => setMode({ id: 'select-event' })}
      />
    )
  }

  if (mode.id === 'select-hook') {
    const hasMatch = eventHasMatch(mode.event)
    const hooks = hooksForMatch(grouped, mode.event, mode.match)
    return (
      <SelectHookMode
        event={mode.event}
        match={mode.match}
        hasMatch={hasMatch}
        hooks={hooks}
        onSelect={index => {
          const hook = hooks[index]
          if (hook) {
            setMode({ id: 'view-hook', event: mode.event, match: mode.match, hook })
          }
        }}
        onBack={() =>
          setMode(hasMatch ? { id: 'select-match', event: mode.event } : { id: 'select-event' })
        }
      />
    )
  }

  return (
    <ViewHookMode
      event={mode.event}
      card={cards[mode.event]}
      hook={mode.hook}
      onBack={() => setMode({ id: 'select-hook', event: mode.event, match: mode.match })}
    />
  )
}
