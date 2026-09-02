
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
import {
  boundHunksToRows,
  boundedPreviewPlan,
  totalHunkRows,
} from './permissions/boundedDiffPreview.js'
import { StructuredDiffList } from './StructuredDiffList.js'

const SCAN_CONTEXT_LINES = 3

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
  consentRowBudget = null,
}: {
  file_path: string
  edits: Edit[]
  consentRowBudget?: number | null
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
  const innerWidth = Math.max(1, columns - 2 - (framed ? 2 : 0))
  const name = basename(file_path)

  if (loaded && loaded.hunks.length === 0) {
    return (
      <Text dimColor>
        {name}: no visible change
      </Text>
    )
  }

  const plan =
    loaded !== null && consentRowBudget !== null
      ? boundedPreviewPlan(totalHunkRows(loaded.hunks), consentRowBudget, false)
      : null
  const shownHunks =
    loaded === null
      ? []
      : plan !== null && plan.hidden > 0
        ? boundHunksToRows(loaded.hunks, plan.shown)
        : loaded.hunks

  const body =
    loaded === null ? (
      <Text dimColor>…</Text>
    ) : (
      <>
        <StructuredDiffList
          hunks={shownHunks}
          dim={false}
          width={innerWidth}
          filePath={file_path}
          firstLine={loaded.firstLine}
          fileContent={loaded.fileContent}
        />
        {plan !== null && plan.hidden > 0 ? (
          <Text dimColor>
            … +{plan.hidden} more line{plan.hidden === 1 ? '' : 's'} · ctrl+f expands · the whole edit applies
          </Text>
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
      <Text dimColor>{'╌'.repeat(Math.max(1, columns - 2))}</Text>
      {body}
      <Text dimColor>{'╌'.repeat(Math.max(1, columns - 2))}</Text>
    </Box>
  )
}

export default FileEditToolDiff
