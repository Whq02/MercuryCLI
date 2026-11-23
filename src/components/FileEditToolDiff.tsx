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

function safeDiffToolInputs(filePath: string, edits: CompleteEdit[]): LoadedDiff {
  try {
    return diffToolInputs(filePath, edits)
  } catch (err) {
    passedOver(err)
    return { hunks: [], firstLine: null }
  }
}

function ensureTrailingLf(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

function diffRemoteEdits(filePath: string, edits: CompleteEdit[]): LoadedDiff {
  const normalized = edits.map(edit => ({
    ...edit,
    old_string: ensureTrailingLf(edit.old_string),
    new_string: ensureTrailingLf(edit.new_string),
  }))
  const base = normalized.map(edit => edit.old_string).join('')
  try {
    const { patch } = getPatchForEdits({
      filePath,
      fileContents: base,
      edits: normalized,
    })
    return { hunks: patch, firstLine: null }
  } catch (err) {
    logError(err)
    const hunks: StructuredPatchHunk[] = []
    for (const edit of normalized) {
      try {
        const { patch } = getPatchForEdits({
          filePath,
          fileContents: edit.old_string,
          edits: [edit],
        })
        hunks.push(...patch)
      } catch (singleErr) {
        passedOver(singleErr)
      }
    }
    return { hunks, firstLine: null }
  }
}

export async function loadDiff(
  filePath: string,
  rawEdits: Edit[],
): Promise<LoadedDiff> {
  const edits: CompleteEdit[] = rawEdits.filter(
    (edit): edit is CompleteEdit =>
      typeof edit.old_string === 'string' && typeof edit.new_string === 'string',
  )
  if (edits.length === 0) return { hunks: [], firstLine: null }

  if (isRemotePath(filePath)) {
    return diffRemoteEdits(filePath, edits)
  }

  if (edits.length === 1 && edits[0]!.old_string.length >= CHUNK_SIZE) {
    return safeDiffToolInputs(filePath, edits)
  }

  let handle: Awaited<ReturnType<typeof openForScan>> = null
  try {
    handle = await openForScan(filePath)
    if (handle === null) return safeDiffToolInputs(filePath, edits)

    if (edits.length > 1 || edits[0]!.old_string === '') {
      const content = await readCapped(handle)
      if (content === null) return safeDiffToolInputs(filePath, edits)
      const { patch } = getPatchForEdits({
        filePath,
        fileContents: content,
        edits,
      })
      const firstLine = content.length > 0 ? content.split('\n')[0] ?? null : null
      return { hunks: patch, firstLine, fileContent: content }
    }

    const context = await scanForContext(handle, edits[0]!.old_string, SCAN_CONTEXT_LINES)
    if (context.truncated || context.content === '') {
      return safeDiffToolInputs(filePath, edits)
    }
    const { patch } = getPatchForEdits({
      filePath,
      fileContents: context.content,
      edits,
    })
    const hunks =
      context.lineOffset > 1 ? adjustHunkLineNumbers(patch, context.lineOffset - 1) : patch
    const firstLine =
      context.lineOffset === 1 ? context.content.split('\n')[0] ?? null : null
    return { hunks, firstLine }
  } catch (err) {
    logError(err)
    return safeDiffToolInputs(filePath, edits)
  } finally {
    if (handle !== null) {
      await handle.close().catch(passedOver)
    }
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
  const editsKey = JSON.stringify(edits)

  useLoad(signal => {
    setLoaded(null)
    void loadDiff(file_path, edits)
      .then(result => {
        if (!signal.aborted) setLoaded(result)
      })
      .catch(err => {
        logError(err)
        if (!signal.aborted) setLoaded({ hunks: [], firstLine: null })
      })
  }, [file_path, editsKey])

  if (loaded === null) {
    return <Text dimColor>…</Text>
  }

  const name = basename(file_path)
  if (loaded.hunks.length === 0) {
    return <Text dimColor>{name}: no visible change</Text>
  }

  const outerWidth = Math.max(1, availableWidth ?? columns - 2)
  const wide = columns > 80
  const diffWidth = wide
    ? Math.max(1, (availableWidth ?? columns) - FRAME_COLUMNS)
    : outerWidth
  const bounded =
    consentBudget !== undefined
      ? boundHunks(loaded.hunks, diffPaintWidth(diffWidth, loaded.hunks), consentBudget)
      : { hunks: loaded.hunks, hiddenLines: 0, cut: false }

  const body = (
    <Box flexDirection="column">
      <StructuredDiffList
        hunks={bounded.hunks}
        dim={false}
        width={diffWidth}
        filePath={file_path}
        firstLine={loaded.firstLine}
        fileContent={loaded.fileContent}
      />
      {bounded.hiddenLines > 0 ? (
        <Text dimColor>
          … +{bounded.hiddenLines} more line{bounded.hiddenLines === 1 ? '' : 's'} · ctrl+f expands · the whole edit applies
        </Text>
      ) : consentBudget === null ? (
        <Text dimColor>ctrl+f collapses the preview</Text>
      ) : null}
    </Box>
  )

  if (wide) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        width={outerWidth}
      >
        <Text bold>{name}</Text>
        {body}
      </Box>
    )
  }

  const rule = '╌'.repeat(outerWidth)
  return (
    <Box flexDirection="column" width={outerWidth}>
      <Text dimColor>{rule}</Text>
      <Text bold>{name}</Text>
      {body}
      <Text dimColor>{rule}</Text>
    </Box>
  )
}

export default FileEditToolDiff
