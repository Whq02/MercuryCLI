import { mkdirSync } from 'fs'
import * as React from 'react'
import { use, useMemo, useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useExitChord } from '../keys/useExitChord.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { getInstructionFiles } from '../../sessions/instructions/instructionFiles.js'
import { attachedRows, getInstructionListing, listingRowWords, loadedStateOf, toolPrefixOf } from '../../sessions/instructions/listing.js'
import type { AttachedInstruction } from '../../sessions/instructions/attachedText.js'
import type { InstructionSourceEntry } from '../../sessions/instruction-contracts/contracts.js'
import { openPath } from '../../platform/host-os/browser.js'
import { getInstructionFilePath } from '../../platform/settings/config.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import { toTildePath } from '../../platform/files/path.js'
import { getMnemeHome, isMnemeEnabled } from '../../sessions/mneme/paths.js'
import { updateSettingsForSource } from '../../platform/settings/settings.js'
import { Select } from '../select/Select.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { getRelativeInstructionFilePath } from './MemoryUpdateNotification.js'
import { instructionFileListLayout } from './memoryCentreLayout.js'

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

const TOGGLE_COUNT = 1

function prefixOf(entry: InstructionSourceEntry): string {
  const tool = toolPrefixOf(entry)
  if (tool !== null) return tool
  if (entry.family === 'native') return 'Mercury-native · '
  if (entry.family === 'shared') return 'shared guide · '
  return ''
}

export function InstructionFileSelector({
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
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null)

  useExitChord()

  useKeybinding(
    'select:previous',
    () => {
      setFocusedToggle(prev => (prev === null ? prev : Math.max(0, prev - 1)))
    },
    { context: 'Select', isActive: focusedToggle !== null },
  )

  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle(prev => (prev === null || prev >= TOGGLE_COUNT - 1 ? null : prev + 1))
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

  const rows = useMemo((): Row[] => {
    const out: Row[] = []
    const userPath = getInstructionFilePath('User')
    const projectPath = getInstructionFilePath('Project')
    const byPath = new Map(files.map(entry => [entry.path, entry]))

    for (const entry of files) {
      const depth = importDepthOf(entry, byPath)
      const prefix = prefixOf(entry)
      const relPath = getRelativeInstructionFilePath(entry.path)
      if (entry.path === userPath) {
        out.push({
          label: 'User memory',
          value: entry.path,
          description: `${prefix}${toTildePath(entry.path)}`,
        })
      } else if (entry.path === projectPath) {
        out.push({
          label: 'Project memory',
          value: entry.path,
          description: `${prefix}${relPath} · loads every session`,
        })
      } else if (depth > 0) {
        const from = entry.parent ? ` from ${getRelativeInstructionFilePath(entry.parent)}` : ''
        out.push({
          label: `${'  '.repeat(depth)}↳ ${relPath}`,
          value: entry.path,
          description: `${prefix}imported via @${from}`,
        })
      } else {
        out.push({
          label: relPath,
          value: entry.path,
          description: `${prefix.replace(/ · $/, '')}${loadedStateOf(entry)}`,
        })
      }
    }

    const listedPaths = [...files.map(entry => entry.path), ...listing.map(row => row.path)]
    const wasAttached = attached !== undefined ? held : undefined
    for (const row of [...listing, ...attachedRows(held, listedPaths, attached)]) {
      out.push({
        label: getRelativeInstructionFilePath(row.path),
        value: row.path,
        description: listingRowWords(row, '', held, wasAttached),
      })
    }

    if (!byPath.has(userPath)) {
      out.push({
        label: 'User memory (new)',
        value: userPath,
        description: toTildePath(userPath),
      })
    }
    if (!byPath.has(projectPath)) {
      out.push({
        label: 'Project memory (new)',
        value: projectPath,
        description: `will be written at ${getRelativeInstructionFilePath(projectPath)}`,
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
  const listLayout = useMemo(
    () => instructionFileListLayout(rows, width, listBudget, firstVisible),
    [rows, width, listBudget, firstVisible],
  )
  const options = useMemo(
    () => (listLayout.layout === 'compact-vertical' ? rows.map(row => ({ ...row, label: ` ${row.label}` })) : rows),
    [listLayout.layout, rows],
  )

  const handleChange = (value: string): void => {
    lastSelectedPath = value
    if (value.startsWith('::open:')) {
      setOpenError(openMemoryFolder(getMnemeHome(), undefined, setOpenError))
      return
    }
    setOpenError(null)
    onSelect(value)
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text inverse={focusedToggle === 0} bold={focusedToggle === 0}>
          Memory: {mnemeOn ? 'on' : 'off'}
        </Text>
      </Box>
      <Select
        {...listLayout}
        onVisibleWindowChange={from => setFirstVisible(from)}
        isDisabled={focusedToggle !== null}
        options={options}
        defaultFocusValue={defaultFocusValue}
        onChange={handleChange}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(TOGGLE_COUNT - 1)}
      />
      {openError !== null ? (
        <Text color={tokens.failureText} wrap="wrap">
          {openError}
        </Text>
      ) : null}
    </Box>
  )
}
