import * as React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import type { HookEventCard } from '../../utils/hooks/hooksConfigManager.js'
import { hookSourceShortWords, type HookRow } from '../../utils/hooks/hooksSettings.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'

export const ALL_MATCHER_MARKER = '*'

export function matchFieldWords(card: HookEventCard): string {
  if (card.match === undefined) return 'no match field'
  const values = card.matchValues
  return values !== undefined && values.length > 0 ? `match: ${card.match} (${values.join(', ')})` : `match: ${card.match}`
}

export function SelectMatcherMode({
  event,
  card,
  matches,
  hooksByMatch,
  onSelect,
  onBack,
}: {
  event: HookEvent
  card: HookEventCard
  matches: string[]
  hooksByMatch: Record<string, HookRow[]>
  onSelect: (match: string) => void
  onBack: () => void
}): React.ReactNode {
  const subtitle = `${card.moment} ${matchFieldWords(card)}`
  if (matches.length === 0) {
    return (
      <Dialog title={event} subtitle={subtitle} onCancel={onBack}>
        <Text dimColor>No hooks are configured for this event. Add hooks in settings.json (or ask Mercury). esc goes back.</Text>
      </Dialog>
    )
  }

  return (
    <Dialog title={event} subtitle={subtitle} onCancel={onBack}>
      <Select
        options={matches.map(match => {
          const rows = hooksByMatch[match] ?? []
          const sources = [...new Set(rows.map(row => hookSourceShortWords(row.source)))].join(', ')
          return {
            label: `[${sources}] ${match === '' ? ALL_MATCHER_MARKER : match}`,
            value: match,
            description: `${rows.length} ${plural(rows.length, 'hook')}`,
          }
        })}
        onChange={value => onSelect(value as string)}
      />
    </Dialog>
  )
}
