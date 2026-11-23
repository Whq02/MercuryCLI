import type { SuggestionItem as Suggestion } from '../ComposerFooterSuggestions.js'
import type { ShellCompletionType } from '../../../platform/shell/bash/shellCompletion.js'

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
  const space = isComplete ? ' ' : ''
  if (needsQuotes || isQuoted) {
    const prefix = mode === 'bash' ? '' : '@'
    return `${prefix}"${displayText}"${space}`
  }
  const prefix = hasAtPrefix ? '@' : ''
  return `${prefix}${displayText}${space}`
}

export function applyShellSuggestion(
  suggestion: Suggestion,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  const beforeCursor = input.slice(0, cursorOffset)
  const afterCursor = input.slice(cursorOffset)
  const lastSpace = beforeCursor.lastIndexOf(' ')
  const start = lastSpace === -1 ? 0 : lastSpace + 1
  const prefix = completionType === 'variable' ? '$' : ''
  const suffix =
    completionType === 'variable' || completionType === 'command' ? ' ' : ''
  const replacement = `${prefix}${suggestion.displayText}${suffix}`
  const nextInput = input.slice(0, start) + replacement + afterCursor
  onInputChange(nextInput)
  setCursorOffset(start + replacement.length)
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
    let quoteStart = -1
    for (let i = clamped - 1; i >= 0; i--) {
      if (text[i] === '@' && text[i + 1] === '"') {
        quoteStart = i
        break
      }
      if (text[i] === '\n') break
    }
    if (quoteStart !== -1) {
      const closeQuote = text.indexOf('"', quoteStart + 2)
      const endPos = closeQuote === -1 ? text.length : closeQuote + 1
      if (endPos >= clamped) {
        return {
          token: text.slice(quoteStart, endPos),
          startPos: quoteStart,
          isQuoted: true,
        }
      }
    }

    const beforeCursor = text.slice(0, clamped)
    const lastAt = beforeCursor.lastIndexOf('@')
    if (
      lastAt !== -1 &&
      (lastAt === 0 || /\s/.test(text[lastAt - 1]!)) &&
      !/\s/.test(beforeCursor.slice(lastAt))
    ) {
      let end = clamped
      while (end < text.length && TOKEN_CHAR.test(text[end]!)) {
        end++
      }
      return {
        token: text.slice(lastAt, end),
        startPos: lastAt,
      }
    }
  }

  let start = clamped
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) {
    start--
  }
  let end = clamped
  while (end < text.length && TOKEN_CHAR.test(text[end]!)) {
    end++
  }
  if (start === end) return null
  return {
    token: text.slice(start, end),
    startPos: start,
  }
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
