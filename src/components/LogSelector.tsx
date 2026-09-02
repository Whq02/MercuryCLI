// The session picker: one rounded card — brand row, tag
// tabs or title, search, filter line, grouped or flat list, hint row.
// Grouping, rename and preview are conditioned on custom titles being
// available. Worktree multiplicity arrives from a background promise and
// the input handler reads it through a REF — render state alone would
// swallow the first press of the toggle chord.

import { truncateToWidth } from '../utils/truncate.js'
import { exitChordNoticeText } from './PromptInput/ExitChordNotice.js'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { basename } from 'path'
import { Box, Text, useInput } from '../ink.js'
import type { LogOption } from '../types/logs.js'
import { getLogDisplayTitle } from '../utils/log.js'
import { SearchBox } from './SearchBox.js'
import { SessionPreview } from './SessionPreview.js'
import { TagTabs } from './TagTabs.js'
import TextInput from './TextInput.js'
import { type TreeNode, TreeSelect } from './ui/TreeSelect.js'
import { Select } from './CustomSelect/index.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { packFooter } from './mercury-ui/footerHint.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { getSessionId } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getWorktreePaths } from '../utils/getWorktreePaths.js'
import { formatLogMetadata } from '../utils/format.js'
import {
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../utils/sessionStorage.js'
import { logError } from '../utils/log.js'
import type { UUID } from 'crypto'

export type LogSelectorProps = {
  logs: LogOption[]
  maxHeight?: number
  forceWidth?: number
  onCancel?: () => void
  onSelect: (log: LogOption) => void
  onLogsChanged?: () => void
  /** The rename's IN-PLACE receipt — (sessionId,
   *  title) so the owner can patch the ONE row instead of tearing the
   *  whole picker down through a full reload. Preferred over onLogsChanged
   *  when both are wired. */
  onLogRenamed?: (sessionId: string, title: string) => void
  onLoadMore?: (count: number) => void
  initialSearchQuery?: string
  showAllProjects?: boolean
  onToggleAllProjects?: () => void
}

const MIN_LABEL_WIDTH = 8

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function displayTitle(log: LogOption): string {
  // the SHARED title owner (getLogDisplayTitle —
  // display-tag stripping, agentName/autonomous handling, the priority
  // /sessions uses) replaces the drifted local chain, so /resume and the
  // manager agree and raw wrapper markup never paints a row. The
  // whitespace collapse stays: picker rows are single-line.
  return collapseWhitespace(getLogDisplayTitle(log, '(no prompt)'))
}

function prDescriptor(log: LogOption): string {
  if (log.prNumber === undefined) return ''
  return `#${log.prNumber}${log.prRepository ? ` ${log.prRepository}` : ''}`
}

function truncateLabel(text: string, width: number): string {
  // C8 (PD-4): DISPLAY width, not code units — a CJK/emoji title measured
  // by .length admitted double its real cells and the row overflowed;
  // truncateToWidth is the estate's grapheme-aware owner (this file
  // already imports the width oracle's world).
  return truncateToWidth(text, Math.max(MIN_LABEL_WIDTH, width))
}

function hasMeaningfulEntry(log: LogOption): boolean {
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

function describeLog(log: LogOption, withProjectPath: boolean): string {
  // The ONE log-row grammar (formatLogMetadata — the `--resume <id>`
  // typeahead's formatter): size for lite rows, the real visible-message
  // count for fully-loaded ones, tag/agent/PR, the ended-on-error marker.
  // The picker's local variant claimed "0 messages" on every lite row — a
  // count the stat ladder never measures.
  const base = formatLogMetadata(log)
  return withProjectPath && log.projectPath ? `${base} · ${log.projectPath}` : base
}

/** C7 (SL-5): the metadata line was the one un-truncated string in the row
 *  grammar — a long branch or the ctrl+a project path wrapped and silently
 *  broke the picker's 3-rows-per-entry height budget. The description is
 *  cut to the same width budget the label wears, tail-first (the head
 *  carries the counts; the path's tail is the projectPath — kept by
 *  truncating the WHOLE line end-wise, the ellipsis naming the cut). */
function describeLogFitted(log: LogOption, withProjectPath: boolean, width: number): string {
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
  const [focusedLog, setFocusedLog] = useState<LogOption | null>(null)
  const [renameTarget, setRenameTarget] = useState<LogOption | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameCursor, setRenameCursor] = useState(0)
  const [previewLog, setPreviewLog] = useState<LogOption | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // Current branch, resolved in the background.
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getBranch(getCwd())
      .then(value => {
        if (!cancelled && value) setBranch(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Worktree multiplicity: a background promise; the CHORD handler reads
  // the ref (state is only for painting).
  const [multipleWorktrees, setMultipleWorktrees] = useState(false)
  const multipleWorktreesRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    getWorktreePaths(getOriginalCwd())
      .then(paths => {
        if (cancelled) return
        const multiple = paths.length > 1
        multipleWorktreesRef.current = multiple
        setMultipleWorktrees(multiple)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // ── search field ─────────────────────────────────────────────────────────
  // The query rides the shared single-line editor (useSearchInput): typing
  // extends it, readline editing and the kill ring work, and esc backs out
  // ONE level — clear the text, then leave search mode — never past the
  // picker. ctrl+n stays the advertised exit chord via passthrough; the list
  // below is input-disabled while the field is focused, so its own escape
  // (close the picker) can never fire from inside the field.
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

  // ── filters, in order ────────────────────────────────────────────────────
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

  // ── tags ─────────────────────────────────────────────────────────────────
  const tags = useMemo(() => {
    const set = new Set<string>()
    for (const log of logs) if (log.tag) set.add(log.tag)
    return [...set].sort()
  }, [logs])
  const tagTabs = tags.length > 0 ? ['all', ...tags] : []

  // ── grouping ─────────────────────────────────────────────────────────────
  const forceExpanded = query.trim() !== '' || branchFilter
  type Row = { log: LogOption; children: LogOption[] }
  const grouped: Row[] = useMemo(() => {
    if (!renaming) return searched.map(log => ({ log, children: [] }))
    const bySession = new Map<string, LogOption[]>()
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

  // ── layout budget ────────────────────────────────────────────────────────
  const headerLines =
    10 + (branchFilter || selectedTag !== null || (multipleWorktrees && !allWorktrees) || showAllProjects ? 1 : 0) + (tagTabs.length > 0 ? 1 : 0)
  const visibleCount =
    maxHeight === undefined
      ? Math.max(1, grouped.length)
      : Math.max(1, Math.floor((maxHeight - headerLines - 2) / 3))
  const labelWidth = Math.max(30, columns - 8)

  // ── load-more ────────────────────────────────────────────────────────────
  const focusedIndex = useMemo(
    () => grouped.findIndex(row => row.log === focusedLog),
    [grouped, focusedLog],
  )
  useEffect(() => {
    if (!onLoadMore) return
    if (focusedIndex >= 0 && focusedIndex + 2 * visibleCount >= grouped.length) {
      onLoadMore(3 * visibleCount)
    }
  }, [focusedIndex, visibleCount, grouped.length, onLoadMore])

  // ── chords ───────────────────────────────────────────────────────────────
  useInput(
    (input, key) => {
      if (inPreview || inRename) return
      if (searchMode) {
        // The field owns every key while focused; only the advertised exit
        // chord acts here (passed through by the editor).
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
        // The ref, not render state: the promise may have settled after
        // this handler's identity was captured.
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
      void saveCustomTitle(target.sessionId as UUID, trimmed, target.fullPath)
        .then(() => {
          // D7 (SL-3): the in-place patch when the owner offers it — the
          // full-reload fallback tore the picker down (spinner, selection,
          // scroll and search all lost) for a one-row title change.
          if (onLogRenamed !== undefined) onLogRenamed(String(target.sessionId), trimmed)
          else onLogsChanged?.()
        })
        .catch(logError)
    },
    [renameTarget, onLogsChanged, onLogRenamed],
  )
  useKeybinding('confirm:no', () => setRenameTarget(null), {
    context: 'Settings',
    isActive: inRename,
  })

  // No sessions at all: nothing to render (after every hook, so the hook
  // order never varies).
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

  // ── rows ─────────────────────────────────────────────────────────────────
  const rowLabel = (log: LogOption, kind: 'header' | 'child' | 'flat', forkCount: number): string => {
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
    hints.push('↑↓ select', '↵ resume', '/ search')
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

  // An honest empty state: filters/search that match nothing must say so —
  // bare chrome around an empty middle reads as a broken screen.
  const emptyReasons: string[] = [...filterParts]
  if (query.trim() !== '') emptyReasons.push(`search: ${query.trim()}`)
  const listBody = grouped.length === 0 ? (
    <Text dimColor>
      no sessions match{emptyReasons.length > 0 ? ` — ${emptyReasons.join(' · ')}` : ''}
    </Text>
  ) : renaming ? (
    <TreeSelect<LogOption>
      isDisabled={searchMode}
      nodes={grouped.map(row => ({
        id: row.log.sessionId ?? `path:${row.log.fullPath ?? row.log.value}`,
        value: row.log,
        label: rowLabel(row.log, row.children.length > 0 ? 'header' : 'flat', row.children.length),
        description: describeLogFitted(row.log, showAllProjects, labelWidth),
        dimDescription: true,
        children: row.children.map(child => ({
          id: `${child.sessionId}:${child.value}`,
          value: child,
          label: rowLabel(child, 'child', 0),
          description: `    ${describeLogFitted(child, showAllProjects, Math.max(MIN_LABEL_WIDTH, labelWidth - 4))}`,
          dimDescription: true,
        })),
      }))}
      visibleOptionCount={visibleCount}
      isNodeExpanded={nodeId =>
        forceExpanded || expanded.has(String(nodeId))
      }
      onExpand={nodeId =>
        setExpanded(previous => new Set([...previous, String(nodeId)]))
      }
      onCollapse={nodeId =>
        setExpanded(previous => {
          const next = new Set(previous)
          next.delete(String(nodeId))
          return next
        })
      }
      onFocus={node => setFocusedLog(node.value)}
      onSelect={node => onSelect(node.value)}
      onCancel={onCancel}
      onUpFromFirstItem={() => setSearchMode(true)}
    />
  ) : (
    <Select
      isDisabled={searchMode}
      options={grouped.map((row, index) => ({
        label: rowLabel(row.log, 'flat', 0),
        description: describeLogFitted(row.log, showAllProjects, labelWidth),
        value: String(index),
      }))}
      visibleOptionCount={visibleCount}
      onFocus={value => {
        const row = grouped[Number(value)]
        if (row) setFocusedLog(row.log)
      }}
      onChange={value => {
        const row = grouped[Number(value)]
        if (row) onSelect(row.log)
      }}
      onCancel={onCancel}
      onUpFromFirstItem={() => setSearchMode(true)}
    />
  )

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
    >
      <Text bold color={tokens.accent}>
        Mercury · resume
      </Text>
      <Box height={1} />
      {tagTabs.length > 0 ? (
        <TagTabs
          tabs={tagTabs.map((label, index) => ({ label, isAll: index === 0 }))}
          selectedIndex={selectedTag === null ? 0 : Math.max(0, tagTabs.indexOf(selectedTag))}
          availableWidth={columns - 4}
          showAllProjects={showAllProjects}
        />
      ) : (
        <Text bold>
          Select a session{positionSuffix}
        </Text>
      )}
      <SearchBox
        query={query}
        isFocused={searchMode}
        isTerminalFocused
        cursorOffset={search.cursorOffset}
        placeholder="Search sessions…"
        borderless
      />
      {filterParts.length > 0 ? (
        <Text dimColor>{filterParts.join(' · ')}</Text>
      ) : null}
      {inRename ? (
        <Box>
          <Text color={tokens.info}>Rename: </Text>
          <TextInput value={renameValue}
            onChange={setRenameValue}
            onSubmit={submitRename}
            columns={Math.max(20, columns - 12)}
            cursorOffset={renameCursor}
            onChangeCursorOffset={setRenameCursor}
          />
        </Box>
      ) : (
        listBody
      )}
      <Text dimColor>
        {exitState.pending
          ? exitChordNoticeText(exitState.keyName)
          : // packFooter: whole segments greedily to the width, the close
            // segment reserved — a narrow picker drops hints, never leaves a
            // dangling separator mid-wrap.
            packFooter(
              [...hints, ...(expandHint ? [expandHint] : [])].join(' · '),
              Math.max(0, columns - 4),
            )}
      </Text>
    </Box>
  )
}

export default LogSelector
