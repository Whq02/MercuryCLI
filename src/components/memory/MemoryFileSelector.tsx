// /memory files — the instruction-source picker plus the two persistent
// toggles. The source list comes from the shared discovery engine as a
// promise this component SUSPENDS on (the caller provides the Suspense
// boundary), so the picker has no loading state of its own.

import { mkdirSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { use, useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { isAutoDreamEnabled } from '../../services/autoDream/config.js'
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js'
import { getInstructionFiles } from '../../services/instructions/engine.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import { useAppState } from '../../state/AppState.js'
import { isDreamTask } from '../../tasks/DreamTask/DreamTask.js'
import {
  getAgentMemoryDir,
  getMemoryScopeDisplay,
} from '../../tools/AgentTool/agentMemory.js'
import { openPath } from '../../utils/browser.js'
import { getMemoryPath } from '../../utils/config.js'
import { projectIsInGitRepo } from '../../utils/memory/versions.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { toTildePath } from '../../utils/path.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { getRelativeMemoryPath } from './MemoryUpdateNotification.js'

// (The canonical user/project memory paths come from the ONE owner,
// getMemoryPath — never a spelled basename here.)

/** Process-lifetime selection memory. */
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
  // Suspends on the memoised discovery promise — stable identity, no
  // per-render re-suspension.
  const files = use(getInstructionFiles())

  useExitOnCtrlCDWithKeybindings()

  const [autoMemoryOn, setAutoMemoryOn] = useState(() => isAutoMemoryEnabled())
  const [autoDreamOn, setAutoDreamOn] = useState(() => isAutoDreamEnabled())
  // The dream row's visibility is latched AT MOUNT: toggling auto-memory off
  // does not remove it for the rest of this session.
  const [showDreamRow] = useState(() => isAutoMemoryEnabled())

  const dreamRunning = useAppState(state =>
    Object.values(state.tasks).some(
      task => isDreamTask(task) && task.status === 'running',
    ),
  )
  // null = not read yet (render nothing); 0 = never; else a timestamp.
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    void readLastConsolidatedAt().then(value => {
      if (live) setLastDreamAt(value)
    })
    return () => {
      live = false
    }
  }, [dreamRunning])

  const activeAgents = useAppState(
    state => state.agentDefinitions.activeAgents,
  )

  // Toggle focus: null = the list owns input; otherwise the focused index
  // into the toggle stack.
  const toggles: Array<{
    id: 'auto-memory' | 'auto-dream'
    flip: () => void
  }> = [
    {
      id: 'auto-memory',
      flip: () => {
        updateSettingsForSource('userSettings', {
          autoMemoryEnabled: !autoMemoryOn,
        })
        setAutoMemoryOn(value => !value)
      },
    },
    ...(showDreamRow
      ? [
          {
            id: 'auto-dream' as const,
            flip: () => {
              updateSettingsForSource('userSettings', {
                autoDreamEnabled: !autoDreamOn,
              })
              setAutoDreamOn(value => !value)
            },
          },
        ]
      : []),
  ]
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null)
  const toggleFocused = focusedToggle !== null

  useKeybinding(
    'select:previous',
    () => {
      // Walk up, stopping at the first toggle.
      setFocusedToggle(index => Math.max(0, (index ?? 0) - 1))
    },
    { context: 'Select', isActive: toggleFocused },
  )
  useKeybinding(
    'select:next',
    () => {
      // Walk down; past the last toggle, focus returns to the list.
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
    const visible = files.filter(
      entry => entry.type !== 'AutoMem' && entry.type !== 'TeamMem',
    )
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
        description:
          entry.origin === 'additional-dir'
            ? `${nativePrefix(entry)}from added directory ${toTildePath(entry.root ?? entry.path)}`
            : `${nativePrefix(entry)}${getRelativeMemoryPath(entry.path)}`,
      }
    })

    // The canonical compat entries appear even before they exist.
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
        label: 'Open auto-memory folder',
        value: '::open:automem',
        description: 'opens the folder in your file manager',
      })
      for (const agent of activeAgents) {
        if (!agent.memory) continue
        result.push({
          label: (
            <Text>
              <Text bold>{agent.agentType}</Text> memory
            </Text>
          ),
          value: `::open:agent:${agent.agentType}:${agent.memory}`,
          description: getMemoryScopeDisplay(agent.memory),
        })
      }
    }

    return result
  }, [files, autoMemoryOn, activeAgents])

  const preselect =
    lastSelectedPath !== null &&
    rows.some(row => row.value === lastSelectedPath)
      ? lastSelectedPath
      : rows[0]?.value

  const activate = (value: string) => {
    lastSelectedPath = value
    if (value.startsWith('::open:')) {
      const dir = value.startsWith('::open:agent:')
        ? (() => {
            const [, , , agentType, scope] = value.split(':')
            return getAgentMemoryDir(
              agentType ?? '',
              (scope ?? 'user') as 'user' | 'project' | 'local',
            )
          })()
        : getAutoMemPath()
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        // Creation failures are ignored; the open below still tries.
      }
      void openPath(dir)
      return
    }
    onSelect(value)
  }

  const dreamTail = dreamRunning
    ? ' · running'
    : lastDreamAt === null
      ? ''
      : lastDreamAt === 0
        ? ' · never'
        : ` · last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text
          bold={focusedToggle === 0}
          inverse={focusedToggle === 0}
        >
          Auto-memory: {autoMemoryOn ? 'on' : 'off'}
        </Text>
        {showDreamRow ? (
          <Text
            bold={focusedToggle === 1}
            inverse={focusedToggle === 1}
          >
            Auto-dream: {autoDreamOn ? 'on' : 'off'}
            {dreamTail}
          </Text>
        ) : null}
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
