import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { setClipboard } from '../../renderer/termio/osc.js'
import type { DiffData, DiffFile } from '../useDiffData.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import type { StructuredPatchHunk } from '../../../platform/text/diff.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { openFileInExternalEditor } from '../../../platform/editor/externalEditor.js'
import { plural } from '../../../platform/text/strings.js'
import { resolve } from 'path'
import TextInput from '../../composer/text-input/TextInput.js'
import { CommandCenter } from '../../widgets/components.js'
import { WorkingGlyph } from '../../widgets/LiveGlyphs.js'
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { DiffDetailView } from '../DiffDetailView.js'
import { DiffFileList } from '../DiffFileList.js'
import {
  sourceLabel,
  sourceSummaryValue,
  sourceTitle,
  type WorkspaceDiffSource,
} from '../diffSources.js'
import {
  annotateHunk,
  type artifactReviewCounts,
  ensureDiffArtifact,
  type reviewMarksForFile,
  sendComments,
} from '../reviewLayer.js'

type Setter<T> = React.Dispatch<React.SetStateAction<T>>
type Composer = { open: boolean; text: string }

type CopyActionArgs = {
  selectedFile: DiffFile | undefined
  viewMode: 'list' | 'detail'
  currentHunk: StructuredPatchHunk | undefined
  hunkPatchText: (path: string, hunk: StructuredPatchHunk) => string
  setNote: Setter<string | null>
  hunkIndex: number
  hunksForSelected: StructuredPatchHunk[]
}

export function copyActionOf({ selectedFile, viewMode, currentHunk, hunkPatchText, setNote, hunkIndex, hunksForSelected }: CopyActionArgs): void {
  if (!selectedFile) return
  if (viewMode === 'detail' && currentHunk) {
    const patch = hunkPatchText(selectedFile.path, currentHunk)
    void setClipboard(patch).then(sequence => {
      if (sequence) process.stdout.write(sequence)
    })
    setNote(
      `copied hunk ${hunkIndex + 1}/${hunksForSelected.length} of ${selectedFile.path}`,
    )
    return
  }
  void setClipboard(selectedFile.path).then(sequence => {
    if (sequence) process.stdout.write(sequence)
  })
  setNote(`copied ${selectedFile.path}`)
}

type OpenActionArgs = {
  selectedFile: DiffFile | undefined
  editorConfigured: boolean
  setNote: Setter<string | null>
  viewMode: 'list' | 'detail'
  currentHunk: StructuredPatchHunk | undefined
}

export function openActionOf({ selectedFile, editorConfigured, setNote, viewMode, currentHunk }: OpenActionArgs): void {
  if (!selectedFile) return
  if (!editorConfigured) {
    setNote('no editor configured — set $VISUAL or $EDITOR')
    return
  }
  const line =
    viewMode === 'detail' && currentHunk ? currentHunk.newStart : undefined
  const launched = openFileInExternalEditor(
    resolve(getCwd(), selectedFile.path),
    line,
  )
  if (!launched) {
    setNote('the editor failed to launch')
    return
  }
  setNote(
    line !== undefined
      ? `opened ${selectedFile.path}:${line}`
      : `opened ${selectedFile.path}`,
  )
}

type CommitCommentArgs = {
  setComposer: Setter<Composer>
  setNote: Setter<string | null>
  selectedFile: DiffFile | undefined
  currentHunk: StructuredPatchHunk | undefined
  artifactId: string | null
  currentSourceKey: string
  source: WorkspaceDiffSource
  diffData: DiffData
  setReviewRevision: Setter<number>
  hunkIndex: number
}

export async function commitCommentOf({ setComposer, setNote, selectedFile, currentHunk, artifactId, currentSourceKey, source, diffData, setReviewRevision, hunkIndex }: CommitCommentArgs, raw: string): Promise<void> {
  setComposer({ open: false, text: '' })
  const body = raw.replace(/\r?\n/g, ' ').trim()
  if (body === '') {
    setNote('comment discarded (empty)')
    return
  }
  if (!selectedFile || !currentHunk) {
    setNote('no hunk under the cursor to comment on')
    return
  }
  let targetArtifact = artifactId
  if (!targetArtifact) {
    const minted = await ensureDiffArtifact({
      sourceKey: currentSourceKey,
      label: sourceTitle(source).title,
      diffData,
      sessionId: getSessionId() ?? 'unknown-session',
    })
    if (!minted.ok) {
      setNote(minted.reason)
      setReviewRevision(revision => revision + 1)
      return
    }
    targetArtifact = minted.artifactId
  }
  const added = annotateHunk({
    artifactId: targetArtifact,
    path: selectedFile.path,
    hunk: currentHunk,
    hunkIndex,
    body,
    currentDiffData: diffData,
    producerSessionId: getSessionId() ?? undefined,
  })
  setNote(added.ok ? `comment ${added.commentId} added` : added.reason)
  setReviewRevision(revision => revision + 1)
}

type SendActionArgs = {
  artifactId: string | null
  setNote: Setter<string | null>
  selectedFile: DiffFile | undefined
  hunkIndex: number
  setReviewRevision: Setter<number>
}

export function sendActionOf({ artifactId, setNote, selectedFile, hunkIndex, setReviewRevision }: SendActionArgs, scope: 'hunk' | 'all'): void {
  if (!artifactId) {
    setNote('no review artifact yet — press a to comment first')
    return
  }
  const result = sendComments({
    artifactId,
    scope:
      scope === 'hunk' && selectedFile
        ? { kind: 'hunk', path: selectedFile.path, hunkIndex }
        : { kind: 'all-open' },
  })
  setNote(
    result.ok
      ? `sent ${result.sent} ${plural(result.sent, 'comment')} for review`
      : result.reason,
  )
  setReviewRevision(revision => revision + 1)
}

type SourceStripArgs = {
  sources: WorkspaceDiffSource[]
  columns: number
  sourceIndex: number
}

export function sourceStripOf({ sources, columns, sourceIndex }: SourceStripArgs) {
  if (sources.length <= 1) return null
  const labels = sources.map(sourceLabel)
  const budget = Math.max(24, columns - 18)
  const chosen = new Set<number>([sourceIndex])
  let used = labels[sourceIndex]!.length + 4
  let left = sourceIndex - 1
  let right = sourceIndex + 1
  let toggle = true
  while (left >= 0 || right < sources.length) {
    const candidate = toggle && left >= 0 ? left : right < sources.length ? right : left
    if (candidate < 0 || candidate >= sources.length) break
    const cost = labels[candidate]!.length + 3
    if (used + cost > budget) break
    chosen.add(candidate)
    used += cost
    if (candidate === left) left--
    else right++
    toggle = !toggle
  }
  const visible = [...chosen].sort((a, b) => a - b)
  return {
    hasLeft: visible[0]! > 0,
    hasRight: visible[visible.length - 1]! < sources.length - 1,
    visible,
    labels,
  }
}

type DiffDialogViewArgs = {
  composer: Composer
  setComposer: Setter<Composer>
  viewMode: 'list' | 'detail'
  setViewMode: Setter<'list' | 'detail'>
  sources: WorkspaceDiffSource[]
  source: WorkspaceDiffSource
  files: DiffFile[]
  editorConfigured: boolean
  hunksForSelected: StructuredPatchHunk[]
  marks: ReturnType<typeof reviewMarksForFile>
  hunkIndex: number
  setHunkIndex: Setter<number>
  counts: ReturnType<typeof artifactReviewCounts>
  selectedFile: DiffFile | undefined
  selectedIndex: number
  setSelectedPath: Setter<string | null>
  wideSummary: boolean
  summaryWidth: number
  tokens: ReturnType<typeof useMercuryTokens>
  pendingNote: string | null
  setNote: Setter<string | null>
  diffData: DiffData
  stats: DiffData['stats']
  statsLine: string | null
  closeOneLevel: () => void
  title: string
  subtitle: string
  strip: ReturnType<typeof sourceStripOf>
  sourceIndex: number
  bodyBudget: number
  listRows: number
  listWidth: number
  columns: number
  commitComment: (raw: string) => Promise<void>
  discardComment: () => void
}

export function diffDialogViewOf({ composer, setComposer, viewMode, setViewMode, sources, source, files, editorConfigured, hunksForSelected, marks, hunkIndex, setHunkIndex, counts, selectedFile, selectedIndex, setSelectedPath, wideSummary, summaryWidth, tokens, pendingNote, setNote, diffData, stats, statsLine, closeOneLevel, title, subtitle, strip, sourceIndex, bodyBudget, listRows, listWidth, columns, commitComment, discardComment }: DiffDialogViewArgs): React.ReactNode {
  const footer = (() => {
    if (composer.open) return 'enter save · esc discard'
    const parts: string[] = []
    if (viewMode === 'list') {
      if (sources.length > 1) parts.push('←→ source')
      if (files.length > 1) parts.push('↑↓ file', 'pgup/pgdn page')
      if (files.length > 0) parts.push('↵ view', 'c copy path')
      if (files.length > 0 && editorConfigured) parts.push('o open')
    } else {
      parts.push('← back')
      if (hunksForSelected.length > 1) parts.push('n/p hunk')
      if (files.length > 1) parts.push('[/] file')
      if (hunksForSelected.length > 0) parts.push('a comment')
      if (marks.byHunk.size > 0) parts.push('f finding')
      if ((marks.byHunk.get(hunkIndex) ?? []).some(c => c.state === 'open')) {
        parts.push('r resolve')
      }
      if (counts.open > 0) parts.push('s/x send')
      if (hunksForSelected.length > 0) parts.push('c copy')
      if (editorConfigured) parts.push('o open')
    }
    return parts.join(' · ')
  })()

  const summaryCard = selectedFile ? (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
      width={wideSummary ? summaryWidth : undefined}
    >
      <Text bold wrap="truncate-end">
        {selectedFile.path}
      </Text>
      {!selectedFile.isBinary && !selectedFile.isUntracked ? (
        <Text>
          <Text dimColor>lines </Text>
          <Text color="success">+{selectedFile.linesAdded}</Text>
          <Text dimColor> / </Text>
          <Text color="error">-{selectedFile.linesRemoved}</Text>
        </Text>
      ) : null}
      {hunksForSelected.length > 0 ? (
        <Text>
          <Text dimColor>hunks </Text>
          {hunksForSelected.length}
        </Text>
      ) : null}
      {(() => {
        const posture = [
          ...(selectedFile.isNewFile ? ['new'] : []),
          ...(selectedFile.isUntracked ? ['untracked'] : []),
          ...(selectedFile.isBinary ? ['binary'] : []),
          ...(selectedFile.isLargeFile ? ['large'] : []),
          ...(selectedFile.isTruncated ? ['truncated'] : []),
        ]
        return posture.length > 0 ? (
          <Text>
            <Text dimColor>posture </Text>
            {posture.join(' · ')}
          </Text>
        ) : null
      })()}
      {marks.olderVersion > 0 ? (
        <Text color="warning">
          older: {marks.olderVersion} open on an older stored version
        </Text>
      ) : null}
      {counts.open + counts.resolved + counts.outdated > 0 ? (
        <Text color={counts.open > 0 ? 'warning' : undefined}>
          <Text dimColor>review </Text>
          {counts.open} open · {counts.resolved} resolved
          {counts.outdated > 0 ? ` · ${counts.outdated} outdated` : ''}
        </Text>
      ) : null}
      <Text>
        <Text dimColor>source </Text>
        {sourceSummaryValue(source)}
      </Text>
      {pendingNote && viewMode === 'list' ? (
        <Text color={tokens.info}>{pendingNote}</Text>
      ) : null}
    </Box>
  ) : null

  const emptyMessage = (() => {
    if (diffData.loading) return null
    if (diffData.error !== undefined && diffData.error !== '') {
      return `Git diff could not be loaded (${diffData.error}) — try again.`
    }
    if (source.type === 'turn') return 'This turn changed no files.'
    if (stats && stats.filesCount > 0) {
      return 'Stats report changes, but the details were suppressed (too many files).'
    }
    if (source.type === 'artifact') return 'This artifact has no stored hunks.'
    if (source.type === 'staged') return 'Nothing is staged.'
    if (source.type === 'branch') {
      return 'This branch is identical to its base.'
    }
    return 'The working tree is clean.'
  })()

  const comments = marks.byHunk.get(hunkIndex) ?? []
  const openComments = comments.filter(c => c.state === 'open').length
  const outdatedComments = comments.filter(c => c.state === 'outdated').length

  return (
    <CommandCenter
      view="diff"
      subtitle={statsLine ?? undefined}
      onClose={closeOneLevel}
      captureInput={false}
      closeKeys="esc"
      footer={footer}
      bodyOwnsPageKeys={viewMode === 'list'}
      bodyRestsAtTop
      elevated
    >
      <Box flexDirection="column">
        <Box>
          <Text bold>{title}</Text>
          <Text dimColor> {subtitle}</Text>
        </Box>
        {strip ? (
          <Box>
            {strip.hasLeft ? <Text dimColor>‹ </Text> : null}
            {strip.visible.map(index => (
              <Text
                key={index}
                inverse={index === sourceIndex}
                dimColor={index !== sourceIndex}
              >
                {' '}
                {strip.labels[index]}{' '}
              </Text>
            ))}
            {strip.hasRight ? <Text dimColor> ›</Text> : null}
          </Box>
        ) : null}
        {diffData.loading || files.length === 0 ? (
          <Box minHeight={bodyBudget}>
            {diffData.loading ? (
              <>
                <WorkingGlyph color={tokens.info} />
                <Text dimColor> Reading the diff…</Text>
              </>
            ) : diffData.error !== undefined && diffData.error !== '' ? (
              <Text color="error">{emptyMessage}</Text>
            ) : (
              <Text dimColor>{emptyMessage}</Text>
            )}
          </Box>
        ) : viewMode === 'list' ? (
          <Box
            flexDirection={wideSummary ? 'row' : 'column'}
            gap={wideSummary ? 2 : 0}
          >
            <Box flexDirection="column" minHeight={bodyBudget}>
              <DiffFileList
                files={files}
                selectedIndex={selectedIndex}
                visibleRows={listRows}
                listWidth={listWidth}
                onSelect={path => {
                  setSelectedPath(path)
                  setHunkIndex(0)
                  setNote(null)
                }}
                onActivate={path => {
                  setSelectedPath(path)
                  setHunkIndex(0)
                  setViewMode('detail')
                }}
              />
            </Box>
            {summaryCard}
          </Box>
        ) : (
          <Box flexDirection="column">
            <DiffDetailView
              filePath={selectedFile?.path ?? ''}
              hunks={hunksForSelected}
              hunkIndex={hunkIndex}
              linesAdded={selectedFile?.linesAdded}
              linesRemoved={selectedFile?.linesRemoved}
              isLargeFile={selectedFile?.isLargeFile}
              isBinary={selectedFile?.isBinary}
              isTruncated={selectedFile?.isTruncated}
              isUntracked={selectedFile?.isUntracked}
            />
            {comments.length > 0 ? (
              <Box flexDirection="column">
                <Text dimColor>
                  {comments.length} {plural(comments.length, 'comment')} on this
                  hunk
                  {openComments > 0 ? ` · ${openComments} open` : ''}
                  {outdatedComments > 0
                    ? ` · ${outdatedComments} outdated (the anchor moved)`
                    : ''}
                </Text>
                {comments.slice(0, 3).map(comment => (
                  <Text key={comment.id} wrap="truncate-end">
                    <Text dimColor>[{comment.state}] </Text>
                    <Text bold>{comment.author}</Text>
                    <Text>: {comment.body}</Text>
                  </Text>
                ))}
              </Box>
            ) : null}
            {composer.open ? (
              <Box>
                <Text color={tokens.info}>comment: </Text>
                <TextInput
                  value={composer.text}
                  onChange={text =>
                    setComposer({ open: true, text: text.replace(/\r?\n/g, ' ') })
                  }
                  cursorOffset={composer.text.length}
                  onChangeCursorOffset={() => {}}
                  columns={Math.max(20, columns - 14)}
                  onSubmit={value => {
                    void commitComment(value)
                  }}
                  onExit={discardComment}
                  onEscape={discardComment}
                />
              </Box>
            ) : null}
            {pendingNote ? (
              <Text color={tokens.info}>{pendingNote}</Text>
            ) : null}
          </Box>
        )}
      </Box>
    </CommandCenter>
  )
}
