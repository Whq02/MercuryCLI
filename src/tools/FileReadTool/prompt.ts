import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const FILE_READ_TOOL_NAME = 'Read'

export const MAX_LINES_TO_READ = 2000

export const MAX_PDF_PAGES_PER_REQUEST = 20

export const DESCRIPTION = 'Read the contents of a local file.'

export const LINE_FORMAT_INSTRUCTION =
  'a line number followed by a tab, then the line content'

const STOCK_DIRECTORY_LINE = `- This tool reads files, never directories. A directory wants a listing command through the ${BASH_TOOL_NAME} tool.`

export const FILE_UNCHANGED_STUB =
  'This file is unchanged since it was last read. The earlier result above remains current — lean on it rather than reading again.'

interface ReadMediaPosture {
  pdf: boolean
  images: boolean
}

export function renderPromptTemplate(
  lineFormat: string,
  media: ReadMediaPosture,
  targetLines?: string,
): string {
  const imageLine = media.images
    ? `- Image files (PNG, JPG, and similar) are shown as the picture itself; \`ocr: true\` returns recognised text instead.`
    : `- Image files (PNG, JPG, and similar) return recognised text through an installed OCR engine; when none is available, the result names the installation needed.`
  const pdfLines = `\n- PDFs open as numbered text with page markers on every model; offset, limit and ranges select text lines. The pages parameter selects page pictures on image-capable models, otherwise those pages as text. Scanned pages use an installed OCR engine, falling back to native PDF input when OCR cannot read them.`
  const screenshotLine = media.images
    ? `\n- A screenshot path the user supplies is read with this tool, a temporary path included.`
    : ''
  const directoryLines = targetLines ?? STOCK_DIRECTORY_LINE
  return `Read the contents of a local file: any file on the machine, and a path that does not exist returns an error.

Usage:
- With no window parameters the read returns up to ${MAX_LINES_TO_READ} lines from the top of the file. A result that is not the whole file closes its numbered lines with \`[lines 1-2000 of 3000 — Read(offset: 2001, limit: 1000) continues from there]\` or \`[lines 2001-3000 of 3000 — the end of the file]\`; without that line it is the whole file
- An optional line offset and limit narrow the window.
- Individual lines are cut off past 2000 characters; use \`lossless: true\` with \`offset\` + \`limit\` or \`ranges\` to show them completely within the same total budget. A clipped line does not authorise replacing its unseen text.
- Every returned line carries a prefix — ${lineFormat} — with numbering starting at 1
${imageLine}${pdfLines}
- Jupyter notebooks (.ipynb files) come back cell by cell with their outputs — code, text output, and visualizations together.
- Archives (.zip, .tar, .tar.gz, .tgz; \`<archive>:<entry>\` reads one entry), SQLite databases (.sqlite, .sqlite3, .db; \`<db>:<table>\` reads one table), and documents (.docx, .xlsx, .pptx, .odt, .ods, .odp, .epub, .rtf) open as text; \`offset: -N\` reads the last N lines and \`ranges\` reads several line ranges in one call.
${directoryLines}${screenshotLine}
- A file that exists but is empty produces a system-reminder note in place of content.`
}
