import { truncateToWidth } from '../../platform/text/truncate.js'
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLoad, usePublish } from '../effects/effects.js'
import { Box, Text, useInput } from '../themedRenderer.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { getListingDisplayTitle } from '../../platform/logs/errorLog.js'
import { SessionPreview } from './SessionPreview.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useExitChord } from '../keys/useExitChord.js'
import { useSearchInput } from '../composer/text-input/useSearchInput.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { getBranch } from '../../platform/git/git.js'
import { getCwd } from '../../platform/files/cwd.js'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { getWorktreePaths } from '../../platform/git/worktree/worktreePaths.js'
import { formatListingMetadata } from '../../platform/text/format.js'
import { collapseWhitespace } from '../../platform/text/strings.js'
import {
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../../sessions/transcripts/sessionStorage.js'
import { logError } from '../../platform/logs/errorLog.js'
import type { UUID } from 'crypto'
import { sessionBrowserView } from './views.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function commitListingRename(
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

type SessionBrowserProps = {
  logs: SessionListing[]
  maxHeight?: number
  forceWidth?: number
  onCancel?: () => void
  onSelect: (log: SessionListing) => void
  onLogsChanged?: () => void
  onLogRenamed?: (sessionId: string, customTitle: string) => void
  onLoadMore?: (count: number) => void
  initialSearchQuery?: string
  showAllProjects?: boolean
  onToggleAllProjects?: () => void
}

const MIN_LABEL_WIDTH = 8

function displayTitle(log: SessionListing): string {
  return collapseWhitespace(getListingDisplayTitle(log, '(no prompt)'))
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

function describeListing(log: SessionListing, withProjectPath: boolean): string {
  const base = formatListingMetadata(log)
  return withProjectPath && log.projectPath ? `${base} · ${log.projectPath}` : base
}

function describeListingFitted(log: SessionListing, withProjectPath: boolean, width: number): string {
  return truncateToWidth(describeListing(log, withProjectPath), Math.max(MIN_LABEL_WIDTH, width))
}

type ListingGroup = { log: SessionListing; children: SessionListing[] }

function keptByFilters(
  log: SessionListing,
  facts: {
    renaming: boolean
    selectedTag: string | null
    branchFilter: boolean
    currentBranch: string | null
    multipleWorktrees: boolean
    allWorktrees: boolean
  },
): boolean {
  if (facts.renaming && !hasMeaningfulEntry(log)) return false
  if (facts.selectedTag !== null && log.tag !== facts.selectedTag) return false
  if (facts.branchFilter && facts.currentBranch && log.gitBranch !== facts.currentBranch) return false
  if (
    facts.multipleWorktrees &&
    !facts.allWorktrees &&
    log.projectPath !== undefined &&
    log.projectPath !== getOriginalCwd()
  ) {
    return false
  }
  return true
}

function matchesQuery(log: SessionListing, needle: string): boolean {
  if (needle === '') return true
  return (
    displayTitle(log).toLowerCase().includes(needle) ||
    (log.gitBranch?.toLowerCase().includes(needle) ?? false) ||
    (log.tag?.toLowerCase().includes(needle) ?? false) ||
    prDescriptor(log).toLowerCase().includes(needle)
  )
}

function groupListings(logs: SessionListing[], renaming: boolean): ListingGroup[] {
  if (!renaming) return logs.map(log => ({ log, children: [] }))
  const groups: ListingGroup[] = []
  const bySession = new Map<string, SessionListing[]>()
  for (const log of logs) {
    if (log.sessionId === undefined) {
      groups.push({ log, children: [] })
      continue
    }
    const bucket = bySession.get(log.sessionId)
    if (bucket) bucket.push(log)
    else bySession.set(log.sessionId, [log])
  }
  for (const bucket of bySession.values()) {
    const [newest, ...rest] = [...bucket].sort((x, y) => y.modified.getTime() - x.modified.getTime())
    if (newest !== undefined) groups.push({ log: newest, children: rest })
  }
  return groups.sort((x, y) => y.log.modified.getTime() - x.log.modified.getTime())
}

function tagTabsOf(logs: SessionListing[]): string[] {
  const tags = [...new Set(logs.flatMap(log => (log.tag ? [log.tag] : [])))].sort()
  return tags.length > 0 ? ['all', ...tags] : []
}

function hintsOf(facts: {
  searchMode: boolean
  query: string
  hasToggleAllProjects: boolean
  multipleWorktrees: boolean
  renaming: boolean
  hasTagTabs: boolean
}): string[] {
  if (facts.searchMode) {
    return ['↵ to list', facts.query !== '' ? 'esc clear' : 'esc back', 'ctrl+n exit search']
  }
  return [
    '↑↓ select',
    'pgup/pgdn page',
    '↵ resume',
    '/ search',
    ...(facts.hasToggleAllProjects ? ['ctrl+a all projects'] : []),
    'ctrl+b branch',
    ...(facts.multipleWorktrees ? ['ctrl+w worktrees'] : []),
    ...(facts.renaming ? ['ctrl+r rename', 'ctrl+v preview'] : []),
    ...(facts.hasTagTabs ? ['tab tags'] : []),
    'esc close',
  ]
}

export function SessionBrowser({
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
}: SessionBrowserProps): React.ReactNode {
  const tokens = useMercuryTokens()
  const terminalSize = useTerminalSize()
  const columns = forceWidth ?? terminalSize.columns
  const renaming = isCustomTitleEnabled()

  const [searchMode, setSearchMode] = useState(() => Boolean(initialSearchQuery))
  const [branchFilter, setBranchFilter] = useState(false)
  const [allWorktrees, setAllWorktrees] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [focusedLog, setFocusedLog] = useState<SessionListing | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionListing | null>(null)
  const [previewLog, setPreviewLog] = useState<SessionListing | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameCursor, setRenameCursor] = useState(0)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [multipleWorktrees, setMultipleWorktrees] = useState(false)
  const multipleWorktreesRef = useRef(false)

  useLoad(signal => {
    void getBranch(getCwd())
      .then(branch => {
        if (branch && !signal.aborted) setCurrentBranch(branch)
      })
      .catch(passedOver)
    void getWorktreePaths(getOriginalCwd())
      .then(paths => {
        const multiple = paths.length > 1
        multipleWorktreesRef.current = multiple
        setMultipleWorktrees(multiple)
      })
      .catch(passedOver)
  }, [])

  const inRename = renameTarget !== null
  const inPreview = previewLog !== null

  const search = useSearchInput({
    isActive: searchMode && !inPreview && !inRename,
    onExit: () => setSearchMode(false),
    initialQuery: initialSearchQuery,
    passthroughCtrlKeys: ['n'],
    backspaceExitsOnEmpty: false,
  })
  const query = search.query
  const trimmedQuery = query.trim()

  const grouped = useMemo(() => {
    const facts = { renaming, selectedTag, branchFilter, currentBranch, multipleWorktrees, allWorktrees }
    const needle = trimmedQuery.toLowerCase()
    const searched = logs.filter(log => keptByFilters(log, facts) && matchesQuery(log, needle))
    return groupListings(searched, renaming)
  }, [logs, renaming, selectedTag, branchFilter, currentBranch, multipleWorktrees, allWorktrees, trimmedQuery])

  const tagTabs = useMemo(() => tagTabsOf(logs), [logs])
  const forceExpanded = trimmedQuery !== '' || branchFilter

  const headerLines =
    10 +
    (branchFilter || selectedTag !== null || (multipleWorktrees && !allWorktrees) || showAllProjects ? 1 : 0) +
    (tagTabs.length > 0 ? 1 : 0)
  const visibleCount = Math.max(
    1,
    maxHeight === undefined ? grouped.length : Math.floor((maxHeight - headerLines - 2) / 3),
  )
  const labelWidth = Math.max(30, columns - 8)

  const focusedIndex = grouped.findIndex(row => row.log === focusedLog)

  usePublish(() => {
    if (onLoadMore && focusedIndex >= 0 && focusedIndex + 2 * visibleCount >= grouped.length) {
      onLoadMore(3 * visibleCount)
    }
  }, [focusedIndex, visibleCount, grouped.length, onLoadMore])

  useInput((input, key) => {
    if (inPreview || inRename) return
    if (searchMode) {
      if (key.ctrl && input === 'n') setSearchMode(false)
      return
    }
    if (key.ctrl && input === 'a') {
      onToggleAllProjects?.()
    } else if (key.ctrl && input === 'b') {
      setBranchFilter(on => !on)
    } else if (key.ctrl && input === 'w') {
      if (multipleWorktreesRef.current) setAllWorktrees(on => !on)
    } else if (key.ctrl && input === 'r') {
      if (renaming && focusedLog !== null) {
        const title = focusedLog.customTitle ?? ''
        setRenameTarget(focusedLog)
        setRenameValue(title)
        setRenameCursor(title.length)
      }
    } else if (key.ctrl && input === 'v') {
      if (renaming && focusedLog !== null) setPreviewLog(focusedLog)
    } else if (key.tab) {
      if (tagTabs.length > 0) {
        const current = selectedTag === null ? 0 : Math.max(0, tagTabs.indexOf(selectedTag))
        const next = (current + (key.shift ? -1 : 1) + tagTabs.length) % tagTabs.length
        setSelectedTag(next === 0 ? null : (tagTabs[next] ?? null))
      }
    } else if (input === '/') {
      setSearchMode(true)
    } else if (input.length === 1 && input.trim() !== '' && !key.ctrl && !key.meta && focusedLog !== null) {
      setSearchMode(true)
      search.setQuery(input)
    }
  })

  const exitState = useExitChord(() => onCancel?.())

  const submitRename = useCallback(
    (title: string) => {
      const target = renameTarget
      setRenameTarget(null)
      const trimmed = title.trim()
      if (target === null || trimmed === '' || target.sessionId === undefined) return
      const sessionId = target.sessionId
      void commitListingRename(target, trimmed, {
        onRenamed: () => {
          if (onLogRenamed) onLogRenamed(String(sessionId), trimmed)
          else onLogsChanged?.()
        },
        onError: setRenameError,
      })
    },
    [renameTarget, onLogRenamed, onLogsChanged],
  )

  useKeybinding('confirm:no', () => setRenameTarget(null), { context: 'Settings', isActive: inRename })

  const rowLabel = useCallback(
    (log: SessionListing, kind: 'header' | 'child' | 'flat', forkCount: number): string => {
      const forked = kind === 'header' && forkCount > 0
      const prefixWidth = forked ? 2 : kind === 'child' ? 4 : 0
      const sidechain = log.isSidechain ? ' (sidechain)' : ''
      const forks = forked ? ` (+${forkCount})` : ''
      const room = labelWidth - prefixWidth - sidechain.length - forks.length
      return `${truncateLabel(displayTitle(log), room)}${sidechain}${forks}`
    },
    [labelWidth],
  )

  const filterParts = [
    ...(branchFilter && currentBranch ? [`branch: ${currentBranch}`] : []),
    ...(selectedTag !== null ? [`tag: ${selectedTag}`] : []),
    ...(multipleWorktrees && !allWorktrees ? ['this worktree'] : []),
    ...(showAllProjects ? ['all projects'] : []),
  ]
  const emptyReasons = trimmedQuery !== '' ? [...filterParts, `search: ${trimmedQuery}`] : filterParts
  const positionSuffix =
    grouped.length > visibleCount && focusedIndex >= 0 ? ` (${focusedIndex + 1}/${grouped.length})` : ''
  const hints = hintsOf({
    searchMode,
    query,
    hasToggleAllProjects: onToggleAllProjects !== undefined,
    multipleWorktrees,
    renaming,
    hasTagTabs: tagTabs.length > 0,
  })
  const focusedRow = focusedIndex >= 0 ? grouped[focusedIndex] : undefined
  const expandHint =
    renaming && focusedRow !== undefined && focusedRow.children.length > 0 && !forceExpanded
      ? expanded.has(String(focusedRow.log.sessionId))
        ? '← collapse'
        : '→ expand'
      : null

  if (logs.length === 0) return null
  if (previewLog !== null) {
    return <SessionPreview log={previewLog} onExit={() => setPreviewLog(null)} onSelect={onSelect} />
  }

  const view = sessionBrowserView({
    grouped,
    emptyReasons,
    renaming,
    searchMode,
    rowLabel,
    describeLogFitted: describeListingFitted,
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
    query,
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
