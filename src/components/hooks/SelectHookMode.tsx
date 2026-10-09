import * as React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
import { hookRowKind, hookRowName, hookSourceWords, type HookRow } from '../../utils/hooks/hooksSettings.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { ALL_MATCHER_MARKER } from './SelectMatcherMode.js'

export function SelectHookMode({
  event,
  match,
  hasMatch,
  hooks,
  onSelect,
  onBack,
}: {
  event: HookEvent
  match: string
  hasMatch: boolean
  hooks: HookRow[]
  onSelect: (index: number) => void
  onBack: () => void
}): React.ReactNode {
  const title = hasMatch ? `${event} · ${match === '' ? ALL_MATCHER_MARKER : match}` : event

  if (hooks.length === 0) {
    return (
      <Dialog title={title} onCancel={onBack}>
        <Text dimColor>Nothing is configured here. Edit settings.json (or ask Mercury) to add hooks.</Text>
      </Dialog>
    )
  }

  return (
    <Dialog title={title} onCancel={onBack}>
      <Select
        options={hooks.map((row, index) => ({
          label: `[${hookRowKind(row)}] ${hookRowName(row)}`,
          value: String(index),
          description: hookSourceWords(row.source),
        }))}
        onChange={value => onSelect(Number(value))}
      />
    </Dialog>
  )
}
