import React, { useState } from 'react'
import { basename } from 'path'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useLoad } from '../hooks/effects.js'
import {
  adjustHunkLineNumbers,
  type StructuredPatchHunk,
} from '../utils/diff.js'
import {
  CHUNK_SIZE,
  openForScan,
  readCapped,
  scanForContext,
} from '../utils/readEditContext.js'
import { logError } from '../utils/log.js'
import { isRemotePath } from '../utils/remoteFiles/target.js'
import { getPatchForEdits } from '../utils/fileEditUtils.js'
import { boundHunks, diffPaintWidth } from './permissions/consentBodyBudget.js'
import { StructuredDiffList } from './StructuredDiffList.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt } from '../pi/holes.js'

const SCAN_CONTEXT_LINES = 3
const FRAME_COLUMNS = 4

type Edit = { old_string?: string; new_string?: string; replace_all?: boolean }
type CompleteEdit = { old_string: string; new_string: string; replace_all?: boolean }

type LoadedDiff = {
  hunks: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
}

function diffToolInputs(filePath: string, edits: CompleteEdit[]): LoadedDiff {
  const base = edits.map(edit => edit.old_string).join('\n')
  const { patch } = getPatchForEdits({
    filePath,
    fileContents: base,
    edits,
  })
  return { hunks: patch, firstLine: null }
}

export async function loadDiff(
  filePath: string,
  rawEdits: Edit[],
): Promise<LoadedDiff> {
  return notBuilt('src/components/FileEditToolDiff.tsx:46')
}

export function FileEditToolDiff(arg0: {
  file_path: string
  edits: Edit[]
  availableWidth?: number
  consentBudget?: number | null
}): React.ReactNode {
  return notBuilt('src/components/FileEditToolDiff.tsx:126')
}

export default FileEditToolDiff
