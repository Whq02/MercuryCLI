import * as React from 'react'
import { useMemo, useState } from 'react'
import { type Command, formatDescriptionWithSource } from '../../commands.js'
import { Box, Text, useInput } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import { Select, type OptionWithDescription } from '../CustomSelect/select.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'
import { groupCommandsByDomain } from './commandDomains.js'

type Props = {
  commands: Command[]
  maxHeight: number
  columns: number
  title: string
  onCancel: () => void
  onPick: (commandName: string) => void
  emptyMessage?: string
}

export function Commands({
  commands,
  maxHeight,
  columns,
  title,
  onCancel,
  onPick,
  emptyMessage,
}: Props): React.ReactNode {
  const { headerFocused, focusHeader, blurHeader } = useTabHeaderFocus()
  const maxWidth = Math.max(1, columns - 10)
  const visibleCount = Math.max(1, Math.floor((maxHeight - 13) / 2))

  const options = useMemo<OptionWithDescription<string>[]>(() => {
    const seen = new Set<string>()
    const unique: Command[] = []
    for (const cmd of commands) {
      if (seen.has(cmd.name)) continue
      seen.add(cmd.name)
      unique.push(cmd)
    }
    const groups = groupCommandsByDomain(unique)
    const out: OptionWithDescription<string>[] = []
    for (const group of groups) {
      out.push({
        label: `─ ${group.label} ─`,
        value: `__domain:${group.key}`,
        disabled: true,
      })
      for (const cmd of group.commands) {
        out.push({
          label: `/${cmd.name}`,
          value: cmd.name,
          description: truncate(formatDescriptionWithSource(cmd), maxWidth, true),
        })
      }
    }
    return out
  }, [commands, maxWidth])

  const [focusValue, setFocusValue] = useState<string | undefined>(undefined)

  useInput(
    (_input, key, event) => {
      if (!key.pageDown && !key.pageUp) return
      event.stopImmediatePropagation()
      const startIndex = key.pageDown ? visibleCount : 0
      const target =
        options.slice(startIndex).find(opt => !opt.disabled) ??
        options.find(opt => !opt.disabled)
      if (target !== undefined) {
        setFocusValue(target.value)
      }
      blurHeader()
    },
    { isActive: headerFocused && options.length > 0 },
  )

  if (commands.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text dimColor>{emptyMessage ?? 'No commands available.'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Text bold>{title}</Text>
      <Select
        options={options}
        isDisabled={headerFocused}
        hideIndexes
        visibleOptionCount={visibleCount}
        defaultFocusValue={focusValue}
        onFocus={setFocusValue}
        onUpFromFirstItem={focusHeader}
        onCancel={onCancel}
        onChange={value => {
          if (!value.startsWith('__domain:')) {
            onPick(value)
          }
        }}
      />
      <Box flexDirection="column">
        <Text dimColor>↑↓ move · pgup/pgdn page · ↵ stage · esc close</Text>
        <Text dimColor>
          ↵ stages the command in the composer — nothing runs until you send it
        </Text>
      </Box>
    </Box>
  )
}
