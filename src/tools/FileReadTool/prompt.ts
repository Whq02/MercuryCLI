export const FILE_READ_TOOL_NAME = 'Read'

export const MAX_LINES_TO_READ = 2000

export const MAX_PDF_PAGES_PER_REQUEST = 20

export const DESCRIPTION = 'Read the contents of a local file.'

export const LINE_FORMAT_INSTRUCTION =
  'a line number followed by a tab, then the line content'

const STOCK_DIRECTORY_LINE = 'Files only: a directory path is refused.'

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
  const images = media.images
    ? 'Images are shown as pictures, or as recognised text with `ocr`.'
    : 'Images return recognised text through an installed OCR engine, or the installation needed when none is available.'
  const pdfs = 'PDFs open as numbered text with page markers, or as page pictures with `pages`; a scanned page is read by OCR.'
  const targets = targetLines ?? STOCK_DIRECTORY_LINE
  return `Reads a local file and returns its text with up to ${MAX_LINES_TO_READ} lines, each prefixed by ${lineFormat}; the prefix is not file content. A result that is not the whole file names the unread range.

${images} ${pdfs} Notebooks come back cell by cell with their outputs; office documents, EPUB and RTF as text; archives (\`<archive>:<entry>\`) and SQLite databases (\`<db>:<table>\`) one entry or table at a time; audio and video as timestamped transcripts.

${targets}`
}
