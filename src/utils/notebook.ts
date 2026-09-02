import { readFile } from 'node:fs/promises'

import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { formatOutput } from '../tools/BashTool/utils.js'
import type {
  NotebookCell,
  NotebookCellOutput,
  NotebookCellSource,
  NotebookCellSourceOutput,
  NotebookContent,
  NotebookMimeBundle,
  NotebookOutputImage,
} from '../types/notebook.js'
import type { ContentBlockParam, ImageBlockParam, TextBlockParam, ToolResultBlockParam } from '../types/wire.js'
import { expandPath } from './path.js'

/**
 * Read a Jupyter notebook into cell records and project them into a tool
 * result.
 */

const LARGE_OUTPUT_THRESHOLD = 10_000
const DEFAULT_LANGUAGE = 'python'

function joinSource(source: string | string[] | undefined): string {
  if (source === undefined) return ''
  return Array.isArray(source) ? source.join('') : source
}

/** Notebook outputs obey the same truncation rules as shell output. */
function processText(text: string | string[] | undefined): string {
  if (text === undefined) return ''
  const joined = Array.isArray(text) ? text.join('') : text
  return formatOutput(joined).truncatedContent
}

/** PNG preferred, JPEG fallback; notebook files wrap base64, so whitespace is removed. */
function extractImage(data: NotebookMimeBundle | undefined): NotebookOutputImage | undefined {
  if (!data) return undefined
  const png = data['image/png']
  if (png !== undefined) return { image_data: joinSource(png).replace(/\s/g, ''), media_type: 'image/png' }
  const jpeg = data['image/jpeg']
  if (jpeg !== undefined) return { image_data: joinSource(jpeg).replace(/\s/g, ''), media_type: 'image/jpeg' }
  return undefined
}

/** An unknown output kind (possible on disk) yields a hole — reproduced, not repaired. */
function processOutput(output: NotebookCellOutput): NotebookCellSourceOutput | undefined {
  switch (output.output_type) {
    case 'stream':
      return { output_type: output.output_type, text: processText(output.text) }
    case 'execute_result':
    case 'display_data':
      return {
        output_type: output.output_type,
        text: processText(output.data?.['text/plain']),
        image: extractImage(output.data),
      }
    case 'error':
      return {
        output_type: output.output_type,
        text: processText(`${output.ename}: ${output.evalue}\n${(output.traceback ?? []).join('\n')}`),
      }
    default:
      return undefined
  }
}

/** The running total short-circuits as soon as the threshold is crossed; holes are skipped. */
function outputsAreLarge(outputs: Array<NotebookCellSourceOutput | undefined>): boolean {
  let total = 0
  for (const output of outputs) {
    if (!output) continue
    total += (output.text?.length ?? 0) + (output.image?.image_data.length ?? 0)
    if (total > LARGE_OUTPUT_THRESHOLD) return true
  }
  return false
}

function processCell(cell: NotebookCell, index: number, language: string, includeLargeOutputs: boolean): NotebookCellSource {
  const cellId = cell.id ?? `cell-${index}`
  const record: NotebookCellSource = {
    cellType: cell.cell_type,
    source: joinSource(cell.source),
    cell_id: cellId,
  }
  if (cell.cell_type === 'code') {
    if (cell.execution_count) record.execution_count = cell.execution_count
    // The language is attached to code cells only, so text cells are not mislabelled.
    record.language = language
    if (cell.outputs && cell.outputs.length > 0) {
      const processed = cell.outputs.map(processOutput)
      if (!includeLargeOutputs && outputsAreLarge(processed)) {
        record.outputs = [
          {
            output_type: 'stream',
            text:
              `Outputs are too large to include. Use ${BASH_TOOL_NAME} to read them: ` +
              `cat <notebook_path> | jq '.cells[${index}].outputs'`,
          },
        ]
      } else {
        record.outputs = processed as NotebookCellSourceOutput[]
      }
    }
  }
  return record
}

/** A named cell throws when absent and is processed with large outputs INCLUDED; otherwise every cell, large outputs excluded. */
export async function readNotebook(notebookPath: string, cellId?: string): Promise<NotebookCellSource[]> {
  const absolute = expandPath(notebookPath)
  const bytes = await readFile(absolute)
  const notebook = JSON.parse(bytes.toString('utf8')) as NotebookContent
  const language = notebook.metadata?.language_info?.name ?? DEFAULT_LANGUAGE
  const cells = notebook.cells ?? []
  if (cellId !== undefined) {
    const index = cells.findIndex((cell, i) => (cell.id ?? `cell-${i}`) === cellId)
    if (index === -1) throw new Error(`Cell with id "${cellId}" not found in the notebook`)
    return [processCell(cells[index] as NotebookCell, index, language, true)]
  }
  return cells.map((cell, index) => processCell(cell, index, language, false))
}

/** Adjacent text blocks are merged with a newline separator so runs of text do not become many tiny blocks. */
export function mapNotebookCellsToToolResult(data: NotebookCellSource[], toolUseID: string): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | ImageBlockParam> = []
  for (const cell of data) {
    const cellType = cell.cellType !== 'code' ? `<cell_type>${cell.cellType}</cell_type>` : ''
    const language = cell.cellType === 'code' && cell.language && cell.language !== DEFAULT_LANGUAGE ? `<language>${cell.language}</language>` : ''
    blocks.push({ type: 'text', text: `<cell id="${cell.cell_id}">${cellType}${language}${cell.source}</cell id="${cell.cell_id}">` })
    for (const output of cell.outputs ?? []) {
      if (output.text) blocks.push({ type: 'text', text: `\n${output.text}` })
      if (output.image) {
        blocks.push({ type: 'image', source: { type: 'base64', data: output.image.image_data, media_type: output.image.media_type } })
      }
    }
  }
  const merged: Array<TextBlockParam | ImageBlockParam> = []
  for (const block of blocks) {
    const previous = merged[merged.length - 1]
    if (block.type === 'text' && previous && previous.type === 'text') {
      previous.text = `${previous.text}\n${block.text}`
      continue
    }
    merged.push(block.type === 'text' ? { ...block } : block)
  }
  return { type: 'tool_result', tool_use_id: toolUseID, content: merged as ContentBlockParam[] as ToolResultBlockParam['content'] }
}

/** Exactly the positional form `cell-<digits>`; anything else yields nothing. */
export function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId)
  if (!match) return undefined
  const index = parseInt(match[1] as string, 10)
  return Number.isFinite(index) ? index : undefined
}
