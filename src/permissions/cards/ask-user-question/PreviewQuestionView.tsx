import figures from 'figures'
import { GLYPH } from '../../../screen/theme/glyphs.js'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import type { KeyboardEvent } from '../../../screen/renderer/events/keyboard-event.js'
import { Box, Text } from '../../../screen/themedRenderer.js'
import { useOptionalKeybindingContext } from '../../../screen/keys/KeybindingContext.js'
import { useKeybinding, useKeybindings } from '../../../screen/keys/useKeybinding.js'
import { useActionAffordance } from '../../../screen/keys/useShortcutDisplay.js'
import { useAppState } from '../../../screen/app-state/AppState.js'
import type { AppState } from '../../../screen/app-state/AppState.js'
import type { Question } from '../../../tools/ask-question/AskUserQuestionTool.js'
import { APOLLO_OPTION_LETTERS } from '../../../tools/ask-question/apolloLetters.js'
import { normalizePastedInput } from '../../../screen/composer/input-core/composer-document.js'
import { editorDisplayName, getExternalEditor } from '../../../platform/editor/externalEditor.js'
import { PASTE_THRESHOLD } from '../../../screen/composer/imagePaste.js'
import { editPromptInEditor } from '../../../screen/composer/promptEditor.js'
import { decodeDomNavKey } from '../../../screen/widgets/navSemantics.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { resolveInterviewLayout } from './interviewLayout.js'
import { PreviewBox } from './PreviewBox.js'
import { previewQuestionBody } from './previewQuestionBody.js'
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
    isMultiSelect?: boolean,
  ) => void
  onAnswer: (
    questionText: string,
    answer: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void
  onTextInputFocus: (isInInput: boolean) => void
  onCancel: () => void
  onTabNext?: () => void
  onTabPrev?: () => void
  onRespondToModel?: () => void | Promise<void>
  onNotesPasteLarge?: (questionText: string, text: string) => void
}

export function PreviewQuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = questions.length === 1,
  minContentHeight,
  minContentWidth,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onTabNext,
  onTabPrev,
  onRespondToModel,
  onNotesPasteLarge,
}: Props): React.ReactNode {
  const { columns, rows: terminalRows } = useTerminalSize()
  const permissionMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isApolloMode = permissionMode === 'apollo'

  const questionState = questionStates[question.question]
  const selectedValue =
    typeof questionState?.selectedValue === 'string' ? questionState.selectedValue : undefined
  const notes = questionState?.textInputValue ?? ''

  const initialFocusIndex = (): number => {
    if (selectedValue !== undefined) {
      const idx = question.options.findIndex(o => o.label === selectedValue)
      if (idx >= 0) return idx
    }
    return 0
  }

  const [prevQuestionKey, setPrevQuestionKey] = useState(question.question)
  const [focusedIndex, setFocusedIndex] = useState<number>(initialFocusIndex)
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [isInNotesInput, setIsInNotesInput] = useState(false)
  const [cursorOffset, setCursorOffset] = useState(notes.length)

  if (prevQuestionKey !== question.question) {
    setPrevQuestionKey(question.question)
    setFocusedIndex(initialFocusIndex())
    setIsFooterFocused(false)
    setIsInNotesInput(false)
    setCursorOffset(notes.length)
  }

  const clampedFocusedIndex = Math.max(
    0,
    Math.min(focusedIndex, Math.max(0, question.options.length - 1)),
  )

  const notesRef = useRef(notes)
  notesRef.current = notes

  const layout = useMemo(
    () =>
      resolveInterviewLayout({
        columns,
        rows: minContentHeight ?? terminalRows,
        question: {
          id: question.id ?? question.question,
          decisionId: question.decisionId ?? question.question,
          text: question.question,
          header: question.header,
          multiSelect: question.multiSelect,
          options: question.options.map((o, i) => ({
            id: o.id ?? String(i),
            label: o.label,
            description: o.description,
            preview: o.preview,
          })),
        },
      }),
    [columns, minContentHeight, terminalRows, question],
  )

  const kb = useOptionalKeybindingContext()
  const confirmEditorAffordance = useActionAffordance('chat:externalEditor', 'Confirmation')
  const chatEditorAffordance = useActionAffordance('chat:externalEditor', 'Chat')
  const editor = getExternalEditor()
  const editorKey =
    confirmEditorAffordance.kind === 'bound'
      ? confirmEditorAffordance.chord
      : chatEditorAffordance.kind === 'bound'
        ? chatEditorAffordance.chord
        : kb === null
          ? 'ctrl+g'
          : null
  const editorName = editor ? editorDisplayName(editor) : null

  useKeybindings(
    {
      'tabs:previous': () => {
        if (!onTabPrev) return false
        onTabPrev()
      },
      'tabs:next': () => {
        if (!onTabNext) return false
        onTabNext()
      },
    },
    {
      context: 'Tabs',
      isActive: !isInNotesInput && !isFooterFocused && Boolean(onTabNext || onTabPrev),
    },
  )

  const handleOpenEditor = useCallback(() => {
    const current = notesRef.current
    void editPromptInEditor(current).then(result => {
      if (result.content !== null && result.content !== current) {
        onUpdateQuestionState(question.question, { textInputValue: result.content })
        setCursorOffset(result.content.length)
      }
    })
  }, [onUpdateQuestionState, question.question])

  useKeybinding('chat:externalEditor', handleOpenEditor, {
    context: 'Confirmation',
    isActive: isInNotesInput && !!editor,
  })
  useKeybinding('chat:externalEditor', handleOpenEditor, {
    context: 'Chat',
    isActive: isInNotesInput && !!editor,
  })

  const exitNotes = useCallback(() => {
    setIsInNotesInput(false)
    onTextInputFocus(false)
    if (selectedValue !== undefined) {
      onAnswer(question.question, selectedValue, notesRef.current, true)
    }
  }, [onAnswer, onTextInputFocus, question.question, selectedValue])

  const handleNotesPaste = useCallback(
    (pasted: string) => {
      const normalized = normalizePastedInput(pasted)
      if (normalized.length > PASTE_THRESHOLD && onNotesPasteLarge) {
        onNotesPasteLarge(question.question, normalized)
        return
      }
      const current = notesRef.current
      const at = Math.max(0, Math.min(cursorOffset, current.length))
      const next = current.slice(0, at) + normalized + current.slice(at)
      onUpdateQuestionState(question.question, { textInputValue: next })
      setCursorOffset(at + normalized.length)
    },
    [cursorOffset, onNotesPasteLarge, onUpdateQuestionState, question.question],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) =>
      dispatchPreviewKeyDown(e, {
        isFooterFocused,
        isInNotesInput,
        focusedIndex: clampedFocusedIndex,
        options: question.options,
        onFocusFooter: () => setIsFooterFocused(true),
        onLeaveFooter: lastIdx => {
          setIsFooterFocused(false)
          setFocusedIndex(lastIdx)
        },
        onMoveFocus: next => setFocusedIndex(next),
        onSelectOption: label => {
          onUpdateQuestionState(question.question, { selectedValue: label })
          onAnswer(question.question, label, notesRef.current, true)
        },
        onEnterNotes: () => {
          setIsInNotesInput(true)
          setCursorOffset(notesRef.current.length)
          onTextInputFocus(true)
        },
        onExitNotes: exitNotes,
        onRespondToModel,
        onCancel,
      }),
    [
      isFooterFocused,
      isInNotesInput,
      clampedFocusedIndex,
      question.options,
      question.question,
      onRespondToModel,
      onCancel,
      exitNotes,
      onUpdateQuestionState,
      onAnswer,
      onTextInputFocus,
    ],
  )

  const optionRows = renderPreviewOptionRows({
    options: question.options,
    isApolloMode,
    isFooterFocused,
    isInNotesInput,
    focusedIndex: clampedFocusedIndex,
    selectedValue,
    onSelect: (idx, label) => {
      setIsFooterFocused(false)
      setIsInNotesInput(false)
      onTextInputFocus(false)
      setFocusedIndex(idx)
      onUpdateQuestionState(question.question, { selectedValue: label })
      onAnswer(question.question, label, notesRef.current, true)
    },
  })

  const focusedOption = question.options[clampedFocusedIndex]
  const previewBox = (
    <PreviewBox
      content={focusedOption?.preview ?? 'No preview available'}
      maxLines={layout.previewMaxLines}
      minWidth={Math.min(minContentWidth ?? 40, layout.previewContentWidth)}
      maxWidth={layout.previewContentWidth + 4}
    />
  )

  const notesRow = renderPreviewNotesRow({
    notes,
    isInNotesInput,
    cursorOffset,
    notesInline: layout.notesInline,
    notesInputWidth: layout.notesInputWidth,
    onChangeNotes: val => onUpdateQuestionState(question.question, { textInputValue: val }, false),
    onExitNotes: exitNotes,
    onPasteNotes: handleNotesPaste,
    onChangeCursorOffset: setCursorOffset,
  })

  return previewQuestionBody({
    question,
    questions,
    currentQuestionIndex,
    answers,
    hideSubmitTab,
    layout,
    minContentHeight,
    optionRows,
    previewBox,
    notesRow,
    isFooterFocused,
    editorKey: isInNotesInput && editorName ? editorKey : null,
    editorName: isInNotesInput ? editorName : null,
    onKeyDown: handleKeyDown,
    onRespondToModel,
  })
}

function renderPreviewOptionRows({
  options,
  isApolloMode,
  isFooterFocused,
  isInNotesInput,
  focusedIndex,
  selectedValue,
  onSelect,
}: {
  options: Question['options']
  isApolloMode: boolean
  isFooterFocused: boolean
  isInNotesInput: boolean
  focusedIndex: number
  selectedValue: string | undefined
  onSelect: (idx: number, label: string) => void
}): React.ReactNode {
  return (
    <>
      {options.map((opt, idx) => {
        const isFocused = !isFooterFocused && !isInNotesInput && focusedIndex === idx
        const isSelected = selectedValue === opt.label
        const ordinal = (isApolloMode ? APOLLO_OPTION_LETTERS[idx] : undefined) ?? idx + 1
        return (
          <Box key={opt.label} flexDirection="row" onClick={() => onSelect(idx, opt.label)}>
            {isFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
            <Text dimColor>{` ${ordinal}.`}</Text>
            <Text
              color={isSelected ? 'success' : isFocused ? 'suggestion' : undefined}
              bold={isFocused}
            >
              {` ${opt.label}`}
            </Text>
            {isSelected ? <Text color="success">{` ${GLYPH.check}`}</Text> : null}
          </Box>
        )
      })}
    </>
  )
}

function renderPreviewNotesRow({
  notes,
  isInNotesInput,
  cursorOffset,
  notesInline,
  notesInputWidth,
  onChangeNotes,
  onExitNotes,
  onPasteNotes,
  onChangeCursorOffset,
}: {
  notes: string
  isInNotesInput: boolean
  cursorOffset: number
  notesInline: boolean
  notesInputWidth: number
  onChangeNotes: (val: string) => void
  onExitNotes: () => void
  onPasteNotes: (text: string) => void
  onChangeCursorOffset: (offset: number) => void
}): React.ReactNode {
  return (
    <Box marginTop={notesInline ? 1 : 0} flexDirection="row" gap={1}>
      <Text color="suggestion">Notes:</Text>
      {isInNotesInput ? (
        <TextInput
          value={notes}
          placeholder="Add notes on this design…"
          onChange={onChangeNotes}
          onSubmit={onExitNotes}
          onExit={onExitNotes}
          onPaste={onPasteNotes}
          focus
          showCursor
          disableEscapeDoublePress
          columns={notesInputWidth}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onChangeCursorOffset}
        />
      ) : notes ? (
        <Text dimColor italic>
          {notes}
        </Text>
      ) : (
        <Text dimColor italic>
          press n to add notes
        </Text>
      )}
    </Box>
  )
}

function dispatchPreviewKeyDown(
  e: KeyboardEvent,
  ctx: {
    isFooterFocused: boolean
    isInNotesInput: boolean
    focusedIndex: number
    options: Question['options']
    onFocusFooter: () => void
    onLeaveFooter: (lastIndex: number) => void
    onMoveFocus: (nextIndex: number) => void
    onSelectOption: (label: string) => void
    onEnterNotes: () => void
    onExitNotes: () => void
    onRespondToModel?: () => void | Promise<void>
    onCancel: () => void
  },
): void {
  const action = decodeDomNavKey(e, { orientation: 'vertical' })

  if (ctx.isFooterFocused) {
    if (action === 'movePrevious') {
      e.stopPropagation()
      ctx.onLeaveFooter(Math.max(0, ctx.options.length - 1))
    } else if (action === 'moveNext') {
      e.stopPropagation()
    } else if (action === 'activate') {
      e.stopPropagation()
      void ctx.onRespondToModel?.()
    } else if (action === 'cancel') {
      e.stopPropagation()
      ctx.onCancel()
    }
    return
  }

  if (ctx.isInNotesInput) {
    if (action === 'cancel') {
      e.stopPropagation()
      ctx.onExitNotes()
    }
    return
  }

  if (action === 'movePrevious') {
    e.stopPropagation()
    ctx.onMoveFocus(ctx.focusedIndex > 0 ? ctx.focusedIndex - 1 : ctx.focusedIndex)
    return
  }

  if (action === 'moveNext') {
    e.stopPropagation()
    if (ctx.focusedIndex >= ctx.options.length - 1) {
      ctx.onFocusFooter()
    } else {
      ctx.onMoveFocus(Math.min(ctx.options.length - 1, ctx.focusedIndex + 1))
    }
    return
  }

  if (action === 'activate') {
    e.stopPropagation()
    const opt = ctx.options[ctx.focusedIndex]
    if (opt) ctx.onSelectOption(opt.label)
    return
  }

  if (action === 'cancel') {
    e.stopPropagation()
    ctx.onCancel()
    return
  }

  if (!e.ctrl && !e.meta && e.key === 'n') {
    e.stopPropagation()
    ctx.onEnterNotes()
    return
  }

  if (!e.ctrl && !e.meta && e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1
    if (idx >= 0 && idx < ctx.options.length) {
      e.stopPropagation()
      ctx.onMoveFocus(idx)
    }
  }
}
