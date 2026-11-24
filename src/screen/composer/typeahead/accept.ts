import type React from 'react'
import type { Command } from '../../../commands/catalogue/commands.js'
import type { SuggestionItem as Suggestion } from '../ComposerFooterSuggestions.js'
import { findLongestCommonPrefix } from './fileSuggestions.js'
import type { InlineGhostText, InputMode } from '../input-core/textInput.js'
import { getShellCompletions } from '../../../platform/shell/bash/shellCompletion.js'
import { logError } from '../../../platform/logs/errorLog.js'
import {
  applyCommandSuggestion,
  findChannelTargetQuery,
  findMidInputSlashCommand,
  isNameAnchoredSuggestion,
} from '../../suggestions/commandSuggestions.js'
import type { Publish } from './state.js'
import {
  applyDirectorySuggestion,
  applyShellSuggestion,
  extractCompletionToken,
  extractSearchToken,
  formatReplacementValue,
  shellCompletionTypeOf,
  shellMetadataOf,
} from './tokens.js'

export type AcceptContext = {
  atIndex: number | undefined
  viaEnter: boolean
  currentInput: string
  cursor: number
  list: Suggestion[]
  mode: InputMode
  commands: Command[]
  setInput: (value: string) => void
  setCursorOffset: (offset: number) => void
  onSubmit: ((value: string, isSubmittingSlashCommand?: boolean) => void) | undefined
  publish: Publish
  clearSuggestions: () => void
  runUnifiedFetch: (token: string) => void
  rerunLadderForInput: (nextInput: string) => void
  userNavigatedRef: React.MutableRefObject<boolean>
  inputRef: React.MutableRefObject<string>
  cursorOffsetRef: React.MutableRefObject<number>
  promptGhost: InlineGhostText | undefined
  asyncGhostText: InlineGhostText | null
  setAsyncGhostText: React.Dispatch<React.SetStateAction<InlineGhostText | null>>
}

export function acceptGhost({ mode, promptGhost, asyncGhostText, viaEnter, currentInput, cursorOffsetRef, setInput, setCursorOffset, setAsyncGhostText, clearSuggestions }: AcceptContext): boolean {
  const ghost =
    mode === 'prompt' ? promptGhost : (asyncGhostText ?? undefined)
  if (ghost && !viaEnter) {
    if (mode === 'bash') {
      setInput(ghost.fullCommand)
      setCursorOffset(ghost.fullCommand.length)
      setAsyncGhostText(null)
      return true
    }
    const midCommand = findMidInputSlashCommand(
      currentInput,
      cursorOffsetRef.current,
    )
    if (midCommand) {
      const before = currentInput.slice(0, midCommand.startPos)
      const after = currentInput.slice(
        midCommand.startPos + 1 + midCommand.partialCommand.length,
      )
      const replaced = `${before}/${ghost.fullCommand} `
      setInput(replaced + after)
      setCursorOffset(replaced.length)
      clearSuggestions()
      return true
    }
  }
  return false
}

export function acceptCommand({ viaEnter, atIndex, userNavigatedRef, currentInput, clearSuggestions, onSubmit, commands, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  if (
    viaEnter &&
    atIndex === undefined &&
    !userNavigatedRef.current &&
    !isNameAnchoredSuggestion(currentInput, suggestion)
  ) {
    clearSuggestions()
    onSubmit?.(currentInput, true)
    return
  }
  applyCommandSuggestion(
    suggestion,
    viaEnter,
    commands,
    setInput,
    setCursorOffset,
    onSubmit ?? (() => {}),
  )
  clearSuggestions()
  return
}

export function acceptCustomTitle({ viaEnter, clearSuggestions, onSubmit, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  const sessionRef =
    (suggestion.metadata as string | undefined) ??
    suggestion.displayText
  const rebuilt = `/sessions ${sessionRef}`
  setInput(rebuilt)
  setCursorOffset(rebuilt.length)
  if (viaEnter) onSubmit?.(rebuilt, true)
  clearSuggestions()
  return
}

export function acceptDirectory({ viaEnter, currentInput, cursor, clearSuggestions, setInput, setCursorOffset, rerunLadderForInput }: AcceptContext, suggestion: Suggestion): void {
  const isDirectory = suggestion.id.endsWith('/')
  const id = isDirectory ? suggestion.id.slice(0, -1) : suggestion.id
  if (currentInput.startsWith('/')) {
    if (viaEnter) {
      clearSuggestions()
      return
    }
    const spaceIndex = currentInput.indexOf(' ')
    const prefix = currentInput.slice(0, spaceIndex + 1)
    const rebuilt = `${prefix}${id}${isDirectory ? '/' : ' '}`
    setInput(rebuilt)
    setCursorOffset(rebuilt.length)
    if (isDirectory) rerunLadderForInput(rebuilt)
    else clearSuggestions()
    return
  }
  const token = extractCompletionToken(currentInput, cursor, true)
  if (!token) {
    clearSuggestions()
    return
  }
  const { newInput, cursorPos } = applyDirectorySuggestion(
    currentInput,
    id,
    token.startPos,
    token.token.length,
    isDirectory,
  )
  setInput(newInput)
  setCursorOffset(cursorPos)
  if (isDirectory && !viaEnter) rerunLadderForInput(newInput)
  else clearSuggestions()
}

export function acceptShell({ currentInput, cursor, clearSuggestions, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  applyShellSuggestion(
    suggestion,
    currentInput,
    cursor,
    setInput,
    setCursorOffset,
    shellCompletionTypeOf(suggestion),
  )
  clearSuggestions()
  return
}

export function acceptChannelTarget({ currentInput, cursor, clearSuggestions, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  const target = findChannelTargetQuery(currentInput, cursor)
  if (!target) {
    clearSuggestions()
    return
  }
  const rebuilt = `${currentInput.slice(0, target.start)}${String(suggestion.metadata ?? suggestion.displayText)} `
  setInput(rebuilt)
  setCursorOffset(rebuilt.length)
  clearSuggestions()
  return
}

export function acceptCrewmate({ currentInput, cursor, clearSuggestions, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  if (!suggestion.id.startsWith('dm-')) return
  const before = currentInput.slice(0, cursor)
  const match = before.match(/(^|\s)@[\w-]*$/)
  if (!match) {
    clearSuggestions()
    return
  }
  const start = before.length - match[0].length + match[1]!.length
  const rebuilt =
    currentInput.slice(0, start) +
    suggestion.displayText +
    ' ' +
    currentInput.slice(cursor)
  setInput(rebuilt)
  setCursorOffset(start + suggestion.displayText.length + 1)
  clearSuggestions()
  return
}

export function acceptSlackChannel({ currentInput, cursor, clearSuggestions, setInput, setCursorOffset }: AcceptContext, suggestion: Suggestion): void {
  const before = currentInput.slice(0, cursor)
  const match = before.match(/(^|\s)#[a-z0-9][a-z0-9_-]*$/)
  if (!match) {
    clearSuggestions()
    return
  }
  const start = before.length - match[0].length + match[1]!.length
  const rebuilt =
    currentInput.slice(0, start) +
    suggestion.displayText +
    ' ' +
    currentInput.slice(cursor)
  setInput(rebuilt)
  setCursorOffset(start + suggestion.displayText.length + 1)
  clearSuggestions()
  return
}

export function acceptFile({ viaEnter, currentInput, cursor, list, mode, clearSuggestions, setInput, setCursorOffset, runUnifiedFetch }: AcceptContext, suggestion: Suggestion): void {
  const token = extractCompletionToken(currentInput, cursor, true)
  if (!token) {
    clearSuggestions()
    return
  }
  const search = extractSearchToken(token)
  const commonPrefix = findLongestCommonPrefix(list)
  if (
    !viaEnter &&
    commonPrefix.length > search.length &&
    list.length > 1
  ) {
    const partial = formatReplacementValue({
      displayText: commonPrefix,
      mode,
      hasAtPrefix: token.token.startsWith('@'),
      needsQuotes: commonPrefix.includes(' '),
      isQuoted: token.isQuoted,
      isComplete: false,
    })
    const rebuilt =
      currentInput.slice(0, token.startPos) +
      partial +
      currentInput.slice(token.startPos + token.token.length)
    setInput(rebuilt)
    setCursorOffset(token.startPos + partial.length)
    runUnifiedFetch(commonPrefix)
    return
  }
  const complete = formatReplacementValue({
    displayText: suggestion.displayText,
    mode,
    hasAtPrefix: token.token.startsWith('@'),
    needsQuotes: suggestion.displayText.includes(' '),
    isQuoted: token.isQuoted,
    isComplete: true,
  })
  const rebuilt =
    currentInput.slice(0, token.startPos) +
    complete +
    currentInput.slice(token.startPos + token.token.length)
  setInput(rebuilt)
  setCursorOffset(token.startPos + complete.length)
  clearSuggestions()
  return
}

export function acceptWithoutList({ currentInput, cursor, mode, setInput, setCursorOffset, publish, runUnifiedFetch, inputRef, cursorOffsetRef }: AcceptContext): void {
  if (currentInput.trim() === '') return
  if (mode === 'bash') {
    void getShellCompletions(currentInput, cursor, new AbortController().signal)
      .then(completions => {
        if (completions.length === 1) {
          applyShellSuggestion(
            completions[0]!,
            inputRef.current,
            cursorOffsetRef.current,
            setInput,
            setCursorOffset,
            shellCompletionTypeOf(completions[0]!),
          )
          return
        }
        if (completions.length > 0) {
          publish(
            completions.map((completion, index) =>
              index === 0
                ? {
                    ...completion,
                    metadata: { ...shellMetadataOf(completion), input: inputRef.current },
                  }
                : completion,
            ),
            'shell',
            { selected: 0 },
          )
        }
      })
      .catch(error => logError(error))
    return
  }
  const token = extractCompletionToken(currentInput, cursor, true)
  if (!token) return
  runUnifiedFetch(extractSearchToken(token))
}
