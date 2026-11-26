import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { usePrStatus } from './usePrStatus.js'
import type { AppState } from '../app-state/AppState.js'
import { requestCommandDispatch } from '../cockpit/helmFocus.js'
import { isFullscreenActive } from '../fullscreen-layout/fullscreen.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { PrBadge } from './PrBadge.js'
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js'
import { NoticeWords } from './Notifications.js'

export function footerClusterOf({
  tokens,
  columns,
  footerSelection,
  paletteChord,
  noticeText,
  noticeDetail,
  noticeWayOut,
  noticeBlock,
  blockRows,
  prStatus,
  viewingCrewmate,
  showPrBadge,
  showTasksPill,
  parts,
  noticeStands,
  hintsShow,
  idleHintShows,
  rowHasContent,
  searchField,
  vimInsert,
  isLoading,
  crewmateFooterIndex,
  onOpenTasksDialog,
}: {
  tokens: ReturnType<typeof useMercuryTokens>
  columns: number
  footerSelection: AppState['footerSelection']
  paletteChord: string
  noticeText: React.ReactNode | null
  noticeDetail: React.ReactNode | null
  noticeWayOut: React.ReactNode | null
  noticeBlock: React.ReactNode | null
  blockRows: number
  prStatus: ReturnType<typeof usePrStatus>
  viewingCrewmate: boolean
  showPrBadge: boolean
  showTasksPill: boolean
  parts: React.ReactNode[]
  noticeStands: boolean
  hintsShow: boolean
  idleHintShows: boolean
  rowHasContent: boolean
  searchField: React.ReactNode | undefined
  vimInsert: boolean
  isLoading: boolean
  crewmateFooterIndex: number | undefined
  onOpenTasksDialog: (() => void) | undefined
}): React.ReactNode {
  const cluster = (
    <Box
      flexDirection="row"
      height={isFullscreenActive() ? Math.max(1, noticeStands ? blockRows : 0) : undefined}
      overflow="hidden"
    >
      {searchField ?? null}
      {vimInsert && searchField === undefined ? (
        <Box flexShrink={0} marginRight={1}>
          <Text bold color={tokens.warning}>
            INSERT
          </Text>
        </Box>
      ) : null}
      {showTasksPill ? (
        <Box flexShrink={0} marginRight={1}>
          <BackgroundTaskStatus
            tasksSelected={footerSelection === 'tasks'}
            isViewingCrewmate={viewingCrewmate}
            crewmateFooterIndex={crewmateFooterIndex}
            isLeaderIdle={!isLoading}
            onOpenDialog={onOpenTasksDialog}
          />
        </Box>
      ) : null}
      {showPrBadge ? (
        <Box flexShrink={0} marginRight={1}>
          <PrBadge
            number={prStatus.number as number}
            url={prStatus.url ?? undefined}
            reviewState={prStatus.reviewState ?? undefined}
          />
        </Box>
      ) : null}
      {hintsShow ? (
        <Text dimColor wrap="truncate-end">
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <Text color={tokens.textMuted}> · </Text> : null}
              {part}
            </React.Fragment>
          ))}
        </Text>
      ) : null}
      {idleHintShows && !vimInsert ? (
        <Box
          flexShrink={0}
          onClick={() => {
            requestCommandDispatch('/help')
          }}
        >
          <Text dimColor wrap="truncate-end">
            {columns >= 50 ? (
              <>
                ? for shortcuts <Text color={tokens.textMuted}>· </Text>
                {paletteChord} commands + files
              </>
            ) : (
              '? for shortcuts'
            )}
          </Text>
        </Box>
      ) : null}
      {noticeStands && noticeText !== null ? (
        <Box flexShrink={1} minWidth={0} flexWrap="wrap" height={1} overflow="hidden">
          <NoticeWords seam={rowHasContent} words={noticeText} wayOut={noticeWayOut} muted={tokens.textMuted} />
          {noticeDetail !== null ? (
            <Text dimColor wrap="truncate-end">
              <Text color={tokens.textMuted}> · </Text>
              {noticeDetail}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {noticeStands && noticeBlock !== null ? (
        <Box flexShrink={1} minWidth={0} height={blockRows} overflow="hidden">
          {rowHasContent ? <Text color={tokens.textMuted}> · </Text> : null}
          {noticeBlock}
        </Box>
      ) : null}
      {!hintsShow && !idleHintShows && !rowHasContent && !noticeStands ? (
        <Text> </Text>
      ) : null}
    </Box>
  )
  return cluster
}
