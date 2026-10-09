import { BASH_TOOL_NAME } from '../BashTool/toolName.js'


export const FILE_READ_TOOL_NAME = 'Read'

export const MAX_LINES_TO_READ = 2000

export const MAX_PDF_PAGES_PER_REQUEST = 20

export const DESCRIPTION = 'Read the contents of a local file.'

export const LINE_FORMAT_INSTRUCTION =
  'a line number followed by a tab, then the line content'

export const OFFSET_INSTRUCTION_DEFAULT =
  'Leaving them out and taking the whole file is the default unless the file is huge.'

export const OFFSET_INSTRUCTION_TARGETED =
  'If you already know which region you need, read just that slice — this matters for big files.'

const STOCK_DIRECTORY_LINE = `- This tool reads files, never directories. A directory wants a listing command through the ${BASH_TOOL_NAME} tool.`

export const FILE_UNCHANGED_STUB =
  'This file is unchanged since it was last read. The earlier result above remains current — lean on it rather than reading again.'

export interface ReadMediaPosture {
  pdf: boolean
  images: boolean
}

export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
  media: ReadMediaPosture,
  targetLines?: string,
): string {
  const imageLine = media.images
    ? `- Image files (PNG, JPG, and similar) are shown as the picture itself.`
    : `- Image files (PNG, JPG, and similar) cannot be shown to the current model — an image read returns an \`[image]\` placeholder, not the picture. Report that honestly rather than describing pixels you never saw.`
  const pdfLines = media.pdf
    ? `\n- This tool reads PDF files; PDFs with more than ${MAX_PDF_PAGES_PER_REQUEST} pages need the \`pages\` parameter (e.g. "1-5"), at most ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`
    : ''
  const screenshotLine = media.images
    ? `\n- A screenshot path the user supplies is read with this tool, a temporary path included.`
    : ''
  const directoryLines = targetLines ?? STOCK_DIRECTORY_LINE
  return `Read the contents of a local file: any file on the machine, and a path that does not exist returns an error.

Usage:
- With no window parameters the read returns up to ${MAX_LINES_TO_READ} lines from the top of the file. A result that is not the whole file closes its numbered lines with \`[lines 1-2000 of 3000 — Read(offset: 2001, limit: 1000) continues from there]\` or \`[lines 2001-3000 of 3000 — the end of the file]\`; without that line it is the whole file${maxSizeInstruction}
- An optional line offset and limit narrow the window (handy for very long files). ${offsetInstruction}
- Individual lines are cut off past 2000 characters
- Every returned line carries a prefix — ${lineFormat} — with numbering starting at 1
${imageLine}${pdfLines}
- Jupyter notebooks (.ipynb files) come back cell by cell with their outputs — code, text output, and visualizations together.
${directoryLines}${screenshotLine}
- A file that exists but is empty produces a system-reminder note in place of content.`
}
