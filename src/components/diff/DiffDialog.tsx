import { appendFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useLoad } from '../../hooks/effects.js'
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
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
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
import { passedOver } from '../../utils/passedOver.js'

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
  } catch (error) {
    passedOver(error)
  }
}

const SUMMARY_SIDE_BY_SIDE_MIN_COLS = 100

function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files: DiffFile[] = []
  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const [rawPath, entry] of turn.files) {
    const path = displayPathFor(rawPath)
    files.push({
      path,
      linesAdded: entry.linesAdded,
      linesRemoved: entry.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: entry.isNewFile,
    })
    hunks.set(path, entry.hunks)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    stats: {
      filesCount: files.length,
      linesAdded: files.reduce((sum, f) => sum + f.linesAdded, 0),
      linesRemoved: files.reduce((sum, f) => sum + f.linesRemoved, 0),
    },
    files,
    hunks,
    loading: false,
  }
}

type DiffBindingArgs = {
  keyActive: boolean
  viewMode: 'list' | 'detail'
  setViewMode: React.Dispatch<React.SetStateAction<'list' | 'detail'>>
  sourcesCount: number
  setSourceIndex: React.Dispatch<React.SetStateAction<number>>
  files: DiffFile[]
  selectedFile: DiffFile | undefined
  selectedIndex: number
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  hunksForSelected: StructuredPatchHunk[]
  clampedHunkIndex: number
  setHunkIndex: React.Dispatch<React.SetStateAction<number>>
  currentHunk: StructuredPatchHunk | undefined
  editorConfigured: boolean
  artifactId: string | null
  marks: ReturnType<typeof reviewMarksForFile>
  setNote: React.Dispatch<React.SetStateAction<string | null>>
  setComposer: React.Dispatch<React.SetStateAction<{ open: boolean; text: string }>>
  setReviewRevision: React.Dispatch<React.SetStateAction<number>>
  closeOneLevel: () => void
}

function useDiffDialogBindings(args: DiffBindingArgs): void {
  const {
    keyActive,
    viewMode,
    setViewMode,
    sourcesCount,
    setSourceIndex,
    files,
    selectedFile,
    selectedIndex,
    setSelectedPath,
    hunksForSelected,
    clampedHunkIndex,
    setHunkIndex,
    currentHunk,
    editorConfigured,
    artifactId,
    marks,
    setNote,
    setComposer,
    setReviewRevision,
    closeOneLevel,
  } = args

  const stepFile = (delta: number): void => {
    if (files.length === 0) return
    const next = (selectedIndex + delta + files.length) % files.length
    setSelectedPath(files[next]!.path)
    setHunkIndex(0)
    setNote(null)
  }

  const bind = (action: string, handler: () => void, active = true): void => {
    useKeybinding(
      action,
      () => {
        traceAction(action, viewMode, selectedIndex, clampedHunkIndex)
        handler()
      },
      { context: 'DiffDialog', isActive: keyActive && active },
    )
  }

  bind('diff:dismiss', closeOneLevel)
  bind('diff:previousSource', () => {
    if (viewMode === 'detail') {
      setNote(null)
      setViewMode('list')
      return
    }
    if (sourcesCount > 1) {
      setNote(null)
      setSourceIndex(i => (i - 1 + sourcesCount) % sourcesCount)
      setHunkIndex(0)
    }
  })
  bind('diff:nextSource', () => {
    if (viewMode === 'list' && sourcesCount > 1) {
      setNote(null)
      setSourceIndex(i => (i + 1) % sourcesCount)
      setHunkIndex(0)
    }
  })
  bind('diff:back', () => {
    if (viewMode === 'detail') {
      setNote(null)
      setViewMode('list')
    }
  })
  bind('diff:viewDetails', () => {
    if (viewMode === 'list' && selectedFile) {
      setNote(null)
      setHunkIndex(0)
      setViewMode('detail')
    }
  })
  bind('diff:previousFile', () => stepFile(-1), viewMode === 'list')
  bind('diff:nextFile', () => stepFile(1), viewMode === 'list')
  bind('diff:previousFileDetail', () => stepFile(-1), viewMode === 'detail')
  bind('diff:nextFileDetail', () => stepFile(1), viewMode === 'detail')
  bind(
    'diff:previousHunk',
    () => {
      if (hunksForSelected.length > 0) {
        setHunkIndex(Math.max(0, clampedHunkIndex - 1))
        setNote(null)
      }
    },
    viewMode === 'detail',
  )
  bind(
    'diff:nextHunk',
    () => {
      if (hunksForSelected.length > 0) {
        setHunkIndex(Math.min(hunksForSelected.length - 1, clampedHunkIndex + 1))
        setNote(null)
      }
    },
    viewMode === 'detail',
  )
  bind('diff:copy', () =>
    copyActionOf({
      selectedFile,
      viewMode,
      currentHunk,
      hunkPatchText,
      setNote,
      hunkIndex: clampedHunkIndex,
      hunksForSelected,
    }),
  )
  bind('diff:openFile', () =>
    openActionOf({
      selectedFile,
      editorConfigured,
      setNote,
      viewMode,
      currentHunk,
    }),
  )
  bind('diff:annotate', () => {
    if (viewMode !== 'detail' || !selectedFile || !currentHunk) {
      setNote('no hunk under the cursor to comment on')
      return
    }
    setNote(null)
    setComposer({ open: true, text: '' })
  })
  bind('diff:nextFinding', () => {
    const commentedHunks = [...marks.byHunk.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([idx]) => idx)
      .sort((a, b) => a - b)
    if (commentedHunks.length === 0) {
      setNote('no comments in this file')
      return
    }
    const nextPos = commentedHunks.findIndex(idx => idx > clampedHunkIndex)
    const targetPos = nextPos >= 0 ? nextPos : 0
    setHunkIndex(commentedHunks[targetPos]!)
    if (viewMode === 'list') setViewMode('detail')
    setNote(`finding ${targetPos + 1}/${commentedHunks.length}`)
  })
  bind('diff:resolveComments', () => {
    if (!artifactId || !selectedFile || !currentHunk) {
      setNote('nothing to resolve here')
      return
    }
    const resolved = resolveHunkComments({
      artifactId,
      path: selectedFile.path,
      hunkIndex: clampedHunkIndex,
    })
    if (resolved === 0) {
      setNote('no open comments on this hunk')
      return
    }
    setNote(`resolved ${resolved} ${plural(resolved, 'comment')}`)
    setReviewRevision(r => r + 1)
  })
  bind('diff:sendComments', () =>
    sendActionOf(
      {
        artifactId,
        setNote,
        selectedFile,
        hunkIndex: clampedHunkIndex,
        setReviewRevision,
      },
      'hunk',
    ),
  )
  bind('diff:sendAllComments', () =>
    sendActionOf(
      {
        artifactId,
        setNote,
        selectedFile,
        hunkIndex: clampedHunkIndex,
        setReviewRevision,
      },
      'all',
    ),
  )
}

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
  const { columns, rows } = useTerminalSize()
  const turnDiffs = useTurnDiffs(messages)

  const [extraSources, setExtraSources] = useState<WorkspaceDiffSource[]>([])
  useLoad(() => {
    let cancelled = false
    void enumerateExtraSources(getSessionId())
      .then(loaded => {
        if (!cancelled) setExtraSources(loaded)
      })
      .catch(passedOver)
    return () => {
      cancelled = true
    }
  }, [])

  const sources = useMemo<WorkspaceDiffSource[]>(
    () => [
      { type: 'current' },
      { type: 'unstaged' },
      { type: 'staged' },
      ...[...turnDiffs].reverse().map((turn): WorkspaceDiffSource => ({ type: 'turn', turn })),
      ...extraSources,
    ],
    [turnDiffs, extraSources],
  )

  const [sourceIndex, setSourceIndex] = useState(0)
  const clampedSourceIndex = Math.min(sourceIndex, Math.max(0, sources.length - 1))
  const source = sources[clampedSourceIndex]!
  const currentSourceKey = sourceKey(source)

  const gitSpec = sourceGitSpec(source)
  const gitDiffData = useDiffData(gitSpec ?? undefined)
  const diffData: DiffData = useMemo(() => {
    if (source.type === 'turn') return turnDiffToDiffData(source.turn)
    if (source.type === 'artifact') return artifactDiffData(source.artifactId)
    return gitDiffData
  }, [source, gitDiffData])

  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    initialPath ? displayPathFor(initialPath) : null,
  )
  const lastIndexRef = useRef(0)
  const files = diffData.files
  const selectedIndex = useMemo(() => {
    if (files.length === 0) return 0
    if (selectedPath !== null) {
      const target = resolve(getCwd(), selectedPath)
      const found = files.findIndex(f => resolve(getCwd(), f.path) === target)
      if (found >= 0) return found
    }
    return Math.min(lastIndexRef.current, files.length - 1)
  }, [files, selectedPath])
  lastIndexRef.current = selectedIndex
  const selectedFile = files[selectedIndex]

  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list')
  const [hunkIndex, setHunkIndex] = useState(0)
  const [composer, setComposer] = useState<{ open: boolean; text: string }>({
    open: false,
    text: '',
  })
  const [pendingNote, setNote] = useState<string | null>(null)
  const [reviewRevision, setReviewRevision] = useState(0)

  const hunksForSelected = selectedFile
    ? (diffData.hunks.get(selectedFile.path) ?? [])
    : []
  const clampedHunkIndex =
    hunksForSelected.length > 0
      ? Math.min(hunkIndex, hunksForSelected.length - 1)
      : 0
  const currentHunk = hunksForSelected[clampedHunkIndex]

  const artifactId = useMemo(() => {
    void reviewRevision
    return source.type === 'artifact'
      ? source.artifactId
      : boundArtifactId(currentSourceKey)
  }, [source, currentSourceKey, reviewRevision])

  const marks = useMemo(() => {
    void reviewRevision
    return selectedFile
      ? reviewMarksForFile(artifactId, selectedFile.path)
      : reviewMarksForFile(null, '')
  }, [artifactId, selectedFile, reviewRevision])

  const counts = useMemo(() => {
    void reviewRevision
    return artifactReviewCounts(artifactId)
  }, [artifactId, reviewRevision])

  const editorConfigured = Boolean(getExternalEditor())

  const closeOneLevel = (): void => {
    setNote(null)
    if (viewMode === 'detail') {
      setViewMode('list')
    } else {
      onDone('Diff dialog dismissed', { display: 'system' })
    }
  }

  const keyActive = !composer.open

  useDiffDialogBindings({
    keyActive,
    viewMode,
    setViewMode,
    sourcesCount: sources.length,
    setSourceIndex,
    files,
    selectedFile,
    selectedIndex,
    setSelectedPath,
    hunksForSelected,
    clampedHunkIndex,
    setHunkIndex,
    currentHunk,
    editorConfigured,
    artifactId,
    marks,
    setNote,
    setComposer,
    setReviewRevision,
    closeOneLevel,
  })

  const wideSummary = columns >= SUMMARY_SIDE_BY_SIDE_MIN_COLS
  const innerWidth = Math.max(40, columns - 6)
  const summaryWidth = wideSummary
    ? Math.min(44, Math.max(32, Math.floor(columns * 0.32)))
    : innerWidth
  const listWidth = wideSummary
    ? Math.max(28, innerWidth - summaryWidth - 2)
    : innerWidth
  const bodyBudget = Math.max(4, (rows || 24) - 12 - (wideSummary ? 0 : 7))
  const listRows = bodyBudget

  usePopupListPaging(
    selectedIndex,
    files.length,
    listRows,
    target => {
      const file = files[target]
      if (!file) return
      setSelectedPath(file.path)
      setHunkIndex(0)
      setNote(null)
    },
    keyActive && viewMode === 'list',
  )

  const stats = diffData.stats
  const statsLine = useMemo(() => {
    if (!stats || files.length === 0) return null
    const parts = [`${files.length} ${plural(files.length, 'file')}`]
    if (stats.linesAdded > 0) parts.push(`+${stats.linesAdded}`)
    if (stats.linesRemoved > 0) parts.push(`-${stats.linesRemoved}`)
    return parts.join(' ')
  }, [stats, files])
  const { title, subtitle } = sourceTitle(source)
  const strip = sourceStripOf({
    sources,
    columns,
    sourceIndex: clampedSourceIndex,
  })

  const commitComment = (raw: string): Promise<void> =>
    commitCommentOf(
      {
        setComposer,
        setNote,
        selectedFile,
        currentHunk,
        artifactId,
        currentSourceKey,
        source,
        diffData,
        setReviewRevision,
        hunkIndex: clampedHunkIndex,
      },
      raw,
    )

  const discardComment = (): void => {
    setComposer({ open: false, text: '' })
    setNote('comment discarded')
  }

  return diffDialogViewOf({
    composer,
    setComposer,
    viewMode,
    setViewMode,
    sources,
    source,
    files,
    editorConfigured,
    hunksForSelected,
    marks,
    hunkIndex: clampedHunkIndex,
    setHunkIndex,
    counts,
    selectedFile,
    selectedIndex,
    setSelectedPath,
    wideSummary,
    summaryWidth,
    tokens,
    pendingNote,
    setNote,
    diffData,
    stats,
    statsLine,
    closeOneLevel,
    title,
    subtitle,
    strip,
    sourceIndex: clampedSourceIndex,
    bodyBudget,
    listRows,
    listWidth,
    columns,
    commitComment,
    discardComment,
  })
}
