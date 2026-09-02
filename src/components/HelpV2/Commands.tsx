import * as React from 'react'
import { useMemo } from 'react'
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
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const maxWidth = Math.max(1, columns - 10)
  const visibleCount = Math.max(1, Math.floor((maxHeight - 12) / 2))

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
              defaultFocusValue={firstCommand}
              hideIndexes
              layout="compact-vertical"
              onUpFromFirstItem={focusHeader}
              isDisabled={headerFocused}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↵ stages the command in the composer — nothing runs until you send it</Text>
          </Box>
        </>
      )}
    </Box>
  )
}
