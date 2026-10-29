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
  const [pageFocus, setPageFocus] = useState<string | undefined>()
  const maxWidth = Math.max(1, columns - 10)

  const visibleCount = Math.max(1, Math.floor((maxHeight - 13) / 2))

  const options = useMemo(() => {

    const seen = new Set<string>()
    const deduped = commands.filter(cmd => {
      if (seen.has(cmd.name)) return false
      seen.add(cmd.name)
      return true
    })
    const toOption = (cmd: Command): OptionWithDescription => ({
      label: `/${cmd.name}`,
      value: cmd.name,
      description: truncate(formatDescriptionWithSource(cmd), maxWidth, true),
    })

    return groupCommandsByDomain(deduped).flatMap((group): OptionWithDescription[] => [
      {
        label: <Text dimColor bold>{`─ ${group.label} ─`}</Text>,
        value: `__domain:${group.key}`,
        disabled: true,
      },
      ...group.commands.map(toOption),
    ])
  }, [commands, maxWidth])

  const firstCommand = options.find(o => !o.disabled)?.value
  useInput((_input, key, event) => {
    if (!key.pageDown && !key.pageUp) return
    const start = key.pageDown ? Math.min(visibleCount, options.length - 1) : 0
    const target = options.slice(start).find(option => !option.disabled) ?? options.find(option => !option.disabled)
    setPageFocus(target?.value)
    blurHeader()
    event.stopImmediatePropagation()
  }, { isActive: headerFocused })

  return (
    <Box flexDirection="column" paddingY={1}>
      {commands.length === 0 && emptyMessage ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        <>
          <Text>{title}</Text>
          <Box marginTop={1}>
            {
}
            <Select
              options={options}
              visibleOptionCount={visibleCount}
              onCancel={onCancel}
              onChange={name => {
                if (!name.startsWith('__domain:')) onPick(name)
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
            <Text dimColor>↵ stages the command in the composer — nothing runs until you send it</Text>
          </Box>
        </>
      )}
    </Box>
  )
}
