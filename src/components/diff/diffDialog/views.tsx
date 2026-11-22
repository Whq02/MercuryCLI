import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import type { DiffData, DiffFile } from '../../../hooks/useDiffData.js'
import { getSessionId } from '../../../bootstrap/state.js'
import type { StructuredPatchHunk } from '../../../utils/diff.js'
import { getCwd } from '../../../utils/cwd.js'
import { openFileInExternalEditor } from '../../../utils/editor.js'
import { plural } from '../../../utils/stringUtils.js'
import { resolve } from 'path'
import TextInput from '../../TextInput.js'
import { CommandCenter } from '../../mercury-ui/components.js'
import { WorkingGlyph } from '../../mercury-ui/LiveGlyphs.js'
import type { useMercuryTokens } from '../../mercury-ui/useMercuryTokens.js'
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
import { notBuilt } from '../../../pi/holes.js'

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

export function diffDialogViewOf(arg0: DiffDialogViewArgs): React.ReactNode {
  return notBuilt('src/components/diff/diffDialog/views.tsx:246')
}
