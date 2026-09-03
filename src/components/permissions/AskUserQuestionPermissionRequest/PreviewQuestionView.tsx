/**
 * The interview preview workspace — side-by-side / stacked / minimal option
 * comparison (MERCURY INTERVIEW B2, reimplemented at the owner).
 *
 * Geometry comes from the ONE layout owner (interviewLayout.ts) — no raw
 * column constants; every dimension is display-cell-true and ≥ 1 at any
 * terminal size. Key routing decodes through the ONE semantic vocabulary
 * (navSemantics.decodeDomNavKey) — no raw key matching.
 */
import figures from 'figures'
import { GLYPH } from '../../mercury-ui/glyphs.js'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import { useKeybinding, useKeybindings } from '../../../keybindings/useKeybinding.js'
import { useAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { APOLLO_OPTION_LETTERS } from '../../../tools/AskUserQuestionTool/apolloLetters.js'
import { normalizePastedInput } from '../../../input-core/composer-document.js'
import { getExternalEditor } from '../../../utils/editor.js'
import { toIDEDisplayName } from '../../../utils/ide.js'
import { PASTE_THRESHOLD } from '../../../utils/imagePaste.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { Divider } from '../../design-system/Divider.js'
import { decodeDomNavKey } from '../../mercury-ui/navSemantics.js'
import TextInput from '../../TextInput.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { resolveInterviewLayout } from './interviewLayout.js'
import { PreviewBox } from './PreviewBox.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'
import type { QuestionState } from './questionState.js'

type Props = {
  question: Question
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  questionStates: Record<string, QuestionState>
  hideSubmitTab?: boolean
  minContentHeight?: number
  minContentWidth?: number
  onUpdateQuestionState: (
    questionText: string,
    updates: Partial<QuestionState>,
    isMultiSelect: boolean,
  ) => void
  onAnswer: (
    questionText: string,
    label: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void
  onTextInputFocus: (isInInput: boolean) => void
  onCancel: () => void
  onTabPrev?: () => void
  onTabNext?: () => void
  onRespondToClaude: () => void
  onFinishPlanInterview: () => void
  onNotesPasteLarge?: (questionText: string, text: string) => void
}

export function PreviewQuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  minContentHeight,
  minContentWidth,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onTabPrev,
  onTabNext,
  onRespondToClaude,
  onFinishPlanInterview,
  onNotesPasteLarge,
}: Props): React.ReactNode {
  const previewPermissionMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isInPlanMode = previewPermissionMode === 'strategy'
  // Apollo polls letter their options (A–D; the preview workspace's custom
  // route is its Notes field, so no E row here) — display ordinals only.
  const isApolloPoll = previewPermissionMode === 'apollo'
  const { columns, rows: terminalRows } = useTerminalSize()
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [footerIndex, setFooterIndex] = useState(0)
  const [isInNotesInput, setIsInNotesInput] = useState(false)
  const [cursorOffset, setCursorOffset] = useState(0)
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : null
  const questionText = question.question
  const questionState = questionStates[questionText]

  const allOptions = question.options
  // Focus opens on the selected option, else the first — on a fresh mount
  // (a revisited question mounts its own view) and when the question under
  // a mounted view changes. Render-phase derived state per the React idiom;
  // identity, answers, and drafts live in the session authority, so a
  // remount can never lose meaning.
  const focusForSelection = (): number => {
    const selected = questionStates[questionText]?.selectedValue as string | undefined
    const idx = selected ? allOptions.findIndex(opt => opt.label === selected) : -1
    return idx >= 0 ? idx : 0
  }
  const [focusedIndex, setFocusedIndex] = useState(focusForSelection)
  const prevQuestionText = useRef(questionText)
  if (prevQuestionText.current !== questionText) {
    prevQuestionText.current = questionText
    setFocusedIndex(focusForSelection())
  }
  const focusedOption = allOptions[focusedIndex]
  const selectedValue = questionState?.selectedValue as string | undefined
  const notesValue = questionState?.textInputValue || ''

  // ── the ONE geometry decision ─────────────────────────────────────────────
  const layout = useMemo(
    () =>
      resolveInterviewLayout({
        columns,
        // The parent's content budget ALREADY reserves the outer chrome; the
        // layout subtracts its own PREVIEW_CHROME_ROWS from this. Passing
        // budget+11 here inflated the preview by exactly those 11 rows and
        // pushed the title off short terminals (caught by the width-matrix
        // journey at rows=30 vs the j05 baseline).
        rows: minContentHeight ?? terminalRows,
        question: {
          id: 'view',
          decisionId: 'view',
          text: question.question,
          header: question.header,
          multiSelect: question.multiSelect ?? false,
          options: question.options.map((o, i) => ({
            id: `view_${i}`,
            label: o.label,
            description: o.description,
            ...(o.preview ? { preview: o.preview } : {}),
          })),
        },
      }),
    [columns, terminalRows, minContentHeight, question],
  )

  const handleSelectOption = useCallback(
    (index: number) => {
      const option = allOptions[index]
      if (!option) return
      setFocusedIndex(index)
      onUpdateQuestionState(questionText, { selectedValue: option.label }, false)
      onAnswer(questionText, option.label)
    },
    [allOptions, questionText, onUpdateQuestionState, onAnswer],
  )

  useKeybinding(
    'chat:externalEditor',
    async () => {
      const currentValue = questionState?.textInputValue || ''
      const result = await editPromptInEditor(currentValue)
      if (result.content !== null && result.content !== currentValue) {
        onUpdateQuestionState(questionText, { textInputValue: result.content }, false)
      }
    },
    { context: 'Chat', isActive: isInNotesInput && !!editor },
  )

  useKeybindings(
    { 'tabs:previous': () => onTabPrev?.(), 'tabs:next': () => onTabNext?.() },
    { context: 'Tabs', isActive: !isInNotesInput && !isFooterFocused },
  )

  const handleNotesExit = useCallback(() => {
    setIsInNotesInput(false)
    onTextInputFocus(false)
    if (selectedValue) onAnswer(questionText, selectedValue)
  }, [selectedValue, questionText, onAnswer, onTextInputFocus])

  // Pasting into the notes field: small pastes splice at the cursor (the
  // normal textbox contract); a large paste becomes a stable context
  // REFERENCE (the parent stores the body once and cites it in the note).
  const handleNotesPaste = useCallback(
    (pasted: string) => {
      const text = normalizePastedInput(pasted)
      if (text.length > PASTE_THRESHOLD && onNotesPasteLarge) {
        onNotesPasteLarge(questionText, text)
        return
      }
      const next = notesValue.slice(0, cursorOffset) + text + notesValue.slice(cursorOffset)
      onUpdateQuestionState(questionText, { textInputValue: next }, false)
      setCursorOffset(cursorOffset + text.length)
    },
    [questionText, notesValue, cursorOffset, onNotesPasteLarge, onUpdateQuestionState],
  )

  // ── the input graph: every key decodes through the ONE vocabulary ─────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const action = decodeDomNavKey(e, { orientation: 'vertical' })
      if (isFooterFocused) {
        if (action === 'movePrevious') {
          e.preventDefault()
          if (footerIndex === 0) setIsFooterFocused(false)
          else setFooterIndex(0)
          return
        }
        if (action === 'moveNext') {
          e.preventDefault()
          if (isInPlanMode && footerIndex === 0) setFooterIndex(1)
          return
        }
        if (action === 'activate') {
          e.preventDefault()
          if (footerIndex === 0) onRespondToClaude()
          else onFinishPlanInterview()
          return
        }
        if (action === 'cancel') {
          e.preventDefault()
          onCancel()
        }
        return
      }
      if (isInNotesInput) {
        if (action === 'cancel') {
          e.preventDefault()
          handleNotesExit()
        }
        return
      }
      if (action === 'movePrevious') {
        e.preventDefault()
        if (focusedIndex > 0) setFocusedIndex(focusedIndex - 1)
        return
      }
      if (action === 'moveNext') {
        e.preventDefault()
        if (focusedIndex === allOptions.length - 1) setIsFooterFocused(true)
        else setFocusedIndex(focusedIndex + 1)
        return
      }
      if (action === 'activate') {
        e.preventDefault()
        handleSelectOption(focusedIndex)
        return
      }
      if (action === 'cancel') {
        e.preventDefault()
        onCancel()
        return
      }
      // The two view-local affordances outside the nav vocabulary: notes
      // entry and direct digit focus (navigate-only, never select).
      if (e.key === 'n' && !e.ctrl && !e.meta) {
        e.preventDefault()
        setIsInNotesInput(true)
        onTextInputFocus(true)
        return
      }
      if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key, 10) - 1
        if (idx < allOptions.length) setFocusedIndex(idx)
      }
    },
    [
      isFooterFocused,
      footerIndex,
      isInPlanMode,
      isInNotesInput,
      focusedIndex,
      allOptions.length,
      handleSelectOption,
      handleNotesExit,
      onRespondToClaude,
      onFinishPlanInterview,
      onCancel,
      onTextInputFocus,
    ],
  )

  const previewContent = focusedOption?.preview || null

  // ── panes ─────────────────────────────────────────────────────────────────
  const optionRows = allOptions.map((option, index) => {
    const isFocused = focusedIndex === index
    const isSelected = selectedValue === option.label
    return (
      // Pointer parity with the Select owner: a click selects the CLICKED
      // row (never the async-focused one). Keyboard stays complete without
      // it — the pointer is polish, never required.
      <Box key={option.label} flexDirection="row" onClick={() => handleSelectOption(index)}>
        {isFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
        <Text dimColor> {isApolloPoll ? APOLLO_OPTION_LETTERS[index] ?? index + 1 : index + 1}.</Text>
        <Text color={isSelected ? 'success' : isFocused ? 'suggestion' : undefined} bold={isFocused}>
          {' '}
          {option.label}
        </Text>
        {isSelected && <Text color="success"> {GLYPH.check}</Text>}
      </Box>
    )
  })

  const notesRow = (
    <Box marginTop={layout.notesInline ? 1 : 0} flexDirection="row" gap={1}>
      <Text color="suggestion">Notes:</Text>
      {isInNotesInput ? (
        <TextInput
          value={notesValue}
          placeholder="Add notes on this design…"
          onChange={value => onUpdateQuestionState(questionText, { textInputValue: value }, false)}
          onSubmit={handleNotesExit}
          onExit={handleNotesExit}
          onPaste={handleNotesPaste}
          focus={true}
          showCursor={true}
          disableEscapeDoublePress={true}
          columns={layout.notesInputWidth}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
        />
      ) : (
        <Text dimColor italic>
          {notesValue || 'press n to add notes'}
        </Text>
      )}
    </Box>
  )

  const previewBox = (
    <PreviewBox
      content={previewContent || 'No preview available'}
      maxLines={layout.previewMaxLines}
      minWidth={Math.min(minContentWidth ?? 40, layout.previewContentWidth)}
      maxWidth={layout.previewContentWidth + 4}
    />
  )

  return (
    <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Divider color="inactive" />
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color={'text'} />

        <Box flexDirection="column" minHeight={minContentHeight}>
          {layout.mode === 'side-by-side' ? (
            <Box marginTop={1} flexDirection="row" gap={2}>
              <Box flexDirection="column" width={layout.optionPaneWidth}>
                {optionRows}
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {previewBox}
                {notesRow}
              </Box>
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Box flexDirection="column">{optionRows}</Box>
              {layout.mode === 'stacked' && <Box marginTop={1}>{previewBox}</Box>}
              {notesRow}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Divider color="inactive" />
            <Box flexDirection="row" gap={1} onClick={onRespondToClaude}>
              {isFooterFocused && footerIndex === 0 ? (
                <Text color="suggestion">{figures.pointer}</Text>
              ) : (
                <Text> </Text>
              )}
              <Text color={isFooterFocused && footerIndex === 0 ? 'suggestion' : undefined}>
                Chat about this
              </Text>
            </Box>
            {isInPlanMode && (
              <Box flexDirection="row" gap={1} onClick={onFinishPlanInterview}>
                {isFooterFocused && footerIndex === 1 ? (
                  <Text color="suggestion">{figures.pointer}</Text>
                ) : (
                  <Text> </Text>
                )}
                <Text color={isFooterFocused && footerIndex === 1 ? 'suggestion' : undefined}>
                  Skip interview and plan immediately
                </Text>
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              Enter to select · {figures.arrowUp}/{figures.arrowDown} to navigate · n to add notes
              {questions.length > 1 && <> · Tab to switch questions</>}
              {isInNotesInput && editorName && <> · ctrl+g to edit in {editorName}</>}{' '}
              · Esc to cancel
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
