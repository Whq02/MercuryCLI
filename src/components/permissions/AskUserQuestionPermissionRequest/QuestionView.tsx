/**
 * The interview question view (MERCURY INTERVIEW Wave B, reimplemented at
 * the owner) — one decision on screen: the select list (or the preview
 * workspace when any option carries a preview), the Other free-text route,
 * and the footer affordances (discussion; early finish in strategy mode).
 *
 * All durable meaning lives in the session authority upstream; this view
 * projects and routes. Every footer key decodes through the ONE semantic
 * vocabulary; the select list is the
 * established CustomSelect owner, seeded with defaultFocusValue so an edit
 * launched from review opens ON the committed answer.
 */
import figures from 'figures'
import React, { useCallback, useState } from 'react'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text, useInput } from '../../../ink.js'
import { useAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import {
  apolloCustomIndexLabel,
  apolloIndexLabel,
} from '../../../tools/AskUserQuestionTool/apolloLetters.js'
import type { PastedContent } from '../../../utils/config.js'
import { getExternalEditor } from '../../../utils/editor.js'
import { toIDEDisplayName } from '../../../utils/ide.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { type OptionWithDescription, Select, SelectMulti } from '../../CustomSelect/index.js'
import { decodeDomNavKey } from '../../mercury-ui/navSemantics.js'
import { Divider } from '../../design-system/Divider.js'
import { FilePathLink } from '../../FilePathLink.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PreviewQuestionView } from './PreviewQuestionView.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'
import type { QuestionState } from './questionState.js'

type Props = {
  question: Question
  questions: Question[]
  currentQuestionIndex: number
  answers: Record<string, string>
  questionStates: Record<string, QuestionState>
  hideSubmitTab?: boolean
  planFilePath?: string
  pastedContents?: Record<number, PastedContent>
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
  onSubmit: () => void
  onTabPrev?: () => void
  onTabNext?: () => void
  onRespondToClaude: () => void
  onFinishPlanInterview: () => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  onRemoveImage?: (id: number) => void
  onNotesPasteLarge?: (questionText: string, text: string) => void
}

export function QuestionView(props: Props): React.ReactNode {
  const {
    question,
    questions,
    currentQuestionIndex,
    answers,
    questionStates,
    hideSubmitTab = false,
    planFilePath,
    minContentHeight,
    minContentWidth,
    onUpdateQuestionState,
    onAnswer,
    onTextInputFocus,
    onCancel,
    onSubmit,
    onTabPrev,
    onTabNext,
    onRespondToClaude,
    onFinishPlanInterview,
    onImagePaste,
    pastedContents,
    onRemoveImage,
    onNotesPasteLarge,
  } = props
  const permissionMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isInPlanMode = permissionMode === 'strategy'
  // Apollo polls letter their options — A–D + E = custom — through the
  // select owner's ordinal channel (indexLabel replaces the numeric "1."
  // prefixes); labels and values stay raw so answer identity never carries
  // a letter (apolloLetters.ts owns the grammar).
  const isApolloPoll = permissionMode === 'apollo'
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [footerIndex, setFooterIndex] = useState(0)
  const [isOtherFocused, setIsOtherFocused] = useState(false)
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : null

  const questionText = question.question
  const questionState = questionStates[questionText]

  const handleFocus = useCallback(
    (value: unknown) => {
      const isOther = value === '__other__'
      setIsOtherFocused(isOther)
      onTextInputFocus(isOther)
    },
    [onTextInputFocus],
  )

  const handleOpenEditor = useCallback(
    async (currentValue: string, setValue: (value: string) => void) => {
      const result = await editPromptInEditor(currentValue)
      if (result.content !== null && result.content !== currentValue) {
        setValue(result.content)
        onUpdateQuestionState(
          questionText,
          { textInputValue: result.content },
          question.multiSelect ?? false,
        )
      }
    },
    [questionText, question.multiSelect, onUpdateQuestionState],
  )

  // Footer rows are a vertical collection — raw keys map through the ONE
  // semantic vocabulary at this owning boundary.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isFooterFocused) return
      const action = decodeDomNavKey(e, { orientation: 'vertical' })
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
    },
    [isFooterFocused, footerIndex, isInPlanMode, onRespondToClaude, onFinishPlanInterview, onCancel],
  )

  // Footer ORDINALS: the footer paints numbered rows ("6. Chat about this",
  // and "7. Skip interview…" in plan mode) — the advertised ordinal is the
  // hotkey (the same law the option letters/digits follow; a painted digit
  // that does nothing would advertise a lie). The select consumes option ordinals first (FIFO
  // by mount order — its useInput registers deeper); this handler takes only
  // the footer's own digits, and never while the Other field is typing.
  const routesToPreview = !question.multiSelect && question.options.some(o => o.preview)
  const chatOrdinal = String(question.options.length + 2)
  const finishOrdinal = String(question.options.length + 3)
  useInput(
    (input, _key, event) => {
      if (routesToPreview || isOtherFocused) return
      if (input === chatOrdinal) {
        event.stopImmediatePropagation()
        onRespondToClaude()
        return
      }
      if (isInPlanMode && input === finishOrdinal) {
        event.stopImmediatePropagation()
        onFinishPlanInterview()
      }
    },
    { isActive: true },
  )

  // Any previewed option routes the whole decision to the preview workspace.
  if (routesToPreview) {
    return (
      <PreviewQuestionView
        question={question}
        questions={questions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        questionStates={questionStates}
        hideSubmitTab={hideSubmitTab}
        minContentHeight={minContentHeight}
        minContentWidth={minContentWidth}
        onUpdateQuestionState={onUpdateQuestionState}
        onAnswer={onAnswer}
        onTextInputFocus={onTextInputFocus}
        onCancel={onCancel}
        onTabPrev={onTabPrev}
        onTabNext={onTabNext}
        onRespondToClaude={onRespondToClaude}
        onFinishPlanInterview={onFinishPlanInterview}
        onNotesPasteLarge={onNotesPasteLarge}
      />
    )
  }

  const selectedValue = questionState?.selectedValue
  const options: OptionWithDescription<string>[] = [
    ...question.options.map((opt, index) => ({
      type: 'text' as const,
      value: opt.label,
      label: opt.label,
      description: opt.description,
      ...(isApolloPoll ? { indexLabel: apolloIndexLabel(index) } : {}),
    })),
    {
      type: 'input' as const,
      value: '__other__',
      label: 'Other',
      placeholder: question.multiSelect ? 'Type something' : 'Type something.',
      initialValue: questionState?.textInputValue ?? '',
      onChange: (value: string) =>
        onUpdateQuestionState(questionText, { textInputValue: value }, question.multiSelect ?? false),
      ...(isApolloPoll ? { indexLabel: apolloCustomIndexLabel() } : {}),
    },
  ]

  const footer = (
    <Box flexDirection="column">
      <Divider color="inactive" />
      <Box flexDirection="row" gap={1}>
        {isFooterFocused && footerIndex === 0 ? (
          <Text color="suggestion">{figures.pointer}</Text>
        ) : (
          <Text> </Text>
        )}
        <Text color={isFooterFocused && footerIndex === 0 ? 'suggestion' : undefined}>
          {options.length + 1}. Chat about this
        </Text>
      </Box>
      {isInPlanMode && (
        <Box flexDirection="row" gap={1}>
          {isFooterFocused && footerIndex === 1 ? (
            <Text color="suggestion">{figures.pointer}</Text>
          ) : (
            <Text> </Text>
          )}
          <Text color={isFooterFocused && footerIndex === 1 ? 'suggestion' : undefined}>
            {options.length + 2}. Skip interview and plan immediately
          </Text>
        </Box>
      )}
    </Box>
  )

  const helpLine = (
    <Box marginTop={1}>
      <Text color="inactive" dimColor>
        Enter to select ·{' '}
        {questions.length === 1 ? (
          <>
            {figures.arrowUp}/{figures.arrowDown} to navigate
          </>
        ) : (
          'Tab/Arrow keys to navigate'
        )}
        {isOtherFocused && editorName && <> · ctrl+g to edit in {editorName}</>} · Esc to cancel
      </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" marginTop={0} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {isInPlanMode && planFilePath && (
        <Box flexDirection="column" gap={0}>
          <Divider color="inactive" />
          <Text color="inactive">
            Planning: <FilePathLink filePath={planFilePath} />
          </Text>
        </Box>
      )}
      <Box marginTop={-1}>
        <Divider color="inactive" />
      </Box>
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color="text" />
        <Box flexDirection="column" minHeight={minContentHeight}>
          <Box marginTop={1}>
            {question.multiSelect ? (
              <SelectMulti
                key={question.question}
                options={options}
                defaultValue={selectedValue as string[] | undefined}
                onChange={((values: string[]) => {
                  onUpdateQuestionState(questionText, { selectedValue: values }, true)
                  const textInput = values.includes('__other__')
                    ? questionStates[questionText]?.textInputValue
                    : undefined
                  const finalValues = values
                    .filter(v => v !== '__other__')
                    .concat(textInput ? [textInput] : [])
                  onAnswer(questionText, finalValues, undefined, false)
                }) as (values: unknown[]) => void}
                onFocus={handleFocus}
                onCancel={onCancel}
                submitButtonText={currentQuestionIndex === questions.length - 1 ? 'Submit' : 'Next'}
                onSubmit={onSubmit}
                onDownFromLastItem={() => setIsFooterFocused(true)}
                isDisabled={isFooterFocused}
                onOpenEditor={handleOpenEditor}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
              />
            ) : (
              <Select
                key={question.question}
                options={options}
                defaultValue={selectedValue as string | undefined}
                defaultFocusValue={selectedValue as string | undefined}
                onChange={((value: string) => {
                  onUpdateQuestionState(questionText, { selectedValue: value }, false)
                  const textInput =
                    value === '__other__' ? questionStates[questionText]?.textInputValue : undefined
                  onAnswer(questionText, value, textInput)
                }) as (value: unknown) => void}
                onFocus={handleFocus}
                onCancel={onCancel}
                onDownFromLastItem={() => setIsFooterFocused(true)}
                isDisabled={isFooterFocused}
                layout="compact-vertical"
                onOpenEditor={handleOpenEditor}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
              />
            )}
          </Box>
          {footer}
          {helpLine}
        </Box>
      </Box>
    </Box>
  )
}
