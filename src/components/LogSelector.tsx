
import { truncateToWidth } from '../utils/truncate.js'
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLoad, usePublish } from '../hooks/effects.js'
import { Box, Text, useInput } from '../ink.js'
import type { SessionListing } from '../types/logs.js'
import { getLogDisplayTitle } from '../utils/log.js'
import { SessionPreview } from './SessionPreview.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getSessionId } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getWorktreePaths } from '../utils/getWorktreePaths.js'
import { formatLogMetadata } from '../utils/format.js'
import { collapseWhitespace } from '../utils/stringUtils.js'
import {
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../utils/sessionStorage.js'
import { logError } from '../utils/log.js'
import type { UUID } from 'crypto'
import { logSelectorView } from './logSelector/views.js'
import { passedOver } from '../utils/passedOver.js'

export function commitLogRename(
  target: Pick<SessionListing, 'sessionId' | 'fullPath'>,
  trimmed: string,
  io: {
    save?: typeof saveCustomTitle
    onRenamed: () => void
    onError: (sentence: string | null) => void
  },
): Promise<void> {
  if (trimmed === '' || target.sessionId === undefined) return Promise.resolve()
  io.onError(null)
  return (io.save ?? saveCustomTitle)(target.sessionId as UUID, trimmed, target.fullPath)
    .then(() => {
      io.onRenamed()
    })
    .catch(error => {
      logError(error)
      io.onError(
        `Could not rename session (${error instanceof Error ? error.message : String(error)}) — press ctrl+r to try again`,
      )
    })
}

type LogSelectorProps = {
  logs: SessionListing[]
  maxHeight?: number
  forceWidth?: number
  onCancel?: () => void
  onSelect: (log: SessionListing) => void
  onLogsChanged?: () => void
  onLogRenamed?: (sessionId: string, title: string) => void
  onLoadMore?: (count: number) => void
  initialSearchQuery?: string
  showAllProjects?: boolean
  onToggleAllProjects?: () => void
}

const MIN_LABEL_WIDTH = 8

function displayTitle(log: SessionListing): string {
  return collapseWhitespace(getLogDisplayTitle(log, '(no prompt)'))
}

function prDescriptor(log: SessionListing): string {
  if (log.prNumber === undefined) return ''
  return `#${log.prNumber}${log.prRepository ? ` ${log.prRepository}` : ''}`
}

function truncateLabel(text: string, width: number): string {
  return truncateToWidth(text, Math.max(MIN_LABEL_WIDTH, width))
}

function hasMeaningfulEntry(log: SessionListing): boolean {
  if (log.sessionId !== undefined && log.sessionId === getSessionId()) {
    return true
  }
  if (log.customTitle) return true
  if (log.firstPrompt && log.firstPrompt.trim() !== '') return true
  return log.messages.some(
    message =>
      (message as { type?: string }).type === 'user' &&
      typeof (message as { message?: { content?: unknown } }).message
        ?.content === 'string',
  )
}

function describeLog(log: SessionListing, withProjectPath: boolean): string {
  const base = formatLogMetadata(log)
  return withProjectPath && log.projectPath ? `${base} · ${log.projectPath}` : base
}

function describeLogFitted(log: SessionListing, withProjectPath: boolean, width: number): string {
  return truncateToWidth(describeLog(log, withProjectPath), Math.max(MIN_LABEL_WIDTH, width))
}

export function LogSelector({
  logs,
  maxHeight,
  forceWidth,
  onCancel,
  onSelect,
  onLogsChanged,
  onLogRenamed,
  onLoadMore,
  initialSearchQuery,
  showAllProjects = false,
  onToggleAllProjects,
}: LogSelectorProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns: terminalColumns } = useTerminalSize()
  const columns = forceWidth ?? terminalColumns
  const renaming = isCustomTitleEnabled()

  const [searchMode, setSearchMode] = useState(Boolean(initialSearchQuery))
  const [branchFilter, setBranchFilter] = useState(false)
  const [allWorktrees, setAllWorktrees] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [focusedLog, setFocusedLog] = useState<SessionListing | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionListing | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameCursor, setRenameCursor] = useState(0)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [previewLog, setPreviewLog] = useState<SessionListing | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const [branch, setBranch] = useState<string | null>(null)
  useLoad(() => {
    let cancelled = false
    getBranch(getCwd())
      .then(value => {
        if (!cancelled && value) setBranch(value)
      })
      .catch(passedOver)
    return () => {
      cancelled = true
    }
  }, [])

  const [multipleWorktrees, setMultipleWorktrees] = useState(false)
  const multipleWorktreesRef = useRef(false)
  useLoad(() => {
    let cancelled = false
    getWorktreePaths(getOriginalCwd())
      .then(paths => {
        if (cancelled) return
        const multiple = paths.length > 1
        multipleWorktreesRef.current = multiple
        setMultipleWorktrees(multiple)
      })
      .catch(passedOver)
    return () => {
      cancelled = true
    }
  }, [])

  const inPreview = previewLog !== null
  const inRename = renameTarget !== null
  const search = useSearchInput({
    isActive: searchMode && !inPreview && !inRename,
    onExit: () => setSearchMode(false),
    initialQuery: initialSearchQuery,
    passthroughCtrlKeys: ['n'],
    backspaceExitsOnEmpty: false,
  })
  const query = search.query

  const filtered = useMemo(() => {
    let result = logs
    if (renaming) result = result.filter(hasMeaningfulEntry)
    if (selectedTag !== null) {
      result = result.filter(log => log.tag === selectedTag)
    }
    if (branchFilter && branch !== null) {
      result = result.filter(log => log.gitBranch === branch)
    }
    if (multipleWorktrees && !allWorktrees) {
      const cwd = getOriginalCwd()
      result = result.filter(
        log => log.projectPath === undefined || log.projectPath === cwd,
      )
    }
    return result
  }, [logs, renaming, selectedTag, branchFilter, branch, multipleWorktrees, allWorktrees])

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return filtered
    return filtered.filter(log => {
      if (displayTitle(log).toLowerCase().includes(q)) return true
      if (log.gitBranch && log.gitBranch.toLowerCase().includes(q)) return true
      if (log.tag && log.tag.toLowerCase().includes(q)) return true
      return prDescriptor(log).toLowerCase().includes(q)
    })
  }, [filtered, query])

  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const log of logs) if (log.tag) set.add(log.tag)
    return [...set].sort()
  }, [logs])
  const tagTabs = tags.length > 0 ? ['all', ...tags] : []

  const forceExpanded = query.trim() !== '' || branchFilter
  type Row = { log: SessionListing; children: SessionListing[] }
  const grouped: Row[] = useMemo(() => {
    if (!renaming) return searched.map(log => ({ log, children: [] }))
    const bySession = new Map<string, SessionListing[]>()
    const singles: Row[] = []
    for (const log of searched) {
      if (log.sessionId === undefined) {
        singles.push({ log, children: [] })
        continue
      }
      const group = bySession.get(log.sessionId)
      if (group) group.push(log)
      else bySession.set(log.sessionId, [log])
    }
    const rows: Row[] = [...singles]
    for (const group of bySession.values()) {
      const sorted = [...group].sort(
        (a, b) => b.modified.getTime() - a.modified.getTime(),
      )
      rows.push({ log: sorted[0]!, children: sorted.slice(1) })
    }
    rows.sort((a, b) => b.log.modified.getTime() - a.log.modified.getTime())
    return rows
  }, [searched, renaming])

  const headerLines =
    10 + (branchFilter || selectedTag !== null || (multipleWorktrees && !allWorktrees) || showAllProjects ? 1 : 0) + (tagTabs.length > 0 ? 1 : 0)
  const visibleCount =
    maxHeight === undefined
      ? Math.max(1, grouped.length)
      : Math.max(1, Math.floor((maxHeight - headerLines - 2) / 3))
  const labelWidth = Math.max(30, columns - 8)

  const focusedIndex = useMemo(
    () => grouped.findIndex(row => row.log === focusedLog),
    [grouped, focusedLog],
  )
  usePublish(() => {
    if (!onLoadMore) return
    if (focusedIndex >= 0 && focusedIndex + 2 * visibleCount >= grouped.length) {
      onLoadMore(3 * visibleCount)
    }
  }, [focusedIndex, visibleCount, grouped.length, onLoadMore])

  useInput(
    (input, key) => {
      if (inPreview || inRename) return
      if (searchMode) {
        if (key.ctrl && input === 'n') setSearchMode(false)
        return
      }
      if (key.ctrl && input === 'a') {
        onToggleAllProjects?.()
        return
      }
      if (key.ctrl && input === 'b') {
        setBranchFilter(previous => !previous)
        return
      }
      if (key.ctrl && input === 'w') {
        if (multipleWorktreesRef.current) {
          setAllWorktrees(previous => !previous)
        }
        return
      }
      if (renaming && key.ctrl && input === 'r') {
        if (focusedLog) {
          setRenameTarget(focusedLog)
          setRenameValue(focusedLog.customTitle ?? '')
          setRenameCursor((focusedLog.customTitle ?? '').length)
        }
        return
      }
      if (renaming && key.ctrl && input === 'v') {
        if (focusedLog) setPreviewLog(focusedLog)
        return
      }
      if (key.tab && tagTabs.length > 0) {
        const currentIndex =
          selectedTag === null ? 0 : Math.max(0, tagTabs.indexOf(selectedTag))
        const nextIndex = key.shift
          ? (currentIndex - 1 + tagTabs.length) % tagTabs.length
          : (currentIndex + 1) % tagTabs.length
        setSelectedTag(nextIndex === 0 ? null : tagTabs[nextIndex]!)
        return
      }
      if (input === '/') {
        setSearchMode(true)
        return
      }
      if (
        input.length === 1 &&
        input.trim() !== '' &&
        !key.ctrl &&
        !key.meta &&
        focusedLog
      ) {
        setSearchMode(true)
        search.setQuery(input)
      }
    },
    { isActive: true },
  )

  const exitState = useExitOnCtrlCDWithKeybindings(() => onCancel?.())

  const submitRename = useCallback(
    (title: string) => {
      const trimmed = title.trim()
      const target = renameTarget
      setRenameTarget(null)
      if (!target || trimmed === '' || target.sessionId === undefined) return
      void commitLogRename(target, trimmed, {
        onRenamed: () => {
          if (onLogRenamed !== undefined) onLogRenamed(String(target.sessionId), trimmed)
          else onLogsChanged?.()
        },
        onError: setRenameError,
      })
    },
    [renameTarget, onLogsChanged, onLogRenamed],
  )
  useKeybinding('confirm:no', () => setRenameTarget(null), {
    context: 'Settings',
    isActive: inRename,
  })

  if (logs.length === 0) return null

  if (inPreview && previewLog) {
    return (
      <SessionPreview
        log={previewLog}
        onExit={() => setPreviewLog(null)}
        onSelect={onSelect}
      />
    )
  }

  const rowLabel = (log: SessionListing, kind: 'header' | 'child' | 'flat', forkCount: number): string => {
    const prefixWidth = kind === 'header' && forkCount > 0 ? 2 : kind === 'child' ? 4 : 0
    const sidechainSuffix = log.isSidechain ? ' (sidechain)' : ''
    const forkSuffix = kind === 'header' && forkCount > 0 ? ` (+${forkCount})` : ''
    const budget = labelWidth - prefixWidth - sidechainSuffix.length - forkSuffix.length
    return `${truncateLabel(displayTitle(log), budget)}${sidechainSuffix}${forkSuffix}`
  }

  const filterParts: string[] = []
  if (branchFilter && branch !== null) filterParts.push(`branch: ${branch}`)
  if (selectedTag !== null) filterParts.push(`tag: ${selectedTag}`)
  if (multipleWorktrees && !allWorktrees) filterParts.push('this worktree')
  if (showAllProjects) filterParts.push('all projects')

  const positionSuffix =
    grouped.length > visibleCount && focusedIndex >= 0
      ? ` (${focusedIndex + 1}/${grouped.length})`
      : ''

  const focusedRow = focusedIndex >= 0 ? grouped[focusedIndex] : undefined
  const focusedGroupSize = focusedRow ? focusedRow.children.length + 1 : 0

  const hints: string[] = []
  if (searchMode) {
    hints.push('↵ to list', query !== '' ? 'esc clear' : 'esc back', 'ctrl+n exit search')
  } else {
    hints.push('↑↓ select', 'pgup/pgdn page', '↵ resume', '/ search')
    if (onToggleAllProjects) hints.push('ctrl+a all projects')
    hints.push('ctrl+b branch')
    if (multipleWorktrees) hints.push('ctrl+w worktrees')
    if (renaming) hints.push('ctrl+r rename', 'ctrl+v preview')
    if (tagTabs.length > 0) hints.push('tab tags')
    hints.push('esc close')
  }
  const expandHint =
    renaming && focusedRow && focusedGroupSize > 1 && !forceExpanded
      ? expanded.has(String(focusedRow.log.sessionId))
        ? '← collapse'
        : '→ expand'
      : null

  const emptyReasons: string[] = [...filterParts]
  if (query.trim() !== '') emptyReasons.push(`search: ${query.trim()}`)
  const view = logSelectorView({ grouped, emptyReasons, renaming, searchMode, rowLabel, describeLogFitted, showAllProjects, labelWidth, MIN_LABEL_WIDTH, visibleCount, forceExpanded, expanded, setExpanded, setFocusedLog, onSelect, onCancel, setSearchMode, tokens, tagTabs, selectedTag, columns, positionSuffix, query, search, filterParts, inRename, renameValue, setRenameValue, submitRename, renameCursor, setRenameCursor, exitState, hints, expandHint })
  if (renameError === null) return view
  return (
    <Box flexDirection="column">
      {view}
      <Text color={tokens.warning}>{renameError}</Text>
    </Box>
  )
}

export default LogSelector
