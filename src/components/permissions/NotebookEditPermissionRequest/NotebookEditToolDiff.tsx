import * as React from 'react'
import { useMemo, useState } from 'react'
import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { Box, NoSelect, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useLoad } from '../../../hooks/effects.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import {
  boundHunks,
  boundLines,
  consentBodyBudget,
  consentContentWidth,
  diffPaintWidth,
  filePaintWidth,
} from '../consentBodyBudget.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import { intersperse } from '../../../utils/array.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { parseCellId } from '../../../utils/notebook.js'
import { passedOver } from '../../../utils/passedOver.js'
import type { StructuredPatchHunk } from 'diff'
import { z } from 'zod/v4'

const notebookCellSchema = z.object({
  id: z.string().optional(),
  cell_type: z.string().optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
})

const notebookSchema = z.object({
  cells: z.array(notebookCellSchema).optional(),
})

type NotebookCell = z.infer<typeof notebookCellSchema>
type NotebookDocument = z.infer<typeof notebookSchema>

type Props = {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: string
  edit_mode?: string
  verbose?: boolean
}

const FRAME_COLUMNS = 4

function cellSourceText(cell: NotebookCell | undefined): string {
  if (!cell || cell.source === undefined) return ''
  return typeof cell.source === 'string' ? cell.source : cell.source.join('')
}

export function NotebookEditToolDiff({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode,
  verbose = false,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState<{ path: string; data: NotebookDocument } | null>(null)

  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })

  useLoad(signal => {
    setLoaded(prev => (prev === null ? prev : null))
    fs.readFile(notebook_path, 'utf8')
      .then(raw => {
        if (signal.aborted) return
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          passedOver(error)
          setLoaded(null)
          return
        }
        const result = notebookSchema.safeParse(parsed)
        if (result.success) {
          setLoaded({ path: notebook_path, data: result.data })
        } else {
          setLoaded(null)
        }
      })
      .catch(passedOver)
  }, [notebook_path])

  const notebook = loaded?.path === notebook_path ? loaded.data : null

  const targetCell = useMemo((): NotebookCell | undefined => {
    const cells = notebook?.cells
    if (!Array.isArray(cells) || !cell_id) return undefined
    const exact = cells.find(cell => cell.id === cell_id)
    if (exact) return exact
    const index = parseCellId(cell_id)
    return index !== undefined ? cells[index] : undefined
  }, [notebook, cell_id])

  const oldSource = cellSourceText(targetCell)
  const mode = edit_mode ?? 'replace'
  const isMarkdown = (cell_type ?? targetCell?.cell_type) === 'markdown'
  const highlightPath = isMarkdown ? `${notebook_path}.md` : notebook_path
  const width = Math.max(1, consentContentWidth(columns) - FRAME_COLUMNS)
  const budget = expanded ? null : consentBodyBudget(rows)

  const hunks = useMemo<StructuredPatchHunk[]>(() => {
    if (mode !== 'replace' || notebook === null) return []
    return getPatchForDisplay({
      filePath: highlightPath,
      fileContents: oldSource,
      edits: [{ old_string: oldSource, new_string: new_source }],
    })
  }, [mode, notebook, highlightPath, oldSource, new_source])

  const displayPath = verbose
    ? notebook_path
    : relative(getFocusedSessionConnector().workspace().cwd, notebook_path)
  const actionLabel =
    mode === 'insert'
      ? 'Insert new cell'
      : mode === 'delete'
        ? 'Delete cell'
        : 'Replace cell contents'
  const subtitle = `${actionLabel}${cell_id ? ` ${cell_id}` : ''}${cell_type ? ` (${cell_type})` : ''}`

  const useDiff = mode === 'replace' && notebook !== null && hunks.length > 0
  const boundedDiff = useMemo(
    () => (useDiff ? boundHunks(hunks, diffPaintWidth(width, hunks), budget) : null),
    [useDiff, hunks, width, budget],
  )

  const codeSource = mode === 'delete' ? oldSource : new_source
  const boundedCode = useMemo(() => {
    if (useDiff) return null
    const lines = codeSource.split('\n')
    return boundLines(lines, filePaintWidth(width, lines.length), budget)
  }, [useDiff, codeSource, width, budget])

  const hiddenLines = boundedDiff ? boundedDiff.hiddenLines : (boundedCode?.hiddenLines ?? 0)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{displayPath}</Text>
        <Text dimColor>{subtitle}</Text>
      </Box>
      {boundedDiff ? (
        <Box flexDirection="column">
          {intersperse<React.ReactNode>(
            boundedDiff.hunks.map((hunk, i) => (
              <StructuredDiff
                key={`${hunk.oldStart}-${hunk.newStart}-${i}`}
                patch={hunk}
                dim={false}
                width={width}
                filePath={highlightPath}
              />
            )),
            i => (
              <NoSelect key={`ellipsis-${i}`}>
                <Text dimColor>...</Text>
              </NoSelect>
            ),
          )}
        </Box>
      ) : (
        <HighlightedCode
          code={(boundedCode?.lines ?? []).join('\n')}
          filePath={highlightPath}
          width={width}
        />
      )}
      {hiddenLines > 0 ? (
        <NoSelect>
          <Text dimColor>
            … +{hiddenLines} more line{hiddenLines === 1 ? '' : 's'} · ctrl+f expands (the whole edit applies)
          </Text>
        </NoSelect>
      ) : null}
      {expanded ? (
        <NoSelect>
          <Text dimColor>ctrl+f collapses the preview</Text>
        </NoSelect>
      ) : null}
    </Box>
  )
}
