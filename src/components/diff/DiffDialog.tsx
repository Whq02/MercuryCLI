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
import { notBuilt } from '../../pi/holes.js'

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

export function DiffDialog(arg0: {
  messages: readonly Message[]
  onDone: LocalJSXCommandOnDone
  initialPath?: string
}): React.ReactNode {
  return notBuilt('src/components/diff/DiffDialog.tsx:104')
}
