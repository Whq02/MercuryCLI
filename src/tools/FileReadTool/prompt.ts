import { BASH_TOOL_NAME } from '../BashTool/toolName.js'


export const FILE_READ_TOOL_NAME = 'Read'

export const MAX_LINES_TO_READ = 2000

export const MAX_PDF_PAGES_PER_REQUEST = 20

export const PDF_INLINE_PAGE_THRESHOLD = 10

export const DESCRIPTION = 'Read the contents of a local file.'

export const LINE_FORMAT_INSTRUCTION =
  'a line number followed by a tab, then the line content'

export const LINE_FORMAT_INSTRUCTION_LEGACY =
  'a right-aligned line number followed by an arrow (→), then the line content'

export const OFFSET_INSTRUCTION_DEFAULT =
  'Reading the entire file is fine — prefer that unless the file is huge.'

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
    ? `- Image files (PNG, JPG, and similar) are presented visually: Mercury is a multimodal LLM and sees the picture itself.`
    : `- Image files (PNG, JPG, and similar) cannot be shown to the current model — an image read returns an \`[image]\` placeholder, not the picture. Report that honestly rather than describing pixels you never saw.`
  const pdfLines = media.pdf
    ? `\n- This tool can read PDF files. PDFs with more than ${PDF_INLINE_PAGE_THRESHOLD} pages REQUIRE the \`pages\` parameter (e.g. "1-5"); reading a large PDF without it will fail. At most ${MAX_PDF_PAGES_PER_REQUEST} pages can be requested at once.`
    : ''
  const screenshotLine = media.images
    ? `\n- Screenshot paths arrive often; when the user supplies one, ALWAYS open it with this tool — temporary file paths work fine.`
    : ''
  const directoryLines = targetLines ?? STOCK_DIRECTORY_LINE
  return `Read the contents of a local file. Any file on the machine can be targeted directly with this tool.
Treat every provided path as readable and every user-supplied path as valid; a path that turns out not to exist simply returns an error, so attempting the read is always safe.

Usage:
- file_path must be an absolute path — relative paths are rejected
- With no window parameters the read returns up to ${MAX_LINES_TO_READ} lines from the top of the file${maxSizeInstruction}
- An optional line offset and limit narrow the window (handy for very long files), though leaving them out and taking the whole file is the recommended default. ${offsetInstruction}
- Individual lines are cut off past 2000 characters
- Every returned line carries a prefix — ${lineFormat} — with numbering starting at 1
${imageLine}${pdfLines}
- Jupyter notebooks (.ipynb files) come back cell by cell with their outputs — code, text output, and visualizations together.
${directoryLines}${screenshotLine}
- A file that exists but is empty produces a system-reminder note in place of content.`
}
