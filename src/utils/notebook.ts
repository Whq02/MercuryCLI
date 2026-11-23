import { z } from 'zod'
import { BASH_TOOL_NAME } from '../constants/tools/bash.js'
import { formatOutput } from './shell/utils.js'
import type {
  NotebookCellSource,
  NotebookCellSourceOutput,
  NotebookOutputImage,
} from '../types/notebook.js'
import type { ImageBlockParam, TextBlockParam, ToolResultBlockParam } from '../types/wire.js'
import { expandPath } from './path.js'
import { readRegularFile } from './regularFile.js'

const StringOrLinesSchema = z.union([z.string(), z.array(z.string())])

const MimeBundleSchema = z.object({
  'text/plain': StringOrLinesSchema.optional().catch(undefined),
  'image/png': StringOrLinesSchema.optional().catch(undefined),
  'image/jpeg': StringOrLinesSchema.optional().catch(undefined),
})

const CellOutputSchema = z.discriminatedUnion('output_type', [
  z.object({
    output_type: z.literal('stream'),
    text: StringOrLinesSchema.optional(),
  }),
  z.object({
    output_type: z.literal('display_data'),
    data: MimeBundleSchema.optional(),
  }),
  z.object({
    output_type: z.literal('execute_result'),
    data: MimeBundleSchema.optional(),
  }),
  z.object({
    output_type: z.literal('error'),
    ename: z.string().optional(),
    evalue: z.string().optional(),
    traceback: z.array(z.string()).optional(),
  }),
])

const NotebookCellSchema = z.object({
  cell_type: z.enum(['code', 'markdown', 'raw']),
  id: z.string().optional(),
  source: StringOrLinesSchema.optional(),
  execution_count: z.number().nullable().optional(),
  outputs: z.array(CellOutputSchema).optional(),
})

const NotebookSchema = z.object({
  cells: z.array(NotebookCellSchema).optional(),
  metadata: z.object({
    language_info: z.object({
      name: z.string().optional(),
    }).optional(),
  }).optional(),
})

type ParsedMimeBundle = z.infer<typeof MimeBundleSchema>
type ParsedNotebookOutput = z.infer<typeof CellOutputSchema>
type ParsedNotebookCell = z.infer<typeof NotebookCellSchema>


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

function extractImage(data: ParsedMimeBundle): NotebookOutputImage | undefined {
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

function processOutput(output: ParsedNotebookOutput): NotebookCellSourceOutput {
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

function processCell(cell: ParsedNotebookCell, index: number, language: string, includeLargeOutputs: boolean): NotebookCellSource {
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
          text: `Outputs are too large to include. Use ${BASH_TOOL_NAME} with: jq '.cells[${index}].outputs' <notebook_path>`,
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
  const notebook = NotebookSchema.parse(JSON.parse(bytes.toString('utf8')))
  const language = notebook.metadata?.language_info?.name ?? DEFAULT_LANGUAGE
  const cells = notebook.cells ?? []
  if (cellId !== undefined) {
    const index = cells.findIndex((cell, i) => (cell.id ?? `cell-${i}`) === cellId)
    if (index === -1) throw new Error(`Cell with id "${cellId}" not found in the notebook`)
    return [processCell(cells[index]!, index, language, true)]
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
  return { type: 'tool_result', tool_use_id: toolUseID, content: merged }
}

export function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId)
  if (!match) return undefined
  const index = parseInt(match[1]!, 10)
  return Number.isFinite(index) ? index : undefined
}
