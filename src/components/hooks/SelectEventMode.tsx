// Mode 1 of the read-only /hooks browser: pick a hook event. Every event is
// listed with its summary; events with configured hooks carry a highlighted
// count. The menu is read-only by design — editing happens in settings.json.

import * as React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'

export function SelectEventMode({
  events,
  summaries,
  countsByEvent,
  totalCount,
  onSelect,
  onExit,
}: {
  events: readonly HookEvent[]
  summaries: Record<string, string>
  countsByEvent: Record<string, number>
  totalCount: number
  onSelect: (event: HookEvent) => void
  onExit: () => void
}): React.ReactNode {
  return (
    <Dialog
      title="Hooks"
      subtitle={`${totalCount} configured ${plural(totalCount, 'hook')}`}
      onCancel={onExit}
    >
      <Text dimColor>
        This menu is read-only — edit settings.json (or ask Mercury) to change
        hooks.
      </Text>
      <Select
        options={events.map(event => {
          const count = countsByEvent[event] ?? 0
          return {
            label: count > 0 ? `${event} (${count})` : event,
            value: event,
            description: summaries[event],
          }
        })}
        onChange={value => onSelect(value as HookEvent)}
      />
    </Dialog>
  )
}
