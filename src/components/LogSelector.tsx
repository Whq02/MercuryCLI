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
  onSelect: (log: SessionListing) => void
  onCancel?: () => void
  maxHeight?: number
  forceWidth?: number
  initialSearchQuery?: string
  showAllProjects?: boolean
  onToggleAllProjects?: () => void
  onLogsChanged?: () => void
  onLogRenamed?: (sessionId: string, customTitle: string) => void
  onLoadMore?: (count: number) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  worktreePaths?: string[]
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
      message.type === 'user' && typeof message.message.content === 'string',
  )
}

function describeLog(log: SessionListing, withProjectPath: boolean): string {
  const base = formatLogMetadata(log)
  return withProjectPath && log.projectPath ? `${base} · ${log.projectPath}` : base
}

function describeLogFitted(log: SessionListing, withProjectPath: boolean, width: number): string {
  return truncateToWidth(describeLog(log, withProjectPath), Math.max(MIN_LABEL_WIDTH, width))
}

type LogGroup = { log: SessionListing; children: SessionListing[] }

function modifiedMs(log: SessionListing): number {
  return log.modified instanceof Date ? log.modified.getTime() : 0
}

function matchesSearchQuery(log: SessionListing, needle: string): boolean {
  if (displayTitle(log).toLowerCase().includes(needle)) return true
  if (log.gitBranch && log.gitBranch.toLowerCase().includes(needle)) return true
  if (log.tag && log.tag.toLowerCase().includes(needle)) return true
  const pr = prDescriptor(log)
  if (pr !== '' && pr.toLowerCase().includes(needle)) return true
  return false
}

function filterAndGroupLogs(params: {
  logs: SessionListing[]
  customTitlesEnabled: boolean
  selectedTag: string | null
  branchFilter: boolean
  currentBranch: string | null
  filterByWorktree: boolean
  currentCwd: string
  originalCwd: string
  query: string
}): LogGroup[] {
  const needle = params.query.trim().toLowerCase()
  const filtered = params.logs.filter(log => {
    if (params.customTitlesEnabled && !hasMeaningfulEntry(log)) return false
    if (params.selectedTag !== null && log.tag !== params.selectedTag) return false
    if (params.branchFilter && params.currentBranch && log.gitBranch !== params.currentBranch) {
      return false
    }
    if (
      params.filterByWorktree &&
      log.projectPath !== undefined &&
      log.projectPath !== '' &&
      log.projectPath !== params.currentCwd &&
      log.projectPath !== params.originalCwd
    ) {
      return false
    }
    if (needle !== '' && !matchesSearchQuery(log, needle)) return false
    return true
  })

  if (!params.customTitlesEnabled) {
    return filtered.map(log => ({ log, children: [] }))
  }

  const bySession = new Map<string, SessionListing[]>()
  const singles: SessionListing[] = []
  for (const log of filtered) {
    if (log.sessionId !== undefined && log.sessionId !== '') {
      const bucket = bySession.get(log.sessionId)
      if (bucket) bucket.push(log)
      else bySession.set(log.sessionId, [log])
    } else {
      singles.push(log)
    }
  }

  const groups: LogGroup[] = []
  for (const bucket of bySession.values()) {
    const sorted = [...bucket].sort((a, b) => modifiedMs(b) - modifiedMs(a))
    groups.push({ log: sorted[0]!, children: sorted.slice(1) })
  }
  for (const log of singles) {
    groups.push({ log, children: [] })
  }
  groups.sort((a, b) => modifiedMs(b.log) - modifiedMs(a.log))
  return groups
}

function buildHints(params: {
  searchMode: boolean
  showAllProjects: boolean
  hasToggleAllProjects: boolean
  currentBranch: string | null
  branchFilter: boolean
  hasMultipleWorktrees: boolean
  allWorktrees: boolean
  canRename: boolean
  hasFocus: boolean
  hasTagTabs: boolean
}): string[] {
  const hints: string[] = [
    '↑↓ move',
    'pgup/pgdn page',
    '↵ resume',
    params.searchMode ? 'ctrl+n list' : '/ search',
  ]
  if (params.hasToggleAllProjects) {
    hints.push(params.showAllProjects ? 'ctrl+a this project' : 'ctrl+a all projects')
  }
  if (params.currentBranch) {
    hints.push(params.branchFilter ? 'ctrl+b all branches' : 'ctrl+b branch')
  }
  if (params.hasMultipleWorktrees) {
    hints.push(params.allWorktrees ? 'ctrl+w this worktree' : 'ctrl+w all worktrees')
  }
  if (params.canRename) {
    hints.push('ctrl+r rename')
  }
  if (params.hasFocus) {
    hints.push('ctrl+v preview')
  }
  if (params.hasTagTabs) {
    hints.push('tab tags')
  }
  hints.push('esc close')
  return hints
}

function collectTagTabs(logs: SessionListing[]): string[] {
  const unique = new Set<string>()
  for (const log of logs) {
    if (log.tag) unique.add(log.tag)
  }
  return unique.size === 0 ? [] : ['all', ...[...unique].sort()]
}

function flattenVisibleLogs(
  grouped: LogGroup[],
  forceExpanded: boolean,
  expanded: ReadonlySet<string>,
): SessionListing[] {
  const flat: SessionListing[] = []
  for (const group of grouped) {
    flat.push(group.log)
    if (
      group.children.length > 0 &&
      (forceExpanded || (group.log.sessionId !== undefined && expanded.has(group.log.sessionId)))
    ) {
      flat.push(...group.children)
    }
  }
  return flat
}

function useLogSelectorKeys(params: {
  inPreview: boolean
  inRename: boolean
  searchMode: boolean
  currentBranch: string | null
  hasMultipleWorktrees: boolean
  customTitlesEnabled: boolean
  activeFocusedLog: SessionListing | null
  tagTabs: string[]
  selectedTag: string | null
  onToggleAllProjects?: () => void
  cancelRename: () => void
  setSearchMode: React.Dispatch<React.SetStateAction<boolean>>
  setBranchFilter: React.Dispatch<React.SetStateAction<boolean>>
  setAllWorktrees: React.Dispatch<React.SetStateAction<boolean>>
  setSelectedTag: React.Dispatch<React.SetStateAction<string | null>>
  setPreviewLog: React.Dispatch<React.SetStateAction<SessionListing | null>>
  openRename: (target: SessionListing) => void
  setSearchQuery: (value: string) => void
}): void {
  useInput(
    (input, key) => {
      if (params.inPreview) return
      if (params.inRename) {
        if (key.escape) params.cancelRename()
        return
      }
      if (key.ctrl && input === 'n') {
        if (params.searchMode) params.setSearchMode(false)
        return
      }
      if (key.ctrl && input === 'a') {
        params.onToggleAllProjects?.()
        return
      }
      if (key.ctrl && input === 'b') {
        if (params.currentBranch) params.setBranchFilter(prev => !prev)
        return
      }
      if (key.ctrl && input === 'w') {
        if (params.hasMultipleWorktrees) params.setAllWorktrees(prev => !prev)
        return
      }
      if (key.ctrl && input === 'r') {
        if (
          params.activeFocusedLog &&
          params.customTitlesEnabled &&
          params.activeFocusedLog.sessionId !== undefined
        ) {
          params.openRename(params.activeFocusedLog)
        }
        return
      }
      if (key.ctrl && input === 'v') {
        if (params.activeFocusedLog) {
          params.setPreviewLog(params.activeFocusedLog)
          params.setSearchMode(false)
        }
        return
      }
      if (key.tab && !params.searchMode && params.tagTabs.length > 1) {
        const currentTab = params.selectedTag ?? 'all'
        const idx = params.tagTabs.indexOf(currentTab)
        const step = key.shift ? -1 : 1
        const nextTab =
          params.tagTabs[(idx + step + params.tagTabs.length) % params.tagTabs.length]!
        params.setSelectedTag(nextTab === 'all' ? null : nextTab)
        return
      }
      if (!params.searchMode && !key.ctrl && !key.meta) {
        if (input === '/') {
          params.setSearchMode(true)
          return
        }
        if (
          input.length === 1 &&
          input.charCodeAt(0) > 32 &&
          input.charCodeAt(0) !== 127 &&
          params.activeFocusedLog !== null
        ) {
          params.setSearchQuery(input)
          params.setSearchMode(true)
        }
      }
    },
    { isActive: !params.inPreview },
  )
}

export function LogSelector({
  logs,
  onSelect,
  onCancel,
  maxHeight,
  forceWidth,
  initialSearchQuery,
  showAllProjects = false,
  onToggleAllProjects,
  onLogsChanged,
  onLogRenamed,
  onLoadMore,
  hasMore,
  isLoadingMore,
  worktreePaths: worktreePathsProp,
}: LogSelectorProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const terminalSize = useTerminalSize()
  const columns = forceWidth ?? terminalSize.columns
  const customTitlesEnabled = isCustomTitleEnabled()

  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [loadedWorktrees, setLoadedWorktrees] = useState<string[]>(() => worktreePathsProp ?? [])
  const [branchFilter, setBranchFilter] = useState(false)
  const [allWorktrees, setAllWorktrees] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [searchMode, setSearchMode] = useState<boolean>(
    () => Boolean(initialSearchQuery && initialSearchQuery.length > 0),
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedLog, setFocusedLog] = useState<SessionListing | null>(() => logs[0] ?? null)
  const [previewLog, setPreviewLog] = useState<SessionListing | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionListing | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameCursor, setRenameCursor] = useState(0)
  const [renameError, setRenameError] = useState<string | null>(null)
  const lastLoadMoreLenRef = useRef<number>(-1)

  useLoad(signal => {
    void getBranch(getCwd())
      .then(branch => {
        if (!signal.aborted && branch) setCurrentBranch(branch)
      })
      .catch(passedOver)
    if (worktreePathsProp === undefined) {
      void getWorktreePaths(getOriginalCwd())
        .then(paths => {
          if (!signal.aborted) setLoadedWorktrees(paths)
        })
        .catch(passedOver)
    }
  }, [worktreePathsProp])

  const worktrees =
    worktreePathsProp !== undefined && worktreePathsProp.length > 0
      ? worktreePathsProp
      : loadedWorktrees
  const hasMultipleWorktrees = worktrees.length > 1
  const inRename = renameTarget !== null
  const inPreview = previewLog !== null

  const search = useSearchInput({
    isActive: searchMode && !inRename && !inPreview,
    initialQuery: initialSearchQuery ?? '',
    backspaceExitsOnEmpty: false,
    columns: Math.max(MIN_LABEL_WIDTH, columns - 10),
    passthroughCtrlKeys: ['a', 'b', 'w', 'n', 'r', 'v'],
    onExit: () => setSearchMode(false),
    onCancel: () => setSearchMode(false),
  })

  const tagTabs = useMemo(() => collectTagTabs(logs), [logs])
  const filterParts = useMemo(() => {
    const parts: string[] = []
    if (branchFilter && currentBranch) parts.push(`branch: ${currentBranch}`)
    if (selectedTag !== null) parts.push(`tag: ${selectedTag}`)
    if (showAllProjects) parts.push('all projects')
    if (hasMultipleWorktrees && allWorktrees) parts.push('all worktrees')
    return parts
  }, [branchFilter, currentBranch, selectedTag, showAllProjects, hasMultipleWorktrees, allWorktrees])

  const filterByWorktree = hasMultipleWorktrees && !allWorktrees && !showAllProjects
  const currentCwd = getCwd()
  const originalCwd = getOriginalCwd()

  const grouped = useMemo(
    () =>
      filterAndGroupLogs({
        logs,
        customTitlesEnabled,
        selectedTag,
        branchFilter,
        currentBranch,
        filterByWorktree,
        currentCwd,
        originalCwd,
        query: search.query,
      }),
    [logs, customTitlesEnabled, selectedTag, branchFilter, currentBranch, filterByWorktree, currentCwd, originalCwd, search.query],
  )

  const forceExpanded = search.query.trim() !== '' || branchFilter
  const visibleLogs = useMemo(
    () => flattenVisibleLogs(grouped, forceExpanded, expanded),
    [grouped, forceExpanded, expanded],
  )

  const headerBudget = 10 + (filterParts.length > 0 ? 1 : 0) + (tagTabs.length > 0 ? 1 : 0)
  const visibleCount = Math.max(1, Math.floor(((maxHeight ?? terminalSize.rows) - headerBudget - 2) / 3))

  const activeFocusedLog =
    focusedLog !== null && visibleLogs.includes(focusedLog) ? focusedLog : (visibleLogs[0] ?? null)
  const focusedIndex = activeFocusedLog !== null ? visibleLogs.indexOf(activeFocusedLog) : -1

  usePublish(() => {
    if (!onLoadMore || hasMore === false || isLoadingMore || visibleLogs.length === 0 || focusedIndex < 0) return
    if (visibleLogs.length - 1 - focusedIndex <= 2 * visibleCount && lastLoadMoreLenRef.current !== logs.length) {
      lastLoadMoreLenRef.current = logs.length
      onLoadMore(3 * visibleCount)
    }
  }, [onLoadMore, hasMore, isLoadingMore, visibleLogs.length, focusedIndex, visibleCount, logs.length])

  const cancelRename = useCallback(() => {
    setRenameTarget(null)
    setRenameError(null)
  }, [])

  const openRename = useCallback((target: SessionListing) => {
    const initial = target.customTitle ?? ''
    setRenameTarget(target)
    setRenameError(null)
    setRenameValue(initial)
    setRenameCursor(initial.length)
    setSearchMode(false)
  }, [])

  useKeybinding('confirm:no', cancelRename, { context: 'Settings', isActive: inRename })

  const submitRename = useCallback(
    (title: string) => {
      const target = renameTarget
      const trimmed = title.trim()
      setRenameTarget(null)
      if (target === null || trimmed === '') return
      void commitLogRename(target, trimmed, {
        onRenamed: () => {
          if (target.sessionId !== undefined) onLogRenamed?.(target.sessionId, trimmed)
          onLogsChanged?.()
        },
        onError: setRenameError,
      })
    },
    [renameTarget, onLogRenamed, onLogsChanged],
  )

  useLogSelectorKeys({
    inPreview,
    inRename,
    searchMode,
    currentBranch,
    hasMultipleWorktrees,
    customTitlesEnabled,
    activeFocusedLog,
    tagTabs,
    selectedTag,
    onToggleAllProjects,
    cancelRename,
    setSearchMode,
    setBranchFilter,
    setAllWorktrees,
    setSelectedTag,
    setPreviewLog,
    openRename,
    setSearchQuery: search.setQuery,
  })

  const exitState = useExitOnCtrlCDWithKeybindings(onCancel, undefined, !inRename && !inPreview)
  const labelWidth = Math.max(MIN_LABEL_WIDTH, columns - 8)
  const rowLabel = useCallback(
    (log: SessionListing, kind: 'header' | 'child' | 'flat', forkCount: number): string => {
      const suffix = kind === 'header' && forkCount > 0 ? ` (+${forkCount})` : ''
      return truncateLabel(`${displayTitle(log)}${suffix}`, labelWidth)
    },
    [labelWidth],
  )

  const emptyReasons = useMemo(() => {
    const reasons: string[] = []
    if (search.query.trim() !== '') reasons.push(`query "${search.query.trim()}"`)
    if (branchFilter && currentBranch) reasons.push(`branch ${currentBranch}`)
    if (selectedTag !== null) reasons.push(`tag ${selectedTag}`)
    if (filterByWorktree) reasons.push('current worktree (ctrl+w for all)')
    return reasons
  }, [search.query, branchFilter, currentBranch, selectedTag, filterByWorktree])

  const expandHint = useMemo(() => {
    if (activeFocusedLog === null || forceExpanded) return null
    const group = grouped.find(g => g.log === activeFocusedLog)
    if (!group || group.children.length === 0) return null
    return group.log.sessionId !== undefined && expanded.has(group.log.sessionId)
      ? '← collapse'
      : '→ expand'
  }, [activeFocusedLog, forceExpanded, grouped, expanded])

  const positionSuffix =
    visibleLogs.length > 0 && focusedIndex >= 0
      ? ` (${focusedIndex + 1}/${visibleLogs.length}${hasMore ? '+' : ''})`
      : isLoadingMore
        ? ' (loading…)'
        : ''

  const hints = useMemo(
    () =>
      buildHints({
        searchMode,
        showAllProjects,
        hasToggleAllProjects: Boolean(onToggleAllProjects),
        currentBranch,
        branchFilter,
        hasMultipleWorktrees,
        allWorktrees,
        canRename: Boolean(activeFocusedLog && customTitlesEnabled && activeFocusedLog.sessionId !== undefined),
        hasFocus: activeFocusedLog !== null,
        hasTagTabs: tagTabs.length > 1,
      }),
    [searchMode, showAllProjects, onToggleAllProjects, currentBranch, branchFilter, hasMultipleWorktrees, allWorktrees, activeFocusedLog, customTitlesEnabled, tagTabs.length],
  )

  if (logs.length === 0) return null
  if (previewLog !== null) {
    return (
      <SessionPreview
        log={previewLog}
        onExit={() => setPreviewLog(null)}
        onSelect={log => {
          setPreviewLog(null)
          onSelect(log)
        }}
      />
    )
  }

  const view = logSelectorView({
    grouped,
    emptyReasons,
    renaming: inRename,
    searchMode,
    rowLabel,
    describeLogFitted,
    showAllProjects,
    labelWidth,
    MIN_LABEL_WIDTH,
    visibleCount,
    forceExpanded,
    expanded,
    setExpanded,
    setFocusedLog,
    onSelect,
    onCancel,
    setSearchMode,
    tokens,
    tagTabs,
    selectedTag,
    columns,
    positionSuffix,
    query: search.query,
    search,
    filterParts,
    inRename,
    renameValue,
    setRenameValue,
    submitRename,
    renameCursor,
    setRenameCursor,
    exitState,
    hints,
    expandHint,
  })

  if (renameError === null) return view
  return (
    <Box flexDirection="column">
      {view}
      <Text color={tokens.warning}>{renameError}</Text>
    </Box>
  )
}

export default LogSelector
