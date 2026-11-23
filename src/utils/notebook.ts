import { BASH_TOOL_NAME } from '../constants/tools/bash.js'
import { formatOutput } from './shell/utils.js'
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
import { readRegularFile } from './regularFile.js'


const LARGE_OUTPUT_THRESHOLD = 10_000
const DEFAULT_LANGUAGE = 'python'

function joinSource(source: string | string[] | undefined): string {
  if (source === undefined) return ''
  return Array.isArray(source) ? source.join('') : source
}

function processText(text: string | string[] | undefined): string {
  if (text === undefined) return ''
  const joined = Array.isArray(text) ? text.join('') : text
  return formatOutput(joined).truncatedContent
}

const outputWeight = (output: NotebookCellSourceOutput | undefined): number =>
  output ? (output.text?.length ?? 0) + (output.image?.image_data.length ?? 0) : 0

function extractImage(data: NotebookMimeBundle): NotebookOutputImage | undefined {
  const png = data['image/png']
  if (png !== undefined) {
    return { image_data: joinSource(png).replace(/\s/g, ''), media_type: 'image/png' }
  }
  const jpeg = data['image/jpeg']
  if (jpeg !== undefined) {
    return { image_data: joinSource(jpeg).replace(/\s/g, ''), media_type: 'image/jpeg' }
  }
  return undefined
}

function processOutput(output: NotebookCellOutput): NotebookCellSourceOutput {
  switch (output.output_type) {
    case 'stream':
      return { output_type: output.output_type, text: processText(output.text) }
    case 'display_data':
    case 'execute_result': {
      const data = output.data
      const text = data?.['text/plain'] !== undefined ? processText(data['text/plain']) : undefined
      const image = data !== undefined ? extractImage(data) : undefined
      return {
        output_type: output.output_type,
        ...(text !== undefined ? { text } : {}),
        ...(image !== undefined ? { image } : {}),
      }
    }
    case 'error': {
      const text = processText(
        output.traceback?.length ? output.traceback.join('\n') : `${output.ename}: ${output.evalue}`,
      )
      return { output_type: output.output_type, text }
    }
  }
}

function processCell(cell: NotebookCell, index: number, language: string, includeLargeOutputs: boolean): NotebookCellSource {
  const cellSource: NotebookCellSource = {
    cellType: cell.cell_type,
    source: joinSource(cell.source),
    cell_id: cell.id ?? `cell-${index}`,
  }
  if (cell.cell_type !== 'code') return cellSource
  cellSource.language = language
  if (cell.execution_count) cellSource.execution_count = cell.execution_count
  if (cell.outputs && cell.outputs.length > 0) {
    const processed = cell.outputs.map(processOutput)
    const totalWeight = processed.reduce((sum, output) => sum + outputWeight(output), 0)
    if (!includeLargeOutputs && totalWeight > LARGE_OUTPUT_THRESHOLD) {
      cellSource.outputs = [
        {
          output_type: 'stream',
          text: `Outputs are too large to include. Use ${BASH_TOOL_NAME} to read them:\ncat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ]
    } else {
      cellSource.outputs = processed
    }
  }
  return cellSource
}

export async function readNotebook(notebookPath: string, cellId?: string): Promise<NotebookCellSource[]> {
  const absolute = expandPath(notebookPath)
  const bytes = await readRegularFile(absolute)
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

export function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId)
  if (!match) return undefined
  const index = parseInt(match[1] as string, 10)
  return Number.isFinite(index) ? index : undefined
}
