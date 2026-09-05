
import React, { useEffect, useState } from 'react'
import { basename } from 'path'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
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
import { getPatchForEdits } from '../tools/FileEditTool/utils.js'
import { boundHunks, diffPaintWidth } from './permissions/consentBodyBudget.js'
import { StructuredDiffList } from './StructuredDiffList.js'

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

async function loadDiff(
  filePath: string,
  rawEdits: Edit[],
): Promise<LoadedDiff> {
  const edits = rawEdits.filter(
    (edit): edit is CompleteEdit =>
      typeof edit.old_string === 'string' && typeof edit.new_string === 'string',
  )
  if (edits.length === 0) return { hunks: [], firstLine: null }

  try {
    if (edits.length === 1 && edits[0]!.old_string.length >= CHUNK_SIZE) {
      return diffToolInputs(filePath, edits)
    }

    const handle = await openForScan(filePath)
    if (handle === null) return diffToolInputs(filePath, edits)
    try {
      if (edits.length > 1 || edits[0]!.old_string === '') {
        const whole = await readCapped(handle)
        if (whole === null) return diffToolInputs(filePath, edits)
        const { patch } = getPatchForEdits({
          filePath,
          fileContents: whole,
          edits,
        })
        return {
          hunks: patch,
          firstLine: whole.split('\n')[0] ?? null,
          fileContent: whole,
        }
      }

      const context = await scanForContext(
        handle,
        edits[0]!.old_string,
        SCAN_CONTEXT_LINES,
      )
      if (context.truncated || context.content === '') {
        return diffToolInputs(filePath, edits)
      }
      const { patch } = getPatchForEdits({
        filePath,
        fileContents: context.content,
        edits,
      })
      const shifted = adjustHunkLineNumbers(patch, context.lineOffset - 1)
      return {
        hunks: shifted,
        firstLine:
          context.lineOffset === 1 ? (context.content.split('\n')[0] ?? null) : null,
        fileContent: context.content,
      }
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (error) {
    logError(error)
    return diffToolInputs(filePath, edits)
  }
}

export function FileEditToolDiff({
  file_path,
  edits,
  availableWidth,
  consentBudget,
}: {
  file_path: string
  edits: Edit[]
  availableWidth?: number
  consentBudget?: number | null
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null)

  useEffect(() => {
    let live = true
    void loadDiff(file_path, edits).then(result => {
      if (live) setLoaded(result)
    })
    return () => {
      live = false
    }
  }, [file_path, edits])

  const framed = columns > 80
  const outerWidth = Math.max(1, availableWidth ?? columns - 2)
  const innerWidth = Math.max(1, framed ? outerWidth - FRAME_COLUMNS : outerWidth)
  const name = basename(file_path)

  if (loaded && loaded.hunks.length === 0) {
    return (
      <Text dimColor>
        {name}: no visible change
      </Text>
    )
  }

  const bounded =
    loaded === null
      ? null
      : consentBudget === undefined
        ? { hunks: loaded.hunks, hiddenLines: 0, cut: false }
        : boundHunks(loaded.hunks, diffPaintWidth(innerWidth, loaded.hunks), consentBudget)

  const body =
    loaded === null || bounded === null ? (
      <Text dimColor>…</Text>
    ) : (
      <>
        <StructuredDiffList
          hunks={bounded.hunks}
          dim={false}
          width={innerWidth}
          filePath={file_path}
          firstLine={loaded.firstLine}
          fileContent={loaded.fileContent}
        />
        {bounded.hiddenLines > 0 ? (
          <Text dimColor>
            … +{bounded.hiddenLines} more line{bounded.hiddenLines === 1 ? '' : 's'} · ctrl+f expands · the whole edit applies
          </Text>
        ) : null}
        {consentBudget === null ? (
          <Text dimColor>ctrl+f collapses the preview</Text>
        ) : null}
      </>
    )

  if (framed && loaded !== null) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        <Text bold>{name}</Text>
        {body}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{'╌'.repeat(outerWidth)}</Text>
      {body}
      <Text dimColor>{'╌'.repeat(outerWidth)}</Text>
    </Box>
  )
}

export default FileEditToolDiff
