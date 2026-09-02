// Mode 3: pick a hook under the chosen event (and matcher, when the event
// supports them). Rows are labelled with the bracketed hook type and the
// hook's display text, described by their source.

import * as React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js'
import {
  getHookDisplayText,
  hookSourceDescriptionDisplayString,
} from '../../utils/hooks/hooksSettings.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../CustomSelect/select.js'
import { ALL_MATCHER_MARKER } from './SelectMatcherMode.js'

export function SelectHookMode({
  event,
  matcher,
  supportsMatchers,
  hooks,
  onSelect,
  onBack,
}: {
  event: HookEvent
  /** The chosen matcher; empty string is the all-matcher. */
  matcher: string
  supportsMatchers: boolean
  hooks: IndividualHookConfig[]
  onSelect: (index: number) => void
  onBack: () => void
}): React.ReactNode {
  const title = supportsMatchers
    ? `${event} · ${matcher === '' ? ALL_MATCHER_MARKER : matcher}`
    : event

  if (hooks.length === 0) {
    return (
      <Dialog title={title} onCancel={onBack}>
        <Text dimColor>
          Nothing is configured here. Edit settings.json (or ask Mercury) to
          add hooks.
        </Text>
      </Dialog>
    )
  }

  return (
    <Dialog title={title} onCancel={onBack}>
      <Select
        options={hooks.map((row, index) => ({
          label: `[${row.config.type}] ${getHookDisplayText(row.config)}`,
          value: String(index),
          description:
            row.source === 'extensionHook' && row.extensionName
              ? `${hookSourceDescriptionDisplayString(row.source)} — ${row.extensionName}`
              : hookSourceDescriptionDisplayString(row.source),
        }))}
        onChange={value => onSelect(Number(value))}
      />
    </Dialog>
  )
}
