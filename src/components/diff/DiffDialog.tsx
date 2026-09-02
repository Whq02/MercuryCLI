// The /diff review workspace: an ordered, tabbed strip of diff sources over
// a list/detail body, with the anchored-comment review layer on top. The
// orchestrator here owns the source strip, the PATH-STABLE selection, the
// hunk cursor, the transient note, the composer, and every keybinding; the
// data model lives in diffSources.ts, the comment machinery in
// reviewLayer.ts, and the two body views in DiffFileList/DiffDetailView.

import { appendFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { setClipboard } from '../../ink/termio/osc.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTurnDiffs, type TurnDiff } from '../../hooks/useTurnDiffs.js'
import { useDiffData } from '../../hooks/useDiffData.js'
import type { DiffData, DiffFile } from '../../hooks/useDiffData.js'
import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import type { Message } from '../../types/message.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { StructuredPatchHunk } from '../../utils/diff.js'
import { getCwd } from '../../utils/cwd.js'
import { getExternalEditor, openFileInExternalEditor } from '../../utils/editor.js'
import { plural } from '../../utils/stringUtils.js'
import TextInput from '../TextInput.js'
import { CommandCenter } from '../mercury-ui/components.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { DiffDetailView } from './DiffDetailView.js'
import { DiffFileList } from './DiffFileList.js'
import {
  artifactDiffData,
  enumerateExtraSources,
  sourceGitSpec,
  sourceKey,
  sourceLabel,
  sourceSummaryValue,
  sourceTitle,
  type WorkspaceDiffSource,
} from './diffSources.js'
import {
  artifactReviewCounts,
  annotateHunk,
  boundArtifactId,
  ensureDiffArtifact,
  resolveHunkComments,
  reviewMarksForFile,
  sendComments,
} from './reviewLayer.js'

/** A single hunk as a standalone unified patch — `patch(1)`/`git apply`
 *  consumable, so the header syntax is fixed (contract data). */
export function hunkPatchText(path: string, hunk: StructuredPatchHunk): string {
  return (
    [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ].join('\n') + '\n'
  )
}

/** Turn records keep ABSOLUTE paths; display them relative to the cwd when
 *  the relative form does not escape upward. */
function displayPathFor(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(getCwd(), filePath)
  return rel.startsWith('..') ? filePath : rel
}

/** Project a turn record into diff data. The binary/large/truncated flags
 *  are projected FALSE (a turn record carries no such facts, none may be
 *  invented), and the stats come from the turn's own recorded totals. */
function turnDiffData(turn: TurnDiff): DiffData {
  const files: DiffFile[] = [...turn.files.values()]
    .map(file => ({
      path: displayPathFor(file.filePath),
      linesAdded: file.linesAdded,
      linesRemoved: file.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: file.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const file of turn.files.values()) {
    hunks.set(displayPathFor(file.filePath), file.hunks as StructuredPatchHunk[])
  }
  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved,
    },
    files,
    hunks,
    loading: false,
  }
}

/** The diagnostics seam: when MERCURY_DIFF_DEBUG names a path, every
 *  dispatched action appends one JSON line. Unset ⇒ zero cost; I/O failures
 *  are swallowed. */
function traceAction(
  action: string,
  viewMode: string,
  selectedIndex: number,
  hunkIndex: number,
): void {
  const path = flagEnv('MERCURY_DIFF_DEBUG')
  if (!path) return
  try {
    appendFileSync(
      path,
      JSON.stringify({ action, viewMode, selectedIndex, hunkIndex }) + '\n',
    )
  } catch {
    // Diagnostics never break the dialog.
  }
}

const CHROME_ROWS = 12
const STACKED_SUMMARY_ROWS = 7
const SUMMARY_SIDE_BY_SIDE_MIN_COLS = 100

export function DiffDialog({
  messages,
  onDone,
  initialPath,
}: {
  messages: readonly Message[]
  onDone: LocalJSXCommandOnDone
  initialPath?: string
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { rows: termRows, columns } = useTerminalSize()
  const turnDiffs = useTurnDiffs(messages)

  // Extra sources are enumerated ONCE per open, asynchronously,
  // failure-isolated per leg; results arrive after first paint.
  const [extraSources, setExtraSources] = useState<WorkspaceDiffSource[]>([])
  useEffect(() => {
    let live = true
    void enumerateExtraSources(getSessionId() ?? null)
      .then(extra => {
        if (live) setExtraSources(extra)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const sources = useMemo<WorkspaceDiffSource[]>(
    () => [
      { type: 'current' },
      { type: 'unstaged' },
      { type: 'staged' },
      // Newest first, as supplied by the turn-diff hook.
      ...[...turnDiffs].reverse().map(turn => ({ type: 'turn' as const, turn })),
      ...extraSources,
    ],
    [turnDiffs, extraSources],
  )

  const [sourceIndexRaw, setSourceIndex] = useState(0)
  // If the source list shrinks under the cursor, the index clamps.
  const sourceIndex = Math.min(sourceIndexRaw, Math.max(0, sources.length - 1))
  const source = sources[sourceIndex] ?? { type: 'current' as const }
  const currentSourceKey = sourceKey(source)

  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list')
  const [hunkIndexRaw, setHunkIndex] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [composer, setComposer] = useState<{ open: boolean; text: string }>({
    open: false,
    text: '',
  })
  // Review revision counter: every mutating review action advances it; the
  // artifact body, counts and marks are memoised on it so an ordinary render
  // does no disk read.
  const [reviewRevision, setReviewRevision] = useState(0)

  // ── data ────────────────────────────────────────────────────────────────
  const gitData = useDiffData(sourceGitSpec(source) ?? undefined)
  const artifactData = useMemo(
    () =>
      source.type === 'artifact' ? artifactDiffData(source.artifactId) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision advance re-reads the stored body
    [source.type === 'artifact' ? source.artifactId : null, reviewRevision],
  )
  const diffData: DiffData =
    source.type === 'turn'
      ? turnDiffData(source.turn)
      : source.type === 'artifact' && artifactData
        ? artifactData
        : gitData
  const files = diffData.files

  // ── selection: BY PATH, not by index ────────────────────────────────────
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialPath ?? null,
  )
  const rememberedIndexRef = useRef(0)
  const normalise = (p: string) => resolve(getCwd(), p)
  let selectedIndex = -1
  if (selectedPath !== null) {
    const wanted = normalise(selectedPath)
    selectedIndex = files.findIndex(file => normalise(file.path) === wanted)
  }
  if (selectedIndex === -1) {
    // Absent path: fall back to the most recently resolved index, clamped;
    // an empty list yields 0 and no selected file.
    selectedIndex = Math.min(rememberedIndexRef.current, Math.max(0, files.length - 1))
  }
  const selectedFile = files[selectedIndex]
  // The remembered index refreshes every render (it tracks the cursor); once
  // a file resolves, the remembered path is rewritten to that file's OWN
  // spelling so a further source switch still matches.
  rememberedIndexRef.current = files.length > 0 ? selectedIndex : 0
  useEffect(() => {
    if (selectedFile && selectedFile.path !== selectedPath) {
      setSelectedPath(selectedFile.path)
    }
  }, [selectedFile, selectedPath])

  const hunksForSelected: StructuredPatchHunk[] = selectedFile
    ? (diffData.hunks.get(selectedFile.path) ?? [])
    : []
  const hunkIndex = Math.min(
    hunkIndexRaw,
    Math.max(0, hunksForSelected.length - 1),
  )
  const currentHunk: StructuredPatchHunk | undefined =
    hunksForSelected[hunkIndex]

  // ── review layer reads (memoised on the revision counter) ───────────────
  const artifactId =
    source.type === 'artifact'
      ? source.artifactId
      : boundArtifactId(currentSourceKey)
  const marks = useMemo(
    () =>
      reviewMarksForFile(artifactId, selectedFile?.path ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision advance re-reads
    [artifactId, selectedFile?.path, reviewRevision],
  )
  const counts = useMemo(
    () => artifactReviewCounts(artifactId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision advance re-reads
    [artifactId, reviewRevision],
  )

  const editorConfigured = (getExternalEditor() ?? '').trim() !== ''

  // ── shared transitions ──────────────────────────────────────────────────
  const selectSource = (index: number) => {
    setSourceIndex(index)
    setHunkIndex(0)
    setNote(null)
    setViewMode('list')
  }
  const stepFile = (delta: 1 | -1) => {
    if (files.length === 0) return
    const next = (selectedIndex + delta + files.length) % files.length
    const file = files[next]
    if (file) setSelectedPath(file.path)
    // File stepping resets the hunk cursor but deliberately leaves the note
    // standing, so a copy receipt survives a step.
    setHunkIndex(0)
  }
  // The comment composer owns esc while open: the draft is discarded and the
  // workspace stays (the footer's `esc discard`); ctrl+c/d discard the same way.
  const discardComment = () => {
    setComposer({ open: false, text: '' })
    setNote('comment discarded')
  }
  const closeOneLevel = () => {
    if (composer.open) return
    if (viewMode === 'detail') {
      setViewMode('list')
    } else {
      onDone(undefined, { display: 'skip' })
    }
  }

  const withTrace = (action: string, body: () => void) => () => {
    traceAction(action, viewMode, selectedIndex, hunkIndex)
    body()
  }

  // ── actions ─────────────────────────────────────────────────────────────
  const copyAction = () => {
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
    // List mode — and detail with no hunk under the cursor — copy the path,
    // so `c` is never a no-op while a file is selected.
    void setClipboard(selectedFile.path).then(sequence => {
      if (sequence) process.stdout.write(sequence)
    })
    setNote(`copied ${selectedFile.path}`)
  }

  const openAction = () => {
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

  const annotateAction = () => {
    if (viewMode !== 'detail' || !selectedFile) return
    if (!currentHunk) {
      setNote('no hunk under the cursor to comment on')
      return
    }
    setComposer({ open: true, text: '' })
  }

  const commitComment = async (raw: string) => {
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
    // Ensure a review artifact exists for this source (artifact sources use
    // themselves; others mint one from the source title + current data).
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

  const nextFindingAction = () => {
    const commented = [...marks.byHunk.keys()].sort((a, b) => a - b)
    if (commented.length === 0) {
      setNote('no comments in this file')
      return
    }
    const after = commented.find(index => index > hunkIndex)
    const target = after ?? commented[0]!
    setHunkIndex(target)
    setViewMode('detail')
    setNote(`finding ${commented.indexOf(target) + 1}/${commented.length}`)
  }

  const resolveAction = () => {
    if (viewMode !== 'detail' || !selectedFile || !artifactId) {
      setNote('nothing to resolve here')
      return
    }
    const resolved = resolveHunkComments({
      artifactId,
      path: selectedFile.path,
      hunkIndex,
    })
    setNote(
      resolved > 0
        ? `resolved ${resolved} ${plural(resolved, 'comment')}`
        : 'no open comments on this hunk',
    )
    setReviewRevision(revision => revision + 1)
  }

  const sendAction = (scope: 'hunk' | 'all') => {
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

  // ── keybindings — the dedicated context is registered ACTIVE (the
  // surrounding dialog wrapper otherwise claims plain letters, notably `n`,
  // and one keypress would silently close the workspace) ──────────────────
  const bindingsActive = !composer.open
  const bind = (
    action: string,
    handler: () => void,
    extraGate = true,
  ) =>
    useKeybinding(action, withTrace(action, handler), {
      context: 'DiffDialog',
      isActive: bindingsActive && extraGate,
    })

  bind('diff:dismiss', closeOneLevel)
  bind('diff:previousSource', () => {
    if (viewMode === 'detail') {
      setViewMode('list')
      return
    }
    if (sources.length > 1) {
      selectSource((sourceIndex + sources.length - 1) % sources.length)
    }
  })
  bind(
    'diff:nextSource',
    () => {
      if (viewMode === 'list' && sources.length > 1) {
        selectSource((sourceIndex + 1) % sources.length)
      }
    },
  )
  bind('diff:back', () => {
    if (viewMode === 'detail') setViewMode('list')
  })
  bind(
    'diff:viewDetails',
    () => {
      if (viewMode === 'list' && selectedFile) {
        setHunkIndex(0)
        setViewMode('detail')
      }
    },
  )
  bind('diff:previousFile', () => stepFile(-1), viewMode === 'list')
  bind('diff:nextFile', () => stepFile(1), viewMode === 'list')
  bind(
    'diff:previousHunk',
    () => setHunkIndex(Math.max(0, hunkIndex - 1)),
    viewMode === 'detail',
  )
  bind(
    'diff:nextHunk',
    () =>
      setHunkIndex(
        Math.min(Math.max(0, hunksForSelected.length - 1), hunkIndex + 1),
      ),
    viewMode === 'detail',
  )
  bind('diff:previousFileDetail', () => stepFile(-1), viewMode === 'detail')
  bind('diff:nextFileDetail', () => stepFile(1), viewMode === 'detail')
  bind('diff:copy', copyAction)
  bind('diff:openFile', openAction)
  bind('diff:annotate', annotateAction, viewMode === 'detail')
  bind('diff:nextFinding', nextFindingAction)
  bind('diff:resolveComments', resolveAction, viewMode === 'detail')
  bind('diff:sendComments', () => sendAction(selectedFile ? 'hunk' : 'all'), viewMode === 'detail')
  bind('diff:sendAllComments', () => sendAction('all'))

  // ── layout ──────────────────────────────────────────────────────────────
  const wideSummary = columns >= SUMMARY_SIDE_BY_SIDE_MIN_COLS
  // The body budget derives from the terminal row count ONLY — never from
  // how many files the current source holds (a source step must not bounce
  // the bottom-anchored frame).
  const bodyBudget = Math.max(4, (termRows || 24) - 12 - (wideSummary ? 0 : 7))
  const listRows = Math.max(4, Math.min(files.length, bodyBudget))
  const summaryWidth = Math.min(44, Math.max(32, Math.floor(columns * 0.32)))
  const listWidth = wideSummary ? columns - summaryWidth - 6 : columns - 4

  const { title, subtitle } = sourceTitle(source)
  const stats = diffData.stats
  const statsLine =
    stats && files.length > 0
      ? [
          `${files.length} ${plural(files.length, 'file')}`,
          ...(stats.linesAdded > 0 ? [`+${stats.linesAdded}`] : []),
          ...(stats.linesRemoved > 0 ? [`-${stats.linesRemoved}`] : []),
        ].join(' ')
      : null

  // Bounded tab window centred on the selection: grow alternately left and
  // right while whole labels fit; never truncate a label mid-word.
  const strip = useMemo(() => {
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
  }, [sources, sourceIndex, columns])

  const pendingNote = note

  // Footer: only armed actions; in detail the back hint leads so it survives
  // the narrowest cut.
  const footer = (() => {
    if (composer.open) return 'enter save · esc discard'
    const parts: string[] = []
    if (viewMode === 'list') {
      if (sources.length > 1) parts.push('←→ source')
      if (files.length > 1) parts.push('↑↓ file')
      // In list mode `c` copies the PATH (the hunk copy belongs to detail).
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

  // ── summary card ────────────────────────────────────────────────────────
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

  // ── empty/loading vocabulary — distinguishable situations ───────────────
  const emptyMessage = (() => {
    if (diffData.loading) return null
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
                    // Pasted newlines collapse to spaces.
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
