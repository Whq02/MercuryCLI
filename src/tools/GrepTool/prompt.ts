import { flagEnabled } from '../../substrate/flagRegistry.js'

export const GREP_TOOL_NAME = 'Grep'

let rankedMode: boolean | undefined

export function rankedModeEnabled(): boolean {
  return (rankedMode ??= flagEnabled('MERCURY_GREP_RANKED'))
}

export function getDescription(offered: ReadonlySet<string> | null = null): string {
  void offered
  const description = 'Searches file contents with ripgrep and returns the matching paths, lines or counts. PDFs and office, EPUB and RTF documents are searched as their extracted text, with page or section labels.'
  if (!rankedModeEnabled()) return description
  return `${description} With output_mode "ranked", pattern is plain words that describe a behaviour, and the answer is the few files and line ranges that hold those words most densely.`
}
