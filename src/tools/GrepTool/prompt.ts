export const GREP_TOOL_NAME = 'Grep'

export function getDescription(offered: ReadonlySet<string> | null = null): string {
  void offered
  return 'Searches file contents with ripgrep and returns the matching paths, lines or counts. PDFs and office, EPUB and RTF documents are searched as their extracted text, with page or section labels.'
}
