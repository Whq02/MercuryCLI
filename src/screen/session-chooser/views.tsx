import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import React, { useRef } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { isTopOverlayNow, useRegisterOverlay } from '../overlays/overlayHooks.js'
import { useKeybindings } from '../keys/useKeybinding.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { SearchBox } from '../composer/text-input/SearchBox.js'
import { TagTabs } from './TagTabs.js'
import TextInput from '../composer/text-input/TextInput.js'
import { TreeSelect } from '../tree-select/TreeSelect.js'
import { Select } from '../select/index.js'
import type { useExitChordKeys } from '../keys/useExitChordKeys.js'
import type { useSearchInput } from '../composer/text-input/useSearchInput.js'
import { packFooter } from '../widgets/footerHint.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'

function EmptyLogList({
  emptyReasons,
  isDisabled,
  onCancel,
}: {
  emptyReasons: string[]
  isDisabled: boolean
  onCancel: (() => void) | undefined
}): React.ReactNode {
  const overlayToken = useRegisterOverlay('select', Boolean(onCancel), { ownsPageKeys: false })
  const tokenRef = useRef(overlayToken)
  tokenRef.current = overlayToken
  useKeybindings(
    {
      'select:cancel': () => {
        const token = tokenRef.current
        if (token === null || !isTopOverlayNow(token)) return false
        onCancel?.()
      },
    },
    { context: 'Select', isActive: !isDisabled && Boolean(onCancel) },
  )
  return (
    <Text dimColor>
      no sessions match{emptyReasons.length > 0 ? ` — ${emptyReasons.join(' · ')}` : ''}
    </Text>
  )
}

export function sessionBrowserView({
  grouped,
  emptyReasons,
  renaming,
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
}: {
  grouped: { log: SessionListing; children: SessionListing[] }[]
  emptyReasons: string[]
  renaming: boolean
  searchMode: boolean
  rowLabel: (log: SessionListing, kind: 'header' | 'child' | 'flat', forkCount: number) => string
  describeLogFitted: (log: SessionListing, withProjectPath: boolean, width: number) => string
  showAllProjects: boolean
  labelWidth: number
  MIN_LABEL_WIDTH: number
  visibleCount: number
  forceExpanded: boolean
  expanded: ReadonlySet<string>
  setExpanded: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>
  setFocusedLog: React.Dispatch<React.SetStateAction<SessionListing | null>>
  onSelect: (log: SessionListing) => void
  onCancel: (() => void) | undefined
  setSearchMode: React.Dispatch<React.SetStateAction<boolean>>
  tokens: MercuryThemeTokens
  tagTabs: string[]
  selectedTag: string | null
  columns: number
  positionSuffix: string
  query: string
  search: ReturnType<typeof useSearchInput>
  filterParts: string[]
  inRename: boolean
  renameValue: string
  setRenameValue: React.Dispatch<React.SetStateAction<string>>
  submitRename: (title: string) => void
  renameCursor: number
  setRenameCursor: React.Dispatch<React.SetStateAction<number>>
  exitState: ReturnType<typeof useExitChordKeys>
  hints: string[]
  expandHint: string | null
}): React.ReactNode {
  const listBody = grouped.length === 0 ? (
    <EmptyLogList emptyReasons={emptyReasons} isDisabled={searchMode} onCancel={onCancel} />
  ) : renaming ? (
    <TreeSelect<SessionListing>
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
          :
            packFooter(
              [...hints, ...(expandHint ? [expandHint] : [])].join(' · '),
              Math.max(0, columns - 4),
            )}
      </Text>
    </Box>
  )
}
