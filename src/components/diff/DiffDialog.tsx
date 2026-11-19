
import { appendFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import '../../ink.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import '../../ink/termio/osc.js'
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
import { getExternalEditor } from '../../utils/editor.js'
import { plural } from '../../utils/stringUtils.js'
import '../TextInput.js'
import '../mercury-ui/components.js'
import '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import './DiffDetailView.js'
import './DiffFileList.js'
import {
  artifactDiffData,
  enumerateExtraSources,
  sourceGitSpec,
  sourceKey,
  sourceTitle,
  type WorkspaceDiffSource,
} from './diffSources.js'
import {
  artifactReviewCounts,
  boundArtifactId,
  resolveHunkComments,
  reviewMarksForFile,
} from './reviewLayer.js'
import { commitCommentOf, copyActionOf, diffDialogViewOf, openActionOf, sendActionOf, sourceStripOf } from './diffDialog/views.js'

export function hunkPatchText(path: string, hunk: StructuredPatchHunk): string {
  return (
    [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0)},${hunk.oldLines} +${hunk.newStart - (hunk.newLines === 0 ? 1 : 0)},${hunk.newLines} @@`,
      ...hunk.lines,
    ].join('\n') + '\n'
  )
}

function displayPathFor(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(getCwd(), filePath)
  return rel.startsWith('..') ? filePath : rel
}

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
  }
}

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
      ...[...turnDiffs].reverse().map(turn => ({ type: 'turn' as const, turn })),
      ...extraSources,
    ],
    [turnDiffs, extraSources],
  )

  const [sourceIndexRaw, setSourceIndex] = useState(0)
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
  const [reviewRevision, setReviewRevision] = useState(0)

  const gitData = useDiffData(sourceGitSpec(source) ?? undefined)
  const artifactData = useMemo(
    () =>
      source.type === 'artifact' ? artifactDiffData(source.artifactId) : null,
    [source.type === 'artifact' ? source.artifactId : null, reviewRevision],
  )
  const diffData: DiffData =
    source.type === 'turn'
      ? turnDiffData(source.turn)
      : source.type === 'artifact' && artifactData
        ? artifactData
        : gitData
  const files = diffData.files

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
    selectedIndex = Math.min(rememberedIndexRef.current, Math.max(0, files.length - 1))
  }
  const selectedFile = files[selectedIndex]
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

  const artifactId =
    source.type === 'artifact'
      ? source.artifactId
      : boundArtifactId(currentSourceKey)
  const marks = useMemo(
    () =>
      reviewMarksForFile(artifactId, selectedFile?.path ?? ''),
    [artifactId, selectedFile?.path, reviewRevision],
  )
  const counts = useMemo(
    () => artifactReviewCounts(artifactId),
    [artifactId, reviewRevision],
  )

  const editorConfigured = (getExternalEditor() ?? '').trim() !== ''

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
    setHunkIndex(0)
  }
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

  const copyAction = () => copyActionOf({ selectedFile, viewMode, currentHunk, hunkPatchText, setNote, hunkIndex, hunksForSelected })

  const openAction = () => openActionOf({ selectedFile, editorConfigured, setNote, viewMode, currentHunk })

  const annotateAction = () => {
    if (viewMode !== 'detail' || !selectedFile) return
    if (!currentHunk) {
      setNote('no hunk under the cursor to comment on')
      return
    }
    setComposer({ open: true, text: '' })
  }

  const commitComment = (raw: string) => commitCommentOf({ setComposer, setNote, selectedFile, currentHunk, artifactId, currentSourceKey, source, diffData, setReviewRevision, hunkIndex }, raw)

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

  const sendAction = (scope: 'hunk' | 'all') => sendActionOf({ artifactId, setNote, selectedFile, hunkIndex, setReviewRevision }, scope)

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

  const wideSummary = columns >= SUMMARY_SIDE_BY_SIDE_MIN_COLS
  const bodyBudget = Math.max(4, (termRows || 24) - 12 - (wideSummary ? 0 : 7))
  const listRows = Math.max(4, Math.min(files.length, bodyBudget))
  usePopupListPaging(selectedIndex, files.length, listRows, next => { setSelectedPath(files[next]?.path ?? null); setHunkIndex(0); setNote(null) }, viewMode === 'list' && !composer.open)
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

  const strip = useMemo(() => sourceStripOf({ sources, columns, sourceIndex }), [sources, sourceIndex, columns])

  const pendingNote = note

  return diffDialogViewOf({ composer, setComposer, viewMode, setViewMode, sources, source, files, editorConfigured, hunksForSelected, marks, hunkIndex, setHunkIndex, counts, selectedFile, selectedIndex, setSelectedPath, wideSummary, summaryWidth, tokens, pendingNote, setNote, diffData, stats, statsLine, closeOneLevel, title, subtitle, strip, sourceIndex, bodyBudget, listRows, listWidth, columns, commitComment, discardComment })
}
