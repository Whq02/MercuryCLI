import * as React from 'react'
import { useMemo, useState } from 'react'
import { useInput } from '../../ink.js'
import { type Command, formatDescriptionWithSource } from '../../commands.js'
import { Box, Text } from '../../ink.js'
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
  const [pageFocus, setPageFocus] = useState<string | undefined>(undefined)
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
        label: (
          <Text dimColor bold>
            {`─ ${group.label} ─`}
          </Text>
        ),
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

  const firstCommand = options.find(option => !option.disabled)?.value

  useInput(
    (_input, key, event) => {
      if (!key.pageDown && !key.pageUp) return
      const start = key.pageDown ? Math.min(visibleCount, options.length - 1) : 0
      const target =
        options.find((option, index) => index >= start && !option.disabled) ??
        options.find(option => !option.disabled)
      setPageFocus(target?.value)
      blurHeader()
      event.stopImmediatePropagation()
    },
    { isActive: headerFocused },
  )

  if (commands.length === 0 && emptyMessage) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>{title}</Text>
      <Box marginTop={1}>
        <Select
          options={options}
          visibleOptionCount={visibleCount}
          onCancel={onCancel}
          onChange={value => {
            if (!value.startsWith('__domain:')) {
              onPick(value)
            }
          }}
          defaultFocusValue={pageFocus ?? firstCommand}
          hideIndexes
          layout="compact-vertical"
          onUpFromFirstItem={focusHeader}
          isDisabled={headerFocused}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑↓ move · pgup/pgdn page · ↵ stage · esc close</Text>
        <Text dimColor>
          ↵ stages the command in the composer — nothing runs until you send it
        </Text>
      </Box>
    </Box>
  )
}
