import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useAppStateStore } from '../../state/AppState.js'
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
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
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
  const store = useAppStateStore()
  const [mode, setMode] = useState<Mode>({ id: 'select-event' })

  const [policy, setPolicy] = useState(readPolicyAnswers)
  useEffect(
    () =>
      settingsChangeDetector.subscribe(source => {
        if (source === 'policySettings') setPolicy(readPolicyAnswers())
      }),
    [],
  )

  const appState = store.getState()
  const totalCount = useMemo(() => listHooks(appState).length, [appState])

  const availableToolNames = useMemo(
    () => [...toolNames, ...appState.mcp.tools.map(tool => tool.name)],
    [toolNames, appState.mcp.tools],
  )

  const cards = useMemo(() => hookEventCards(availableToolNames), [availableToolNames])
  const grouped = useMemo(() => groupHooksByEventAndMatch(appState), [appState])

  const close = () => onExit(undefined, { display: 'skip' })

  if (hooksDisabled()) {
    return (
      <Dialog title="Hooks are disabled" onCancel={close}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Hooks are currently disabled
            {policy.policyDisablesAll ? ' by a managed settings file' : ''}.
            {totalCount > 0
              ? ` ${totalCount} configured ${plural(totalCount, 'hook')} ${totalCount === 1 ? 'is' : 'are'} not running.`
              : ''}
          </Text>
          <Box flexDirection="column">
            <Text dimColor>· No hook runs.</Text>
            <Text dimColor>· Every moment proceeds without a hook's word.</Text>
          </Box>
          {!policy.policyDisablesAll ? (
            <Text dimColor>Remove events.disabled from settings.json (or ask Mercury) to re-enable them.</Text>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  const managedOnlyNotice = policy.managedOnly ? (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="warning">Only hooks from managed settings can run right now.</Text>
      <Text dimColor>
        Hooks from these sources are blocked:{' '}
        {[
          (() => {
            const userPath = getSettingsFilePathForSource('userSettings')
            return userPath ? toTildePath(userPath) : 'user settings.json'
          })(),
          getRelativeSettingsFilePathForSource('projectSettings'),
          getRelativeSettingsFilePathForSource('localSettings'),
        ].join(', ')}
      </Text>
    </Box>
  ) : null

  switch (mode.id) {
    case 'select-event':
      return (
        <Box flexDirection="column">
          {managedOnlyNotice}
          <SelectEventMode
            events={HOOK_EVENTS}
            moments={Object.fromEntries(HOOK_EVENTS.map(event => [event, cards[event].moment]))}
            countsByEvent={Object.fromEntries(
              HOOK_EVENTS.map(event => [event, Object.values(grouped[event] ?? {}).reduce((sum, rows) => sum + rows.length, 0)]),
            )}
            totalCount={totalCount}
            onSelect={event =>
              setMode(eventHasMatch(event) ? { id: 'select-match', event } : { id: 'select-hook', event, match: '' })
            }
            onExit={close}
          />
        </Box>
      )

    case 'select-match':
      return (
        <SelectMatcherMode
          event={mode.event}
          card={cards[mode.event]}
          matches={sortedMatchesForEvent(grouped, mode.event)}
          hooksByMatch={grouped[mode.event] ?? {}}
          onSelect={match => setMode({ id: 'select-hook', event: mode.event, match })}
          onBack={() => setMode({ id: 'select-event' })}
        />
      )

    case 'select-hook': {
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
            if (hook) setMode({ id: 'view-hook', event: mode.event, match: mode.match, hook })
          }}
          onBack={() => setMode(hasMatch ? { id: 'select-match', event: mode.event } : { id: 'select-event' })}
        />
      )
    }

    case 'view-hook':
      return (
        <ViewHookMode
          event={mode.event}
          card={cards[mode.event]}
          hook={mode.hook}
          onBack={() => setMode({ id: 'select-hook', event: mode.event, match: mode.match })}
        />
      )
  }
}
