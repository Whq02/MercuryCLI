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
  /** ↵ on a command row — stages `/name ` in the composer and closes (the
   *  launcher's proven safe-insertion grammar; P6 "no dead Enter"). */
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
  // −12 (was −10): the ↵-stages hint row below the list costs 2 lines —
  // without the wider reserve the one visible option was pushed out of the
  // height budget on a 24-row terminal.
  const visibleCount = Math.max(1, Math.floor((maxHeight - 12) / 2))

  const options = useMemo(() => {
    // Custom commands can appear more than once (e.g. same name at user and
    // project scope). Dedupe by name to avoid React key collisions in Select.
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
    // Fork: group by domain — the flat alphabetical ~150-command wall was
    // unbrowsable. Domain headers are disabled
    // pseudo-options the cursor scrolls past; unmapped commands stay visible
    // in a trailing "everything else" group (commandDomains.ts); the plain list keeps
    // the alphabetical list (byte-identical).
    return groupCommandsByDomain(deduped).flatMap((group): OptionWithDescription[] => [
      {
        label: <Text dimColor bold>{`─ ${group.label} ─`}</Text>,
        value: `__domain:${group.key}`,
        disabled: true,
      },
      ...group.commands.map(toOption),
    ])
  }, [commands, maxWidth])

  // never park the ❯ on a DISABLED domain header (the Select
  // focuses option 0 by default — the first group's header) — focus starts
  // on the first real command so the visible cursor is always activatable.
  const firstCommand = options.find(o => !o.disabled)?.value

  return (
    <Box flexDirection="column" paddingY={1}>
      {commands.length === 0 && emptyMessage ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        <>
          <Text>{title}</Text>
          <Box marginTop={1}>
            {/* Fork: the row cursor was visible but ↵
                was DEAD (the old selection-off prop returned before Enter in
                use-select-input) — a browsable list that implied activation it
                didn't have. ↵ now stages the command in the composer (safe
                insertion, never surprise execution); digits stay non-hotkeys
                (`hideIndexes` keeps the 'numeric' guard). */}
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
