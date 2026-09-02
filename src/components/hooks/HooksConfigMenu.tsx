// /hooks — the read-only hook browser. Four modes (event → matcher → hook →
// detail), each esc stepping exactly one level back; stepping back out of the
// hook list skips the matcher level for events that do not support matchers,
// mirroring the forward skip. Deliberately read-only: every dead end points
// at settings.json or Mercury itself.
//
// Event metadata (summaries, descriptions, matcher support) and the
// event→matcher grouping come from the ONE landed owner,
// utils/hooks/hooksConfigManager — never re-derived here.

import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useAppStateStore } from '../../state/AppState.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getAllHooks,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js'
import {
  getHookEventMetadata,
  getHooksForMatcher,
  getSortedMatchersForEvent,
  groupHooksByEventAndMatcher,
} from '../../utils/hooks/hooksConfigManager.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
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
  | { id: 'select-matcher'; event: HookEvent }
  | { id: 'select-hook'; event: HookEvent; matcher: string }
  | { id: 'view-hook'; event: HookEvent; matcher: string; hook: IndividualHookConfig }

function readPolicyAnswers(): {
  policyDisablesAll: boolean
  managedOnly: boolean
} {
  return {
    policyDisablesAll:
      getSettingsForSource('policySettings')?.disableAllHooks === true,
    managedOnly: shouldAllowManagedHooksOnly(),
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

  // Both policy answers are captured at mount and re-read only when the
  // POLICY settings source changes (a user-level toggle while the
  // menu is open deliberately does not refresh this screen).
  const [policy, setPolicy] = useState(readPolicyAnswers)
  useEffect(
    () =>
      settingsChangeDetector.subscribe(source => {
        if (source === 'policySettings') setPolicy(readPolicyAnswers())
      }),
    [],
  )

  const appState = store.getState()
  const totalCount = useMemo(() => getAllHooks(appState).length, [appState])

  // The available tool names fed to matcher metadata: the built-in tool
  // names PLUS the currently connected MCP tool names.
  const availableToolNames = useMemo(
    () => [...toolNames, ...appState.mcp.tools.map(tool => tool.name)],
    [toolNames, appState.mcp.tools],
  )

  const metadata = useMemo(
    () => getHookEventMetadata(availableToolNames),
    [availableToolNames],
  )
  const byEventAndMatcher = useMemo(
    () => groupHooksByEventAndMatcher(appState, availableToolNames),
    [appState, availableToolNames],
  )

  const supportsMatchers = (event: HookEvent): boolean =>
    metadata[event]?.matcherMetadata !== undefined

  const close = () => onExit(undefined, { display: 'skip' })

  // The EFFECTIVE disable flag is re-read on every render.
  if (shouldDisableAllHooksIncludingManaged()) {
    return (
      <Dialog title="Hooks are disabled" onCancel={close}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Hooks are currently disabled
            {policy.policyDisablesAll ? ' by a managed settings file' : ''}.
            {totalCount > 0
              ? ` ${totalCount} configured ${plural(totalCount, 'hook')} ${
                  totalCount === 1 ? 'is' : 'are'
                } not running.`
              : ''}
          </Text>
          <Box flexDirection="column">
            <Text dimColor>· No hook commands execute.</Text>
            <Text dimColor>· The status line is not displayed.</Text>
            <Text dimColor>
              · Tool operations proceed without hook validation.
            </Text>
          </Box>
          {!policy.policyDisablesAll ? (
            <Text dimColor>
              Remove disableAllHooks from settings.json (or ask Mercury) to
              re-enable them.
            </Text>
          ) : null}
        </Box>
      </Dialog>
    )
  }

  const managedOnlyNotice = policy.managedOnly ? (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="warning">
        Only hooks from managed settings can run right now.
      </Text>
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
            summaries={Object.fromEntries(
              HOOK_EVENTS.map(event => [event, metadata[event]?.summary ?? '']),
            )}
            countsByEvent={Object.fromEntries(
              HOOK_EVENTS.map(event => [
                event,
                Object.values(byEventAndMatcher[event] ?? {}).reduce(
                  (sum, rows) => sum + rows.length,
                  0,
                ),
              ]),
            )}
            totalCount={totalCount}
            onSelect={event =>
              setMode(
                supportsMatchers(event)
                  ? { id: 'select-matcher', event }
                  : { id: 'select-hook', event, matcher: '' },
              )
            }
            onExit={close}
          />
        </Box>
      )

    case 'select-matcher':
      return (
        <SelectMatcherMode
          event={mode.event}
          eventSummary={metadata[mode.event]?.description ?? ''}
          matchers={getSortedMatchersForEvent(byEventAndMatcher, mode.event)}
          hooksByMatcher={byEventAndMatcher[mode.event] ?? {}}
          availableToolNames={availableToolNames}
          onSelect={matcher =>
            setMode({ id: 'select-hook', event: mode.event, matcher })
          }
          onBack={() => setMode({ id: 'select-event' })}
        />
      )

    case 'select-hook': {
      const supports = supportsMatchers(mode.event)
      const hooks = getHooksForMatcher(
        byEventAndMatcher,
        mode.event,
        mode.matcher,
      )
      return (
        <SelectHookMode
          event={mode.event}
          matcher={mode.matcher}
          supportsMatchers={supports}
          hooks={hooks}
          onSelect={index => {
            const hook = hooks[index]
            if (hook) {
              setMode({
                id: 'view-hook',
                event: mode.event,
                matcher: mode.matcher,
                hook,
              })
            }
          }}
          // Backing out skips the matcher level when the event has none,
          // mirroring the forward skip.
          onBack={() =>
            setMode(
              supports
                ? { id: 'select-matcher', event: mode.event }
                : { id: 'select-event' },
            )
          }
        />
      )
    }

    case 'view-hook':
      return (
        <ViewHookMode
          event={mode.event}
          matcher={mode.matcher}
          supportsMatchers={supportsMatchers(mode.event)}
          hook={mode.hook}
          onBack={() =>
            setMode({
              id: 'select-hook',
              event: mode.event,
              matcher: mode.matcher,
            })
          }
        />
      )
  }
}
