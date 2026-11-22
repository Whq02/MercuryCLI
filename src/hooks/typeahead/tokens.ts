import type { SuggestionItem as Suggestion } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { ShellCompletionType } from '../../utils/bash/shellCompletion.js'
import { notBuilt } from '../../pi/holes.js'

export function extractSearchToken({
  token,
  isQuoted,
}: {
  token: string
  isQuoted?: boolean
}): string {
  if (isQuoted) {
    let inner = token
    if (inner.startsWith('@')) inner = inner.slice(1)
    if (inner.startsWith('"')) inner = inner.slice(1)
    if (inner.endsWith('"')) inner = inner.slice(0, -1)
    return inner
  }
  return token.startsWith('@') ? token.slice(1) : token
}

export function formatReplacementValue(arg0: {
  displayText: string
  mode: string
  hasAtPrefix: boolean
  needsQuotes: boolean
  isQuoted?: boolean
  isComplete: boolean
}): string {
  return notBuilt('src/hooks/typeahead/tokens.ts:21')
}

export function applyShellSuggestion(
  suggestion: Suggestion,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  return notBuilt('src/hooks/typeahead/tokens.ts:45')
}

export function applyDirectorySuggestion(
  input: string,
  suggestionId: string,
  tokenStartPos: number,
  tokenLength: number,
  isDirectory: boolean,
): { newInput: string; cursorPos: number } {
  const replacement = `@${suggestionId}${isDirectory ? '/' : ' '}`
  const newInput =
    input.slice(0, tokenStartPos) +
    replacement +
    input.slice(tokenStartPos + tokenLength)
  return { newInput, cursorPos: tokenStartPos + replacement.length }
}

type ShellSuggestionMetadata = {
  completionType?: ShellCompletionType
  input?: string
}

export function shellMetadataOf(suggestion: Suggestion | undefined): ShellSuggestionMetadata {
  const metadata = suggestion?.metadata
  return metadata !== null && typeof metadata === 'object' ? (metadata as ShellSuggestionMetadata) : {}
}

export function shellCompletionTypeOf(
  suggestion: Suggestion,
): ShellCompletionType | undefined {
  const { completionType } = shellMetadataOf(suggestion)
  if (
    completionType === 'command' ||
    completionType === 'variable' ||
    completionType === 'file'
  ) {
    return completionType
  }
  return undefined
}

const TOKEN_CHAR = /[^\s]/

export function extractCompletionToken(
  text: string,
  cursorPos: number,
  includeAtSymbol?: boolean,
): { token: string; startPos: number; isQuoted?: boolean } | null {
  return notBuilt('src/hooks/typeahead/tokens.ts:107')
}

export function preservedSelection(
  next: Suggestion[],
  previous: Suggestion[],
  previousSelected: number,
): number {
  if (next.length === 0) return -1
  if (previousSelected < 0) return 0
  const previousId = previous[previousSelected]?.id
  if (previousId !== undefined) {
    const kept = next.findIndex(item => item.id === previousId)
    if (kept !== -1) return kept
  }
  return 0
}
