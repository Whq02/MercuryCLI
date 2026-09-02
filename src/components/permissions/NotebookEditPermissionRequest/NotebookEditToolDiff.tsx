import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { promises as fs } from 'node:fs'
import { relative } from 'node:path'
import { Box, NoSelect, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
// The row budget, plan and hunk walk live in ../boundedDiffPreview.ts — the
// ONE home of the bounded-preview law every diff-bearing consent card rides
// (prove-consent-preview-bounded §5 pins this card onto it).
import {
  boundHunksToRows,
  boundedPreviewPlan,
  consentDiffBudget,
  totalHunkRows,
} from '../boundedDiffPreview.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import { intersperse } from '../../../utils/array.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { parseCellId } from '../../../utils/notebook.js'
import { safeParseJSON } from '../../../utils/json.js'
import type { StructuredPatchHunk } from 'diff'

type NotebookCell = {
  id?: string
  cell_type?: string
  source?: string | string[]
}

type Props = {
  notebook_path: string
  cell_id: string
  new_source: string
  cell_type?: string
  edit_mode?: string
  verbose: boolean
  width: number
}

function cellSourceText(cell: NotebookCell | undefined): string {
  if (!cell || cell.source === undefined) return ''
  return typeof cell.source === 'string' ? cell.source : cell.source.join('')
}

/**
 * The notebook cell diff/preview. The notebook is read and JSON-parsed
 * asynchronously, once per path; a read or parse failure yields no notebook
 * and renders empty old content — never an error.
 */
export function NotebookEditToolDiff({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode,
  verbose,
  width,
}: Props): React.ReactNode {
  const [cells, setCells] = useState<NotebookCell[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void fs
      .readFile(notebook_path, 'utf8')
      .then(raw => {
        if (cancelled) return
        const parsed = safeParseJSON(raw) as { cells?: NotebookCell[] } | null
        setCells(Array.isArray(parsed?.cells) ? parsed.cells : null)
      })
      .catch(() => {
        if (!cancelled) setCells(null)
      })
    return () => {
      cancelled = true
    }
  }, [notebook_path])

  // Locate the cell by numeric index when the id parses as one, else by id.
  const oldSource = useMemo(() => {
    if (!cells || cell_id === '') return ''
    const index = parseCellId(cell_id)
    const cell =
      typeof index === 'number'
        ? cells[index]
        : cells.find(candidate => candidate.id === cell_id)
    return cellSourceText(cell)
  }, [cells, cell_id])

  const mode = edit_mode ?? 'replace'

  // THE BOUNDED-PREVIEW LAW: a big cell (delete shows the whole old source,
  // insert the whole new one, replace the whole diff) must never push the
  // card's own Yes/No off the pane — the blind-Enter stranding class. The
  // preview spends viewport-derived rows, the cut is named, and the full
  // body is one explicit chord away.
  const { rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  const budget = consentDiffBudget(rows)

  // insert/delete modes — and a notebook that failed to load — compute no diff.
  const hunks = useMemo(() => {
    if (mode !== 'replace' || cells === null) return null
    return getPatchForDisplay({
      filePath: notebook_path,
      fileContents: oldSource,
      edits: [{ old_string: oldSource, new_string: new_source, replace_all: false }],
    })
  }, [mode, cells, notebook_path, oldSource, new_source])

  // The bounded projection of whichever branch renders: replace bounds the
  // hunk list at line granularity; insert/delete (and a load-failure
  // fallback) bound the body's line list directly.
  const bounded = useMemo(() => {
    if (mode === 'replace' && hunks && hunks.length > 0) {
      const total = totalHunkRows(hunks)
      const plan = boundedPreviewPlan(total, budget, expanded)
      if (plan.hidden === 0) return { hunks, body: null, hidden: 0 }
      return { hunks: boundHunksToRows(hunks, plan.shown), body: null, hidden: plan.hidden }
    }
    const source = mode === 'delete' ? oldSource : new_source
    const lines = source.split('\n')
    const plan = boundedPreviewPlan(lines.length, budget, expanded)
    return { hunks: null, body: lines.slice(0, plan.shown).join('\n'), hidden: plan.hidden }
  }, [mode, hunks, oldSource, new_source, budget, expanded])

  const displayPath = verbose ? notebook_path : relative(getFocusedSessionConnector().workspace().cwd, notebook_path)
  const operation =
    mode === 'insert' ? 'Insert new cell' : mode === 'delete' ? 'Delete cell' : 'Replace cell contents'
  // Markdown cells highlight as markdown; everything else follows the path.
  const highlightPath = cell_type === 'markdown' ? `${notebook_path}.md` : notebook_path

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
      <Text bold>{displayPath}</Text>
      <Text dimColor>
        {operation} {cell_id}
        {cell_type ? ` (${cell_type})` : ''}
      </Text>
      {bounded.hunks ? (
        intersperse(
          bounded.hunks.map((hunk: StructuredPatchHunk) => (
            <StructuredDiff
              key={hunk.newStart}
              patch={hunk}
              dim={false}
              filePath={notebook_path}
              firstLine={new_source.split('\n')[0] ?? null}
              fileContent={oldSource}
              width={width}
            />
          )),
          (index: number) => (
            <NoSelect fromLeftEdge key={`ellipsis-${index}`}>
              <Text dimColor>...</Text>
            </NoSelect>
          ),
        )
      ) : (
        <HighlightedCode code={bounded.body ?? ''} filePath={highlightPath} />
      )}
      {bounded.hidden > 0 ? (
        <NoSelect fromLeftEdge>
          <Text dimColor>
            … +{bounded.hidden} more line{bounded.hidden === 1 ? '' : 's'} · ctrl+f expands (the whole edit applies)
          </Text>
        </NoSelect>
      ) : null}
      {expanded ? (
        <NoSelect fromLeftEdge>
          <Text dimColor>ctrl+f collapses the preview</Text>
        </NoSelect>
      ) : null}
    </Box>
  )
}
