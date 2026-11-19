import type { SuggestionItem as Suggestion } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { ShellCompletionType } from '../../utils/bash/shellCompletion.js'

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

export function formatReplacementValue({
  displayText,
  mode,
  hasAtPrefix,
  needsQuotes,
  isQuoted,
  isComplete,
}: {
  displayText: string
  mode: string
  hasAtPrefix: boolean
  needsQuotes: boolean
  isQuoted?: boolean
  isComplete: boolean
}): string {
  const suffix = isComplete ? ' ' : ''
  if (needsQuotes || isQuoted) {
    if (mode === 'bash') return `"${displayText}"${suffix}`
    return `@"${displayText}"${suffix}`
  }
  if (hasAtPrefix) return `@${displayText}${suffix}`
  return `${displayText}${suffix}`
}

export function applyShellSuggestion(
  suggestion: Suggestion,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  const before = input.slice(0, cursorOffset)
  const lastSpace = before.lastIndexOf(' ')
  const wordStart = lastSpace + 1
  const prefix = completionType === 'variable' ? '$' : ''
  const suffix =
    completionType === 'variable' || completionType === 'command' ? ' ' : ''
  const replacement = prefix + suggestion.displayText + suffix
  const next =
    input.slice(0, wordStart) + replacement + input.slice(cursorOffset)
  onInputChange(next)
  setCursorOffset(wordStart + replacement.length)
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
  if (!text) return null
  const clamped = Math.max(0, Math.min(cursorPos, text.length))

  if (includeAtSymbol) {
    for (let i = clamped - 1; i >= 0; i--) {
      if (text[i] === '@' && text[i + 1] === '"') {
        const closing = text.indexOf('"', i + 2)
        const endPos = closing === -1 ? text.length : closing + 1
        if (endPos >= clamped) {
          return {
            token: text.slice(i, endPos),
            startPos: i,
            isQuoted: true,
          }
        }
        break
      }
      if (text[i] === ' ' || text[i] === '\n') break
    }
    const before = text.slice(0, clamped)
    const at = before.lastIndexOf('@')
    if (at !== -1 && (at === 0 || /[\s]/.test(text[at - 1]!))) {
      const tail = before.slice(at + 1)
      if (!/\s/.test(tail)) {
        let end = clamped
        while (end < text.length && TOKEN_CHAR.test(text[end]!)) end++
        return { token: text.slice(at, end), startPos: at }
      }
    }
  }

  let start = clamped
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) start--
  let end = clamped
  while (end < text.length && TOKEN_CHAR.test(text[end]!)) end++
  if (start === end) return null
  return { token: text.slice(start, end), startPos: start }
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
