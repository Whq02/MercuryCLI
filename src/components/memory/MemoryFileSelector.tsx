
import { mkdirSync } from 'fs'
import * as React from 'react'
import { use, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getInstructionFiles } from '../../services/instructions/engine.js'
import { attachedRows, getInstructionListing, listingRowWords, loadedStateOf, toolPrefixOf } from '../../services/instructions/listing.js'
import type { AttachedInstruction } from '../../services/instructions/attachedText.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import { openPath } from '../../utils/browser.js'
import { getMemoryPath } from '../../utils/config.js'
import { toTildePath } from '../../utils/path.js'
import { getMnemeHome, isMnemeEnabled } from '../../mneme/paths.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { getRelativeMemoryPath } from './MemoryUpdateNotification.js'
import { memoryFileListLayout } from './memoryCentreLayout.js'


let lastSelectedPath: string | null = null

type Row = {
  label: string
  value: string
  description?: string
}

function importDepthOf(
  entry: InstructionSourceEntry,
  byPath: Map<string, InstructionSourceEntry>,
): number {
  let depth = 0
  let current: InstructionSourceEntry | undefined = entry
  while (current?.parent) {
    depth += 1
    current = byPath.get(current.parent)
    if (depth > 10) break
  }
  return depth
}

export function MemoryFileSelector({
  onSelect,
  onCancel,
  held,
  attached,
  width = 80,
  rowBudget = 7,
}: {
  onSelect: (path: string) => void
  onCancel: () => void
  held: (path: string) => boolean
  attached?: readonly AttachedInstruction[]
  width?: number
  rowBudget?: number
}): React.ReactNode {
  const files = use(getInstructionFiles())
  const listing = use(getInstructionListing())

  useExitOnCtrlCDWithKeybindings()

  const [mnemeOn, setMnemeOn] = useState(() => isMnemeEnabled())
  const [firstVisible, setFirstVisible] = useState(0)

  const toggles: Array<{
    id: 'memory'
    flip: () => void
  }> = [
    {
      id: 'memory',
      flip: () => {
        const { error } = updateSettingsForSource('userSettings', { memory: { enabled: !mnemeOn } })
        if (error === null) setMnemeOn(!mnemeOn)
      },
    },
  ]
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null)
  const toggleFocused = focusedToggle !== null

  useKeybinding(
    'select:previous',
    () => {
      setFocusedToggle(index => Math.max(0, (index ?? 0) - 1))
    },
    { context: 'Select', isActive: toggleFocused },
  )
  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle(index => {
        const next = (index ?? 0) + 1
        return next >= toggles.length ? null : next
      })
    },
    { context: 'Select', isActive: toggleFocused },
  )
  useKeybinding(
    'confirm:yes',
    () => {
      if (focusedToggle !== null) toggles[focusedToggle]?.flip()
    },
    { context: 'Confirmation', isActive: toggleFocused },
  )

  const rows = useMemo<Row[]>(() => {
    const visible = [...files]
    const byPath = new Map(visible.map(entry => [entry.path, entry]))
    const userCanonical = getMemoryPath('User')
    const projectCanonical = getMemoryPath('Project')

    const nativePrefix = (entry: InstructionSourceEntry | undefined) =>
      toolPrefixOf(entry) ?? (entry?.family === 'native' ? 'Mercury-native · ' : entry?.family === 'shared' ? 'shared guide · ' : '')

    const result: Row[] = visible.map(entry => {
      const depth = importDepthOf(entry, byPath)
      if (entry.path === userCanonical) {
        return {
          label: 'User memory',
          value: entry.path,
          description: `${nativePrefix(entry)}${toTildePath(entry.path)}`,
        }
      }
      if (entry.path === projectCanonical) {
        return {
          label: 'Project memory',
          value: entry.path,
          description: `${nativePrefix(entry)}${getRelativeMemoryPath(entry.path)} · loads every session`,
        }
      }
      if (depth > 0) {
        return {
          label: `${'  '.repeat(depth)}↳ ${getRelativeMemoryPath(entry.path)}`,
          value: entry.path,
          description: `${nativePrefix(entry)}imported via @${
            entry.parent ? ` from ${getRelativeMemoryPath(entry.parent)}` : ''
          }`,
        }
      }
      return {
        label: getRelativeMemoryPath(entry.path),
        value: entry.path,
        description: `${nativePrefix(entry).replace(/ · $/, '')}${loadedStateOf(entry)}`,
      }
    })
    for (const row of [...listing, ...attachedRows(held, [...visible.map(entry => entry.path), ...listing.map(row => row.path)], attached)]) {
      result.push({ label: getRelativeMemoryPath(row.path), value: row.path, description: listingRowWords(row, '', held, attached === undefined ? undefined : held) })
    }

    if (!byPath.has(userCanonical)) {
      result.push({
        label: 'User memory (new)',
        value: userCanonical,
        description: toTildePath(userCanonical),
      })
    }
    if (!byPath.has(projectCanonical)) {
      result.push({
        label: 'Project memory (new)',
        value: projectCanonical,
        description: `will be written at ${getRelativeMemoryPath(projectCanonical)}`,
      })
    }

    if (mnemeOn) {
      result.push({
        label: 'Open the memory folder',
        value: '::open:memory',
        description: 'opens the folder in your file manager',
      })
    }

    return result
  }, [files, listing, mnemeOn, held, attached])

  const layout = memoryFileListLayout(rows, width, Math.max(1, rowBudget - 2), firstVisible)
  const preselect =
    lastSelectedPath !== null &&
    rows.some(row => row.value === lastSelectedPath)
      ? lastSelectedPath
      : rows[0]?.value

  const activate = (value: string) => {
    lastSelectedPath = value
    if (value.startsWith('::open:')) {
      const dir = getMnemeHome()
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
      }
      void openPath(dir)
      return
    }
    onSelect(value)
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text
          bold={focusedToggle === 0}
          inverse={focusedToggle === 0}
        >
          Memory: {mnemeOn ? 'on' : 'off'}
        </Text>
      </Box>
      <Select
        {...layout}
        onVisibleWindowChange={from => setFirstVisible(from)}
        isDisabled={toggleFocused}
        options={layout.layout === 'compact-vertical' ? rows.map(row => ({ ...row, label: ` ${row.label}` })) : rows}
        defaultFocusValue={preselect}
        onChange={activate}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(toggles.length - 1)}
      />
    </Box>
  )
}
