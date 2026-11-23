import { mkdirSync } from 'fs'
import * as React from 'react'
import { use, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getInstructionFiles } from '../../services/instructions/engine.js'
import { attachedRows, getInstructionListing, listingRowWords, loadedStateOf, toolPrefixOf } from '../../services/instructions/listing.js'
import type { AttachedInstruction } from '../../services/instructions/attachedText.js'
import type { InstructionSourceEntry } from '../../utils/instructions/contracts.js'
import { openPath } from '../../utils/browser.js'
import { getMemoryPath } from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { toTildePath } from '../../utils/path.js'
import { getMnemeHome, isMnemeEnabled } from '../../mneme/paths.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { getRelativeMemoryPath } from './MemoryUpdateNotification.js'
import { memoryFileListLayout } from './memoryCentreLayout.js'

export function openMemoryFolder(
  dir: string,
  ops: { mkdirSync: typeof mkdirSync; openPath: typeof openPath } = { mkdirSync, openPath },
  onOpenError?: (message: string) => void,
): string | null {
  try {
    ops.mkdirSync(dir, { recursive: true })
  } catch (error) {
    logError(error)
    return `Could not open the memory folder at ${toTildePath(dir)} (${errorMessage(error)}) — check folder permissions.`
  }
  let reported = false
  void ops
    .openPath(dir, error => {
      reported = true
      onOpenError?.(`${toTildePath(dir)} could not be opened (${error}) — open it yourself`)
    })
    .then(ok => {
      if (!ok && !reported) {
        onOpenError?.(`${toTildePath(dir)} could not be opened (could not start file manager) — open it yourself`)
      }
    })
  return null
}
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

const DEFAULT_HELD = (): boolean => true

export function MemoryFileSelector({
  onSelect,
  onCancel,
  held = DEFAULT_HELD,
  attached,
  width = 80,
  rowBudget = 7,
}: {
  onSelect: (path: string) => void
  onCancel: () => void
  held?: (path: string) => boolean
  attached?: readonly AttachedInstruction[]
  width?: number
  rowBudget?: number
}): React.ReactNode {
  const files = use(getInstructionFiles())
  const listing = use(getInstructionListing())
  const tokens = useMercuryTokens()
  const [mnemeOn, setMnemeOn] = useState(() => isMnemeEnabled())
  const [firstVisible, setFirstVisible] = useState(0)
  const [openError, setOpenError] = useState<string | null>(null)
  const [focusedToggle, setFocusedToggle] = useState<0 | null>(null)

  useExitOnCtrlCDWithKeybindings(onCancel)

  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle(null)
    },
    { context: 'Select', isActive: focusedToggle !== null },
  )

  useKeybinding(
    'confirm:yes',
    () => {
      const next = !mnemeOn
      const result = updateSettingsForSource('userSettings', {
        memory: { enabled: next },
      })
      if (!result.error) {
        setMnemeOn(next)
      }
    },
    { context: 'Confirmation', isActive: focusedToggle !== null },
  )

  useKeybinding(
    'confirm:no',
    () => {
      onCancel()
    },
    { context: 'Confirmation', isActive: focusedToggle !== null },
  )

  const rows = useMemo((): Row[] => {
    const out: Row[] = []
    const userPath = getMemoryPath('User')
    const projectPath = getMemoryPath('Project')
    const byPath = new Map(files.map(entry => [entry.path, entry]))

    for (const entry of files) {
      const nativePrefix = toolPrefixOf(entry) ?? ''
      const relPath = getRelativeMemoryPath(entry.path)
      if (entry.path === userPath) {
        out.push({
          label: 'User memory',
          value: entry.path,
          description: `${nativePrefix}${toTildePath(entry.path)}`,
        })
      } else if (entry.path === projectPath) {
        out.push({
          label: 'Project memory',
          value: entry.path,
          description: `${nativePrefix}${relPath} · loads every session`,
        })
      } else if (entry.parent !== undefined && importDepthOf(entry, byPath) > 0) {
        const depth = importDepthOf(entry, byPath)
        out.push({
          label: `${' '.repeat(depth)}↳ ${relPath}`,
          value: entry.path,
          description: `${nativePrefix}imported via @ from ${getRelativeMemoryPath(entry.parent)}`,
        })
      } else {
        const strippedPrefix = nativePrefix.replace(/ · $/, '')
        const description = `${strippedPrefix}${loadedStateOf(entry)}`.replace(/^ · /, '')
        out.push({
          label: relPath,
          value: entry.path,
          ...(description !== '' ? { description } : {}),
        })
      }
    }

    const listedPaths = [...files.map(entry => entry.path), ...listing.map(row => row.path)]
    const extraAttached = attachedRows(held, listedPaths, attached)
    const wasAttached = attached
      ? (path: string) => attached.some(item => item.path === path)
      : undefined
    for (const row of [...listing, ...extraAttached]) {
      const relPath = getRelativeMemoryPath(row.path)
      const description = listingRowWords(row, '', held, wasAttached)
      out.push({
        label: relPath,
        value: row.path,
        ...(description !== '' ? { description } : {}),
      })
    }

    if (!byPath.has(userPath)) {
      out.push({
        label: 'User memory (new)',
        value: userPath,
        description: `will be written at ${getRelativeMemoryPath(userPath)}`,
      })
    }
    if (!byPath.has(projectPath)) {
      out.push({
        label: 'Project memory (new)',
        value: projectPath,
        description: `will be written at ${getRelativeMemoryPath(projectPath)}`,
      })
    }

    if (mnemeOn) {
      out.push({
        label: 'Open the memory folder',
        value: '::open:memory',
        description: 'opens the folder in your file manager',
      })
    }

    return out
  }, [files, listing, held, attached, mnemeOn])

  const defaultFocusValue = useMemo(() => {
    if (lastSelectedPath !== null && rows.some(row => row.value === lastSelectedPath)) {
      return lastSelectedPath
    }
    return rows[0]?.value
  }, [rows])

  const listBudget = Math.max(1, rowBudget - 2 - (openError !== null ? 1 : 0))
  const { layout, visibleOptionCount } = useMemo(
    () => memoryFileListLayout(rows, width, listBudget, firstVisible),
    [rows, width, listBudget, firstVisible],
  )

  const handleChange = (value: string): void => {
    lastSelectedPath = value
    if (value.startsWith('::open:')) {
      setOpenError(null)
      const err = openMemoryFolder(getMnemeHome(), undefined, message => setOpenError(message))
      if (err !== null) {
        setOpenError(err)
      }
      return
    }
    onSelect(value)
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text inverse={focusedToggle === 0} bold={focusedToggle === 0}>
          {`Memory: ${mnemeOn ? 'on' : 'off'}`}
        </Text>
      </Box>
      <Select
        options={rows}
        defaultFocusValue={defaultFocusValue}
        isDisabled={focusedToggle !== null}
        layout={layout}
        visibleOptionCount={visibleOptionCount}
        onChange={handleChange}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(0)}
        onVisibleWindowChange={from => setFirstVisible(from)}
      />
      {openError !== null ? <Text color={tokens.failureText}>{openError}</Text> : null}
    </Box>
  )
}
