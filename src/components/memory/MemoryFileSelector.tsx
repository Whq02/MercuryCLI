
import { mkdirSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { use, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getInstructionFiles } from '../../services/instructions/engine.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import { openPath } from '../../utils/browser.js'
import { getMemoryPath } from '../../utils/config.js'
import { projectIsInGitRepo } from '../../utils/memory/versions.js'
import { toTildePath } from '../../utils/path.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { getRelativeMemoryPath } from './MemoryUpdateNotification.js'


let lastSelectedPath: string | null = null

type Row = {
  label: React.ReactNode
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
}: {
  onSelect: (path: string) => void
  onCancel: () => void
}): React.ReactNode {
  const files = use(getInstructionFiles())

  useExitOnCtrlCDWithKeybindings()

  const [autoMemoryOn, setAutoMemoryOn] = useState(() => isAutoMemoryEnabled())

  const toggles: Array<{
    id: 'auto-memory'
    flip: () => void
  }> = [
    {
      id: 'auto-memory',
      flip: () => {
        updateSettingsForSource('userSettings', { memory: { enabled: !autoMemoryOn } })
        setAutoMemoryOn(value => !value)
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
    const inGitRepo = projectIsInGitRepo(getOriginalCwd())

    const nativePrefix = (entry: InstructionSourceEntry | undefined) =>
      entry?.family === 'native' ? 'Mercury-native · ' : ''

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
          description: `${nativePrefix(entry)}${
            inGitRepo ? 'checked in at' : 'saved in'
          } ${getRelativeMemoryPath(entry.path)}`,
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
        description: `${nativePrefix(entry)}${getRelativeMemoryPath(entry.path)}`,
      }
    })

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
        description: `${
          inGitRepo ? 'checked in at' : 'saved in'
        } ${getRelativeMemoryPath(projectCanonical)}`,
      })
    }

    if (autoMemoryOn) {
      result.push({
        label: 'Open the memory folder',
        value: '::open:automem',
        description: 'opens the folder in your file manager',
      })
    }

    return result
  }, [files, autoMemoryOn])

  const preselect =
    lastSelectedPath !== null &&
    rows.some(row => row.value === lastSelectedPath)
      ? lastSelectedPath
      : rows[0]?.value

  const activate = (value: string) => {
    lastSelectedPath = value
    if (value.startsWith('::open:')) {
      const dir = getAutoMemPath()
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
          Memory: {autoMemoryOn ? 'on' : 'off'}
        </Text>
      </Box>
      <Select
        isDisabled={toggleFocused}
        options={rows}
        defaultFocusValue={preselect}
        onChange={activate}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(toggles.length - 1)}
      />
    </Box>
  )
}
