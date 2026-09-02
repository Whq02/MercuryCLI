// Mode 2: pick a matcher for the chosen event. Each row carries its
// deduplicated bracketed source list and the pattern (an empty pattern
// displays as the all-matcher marker), described by its hook count.

import * as React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import { hookSourceInlineDisplayString } from '../../utils/hooks/hooksSettings.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'

/** Display for the empty (match-everything) pattern. */
export const ALL_MATCHER_MARKER = '*'

export function SelectMatcherMode({
  event,
  eventSummary,
  matchers,
  hooksByMatcher,
  availableToolNames,
  onSelect,
  onBack,
}: {
  event: HookEvent
  eventSummary: string
  matchers: string[]
  hooksByMatcher: Record<string, IndividualHookConfig[]>
  /** Built-in tool names plus the currently connected MCP tool names —
   *  the matcher metadata's tool vocabulary. */
  availableToolNames: string[]
  onSelect: (matcher: string) => void
  onBack: () => void
}): React.ReactNode {
  void availableToolNames

  if (matchers.length === 0) {
    return (
      <Dialog title={event} subtitle={eventSummary} onCancel={onBack}>
        <Text dimColor>
          No matchers are configured for this event. Add hooks in
          settings.json (or ask Mercury). esc goes back.
        </Text>
      </Dialog>
    )
  }

  return (
    <Dialog title={event} subtitle={eventSummary} onCancel={onBack}>
      <Select
        options={matchers.map(matcher => {
          const rows = hooksByMatcher[matcher] ?? []
          const sources = [
            ...new Set(rows.map(row => hookSourceInlineDisplayString(row.source))),
          ].join(', ')
          return {
            label: `[${sources}] ${matcher === '' ? ALL_MATCHER_MARKER : matcher}`,
            value: matcher,
            description: `${rows.length} ${plural(rows.length, 'hook')}`,
          }
        })}
        onChange={value => onSelect(value as string)}
      />
    </Dialog>
  )
}
