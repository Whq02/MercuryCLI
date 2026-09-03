import figures from 'figures'
import React, { useCallback, useRef, useState } from 'react'
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
import { OTHER_OPTION_VALUE, type QuestionState } from './questionState.js'

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
  const isApolloPoll = permissionMode === 'apollo'
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [footerIndex, setFooterIndex] = useState(0)
  const [isOtherFocused, setIsOtherFocused] = useState(false)
  const [showEmptyOtherHint, setShowEmptyOtherHint] = useState(false)
  const [isNextFocused, setIsNextFocused] = useState(false)
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : null

  const questionText = question.question
  const questionState = questionStates[questionText]
  const otherTextRef = useRef<string | null>(null)
  const otherText = (): string => otherTextRef.current ?? questionState?.textInputValue ?? ''

  const handleFocus = useCallback(
    (value: unknown) => {
      const isOther = value === OTHER_OPTION_VALUE
      setIsOtherFocused(isOther)
      onTextInputFocus(isOther)
      if (!isOther) setShowEmptyOtherHint(false)
    },
    [onTextInputFocus],
  )
  const showEmptyHint = useCallback(() => setShowEmptyOtherHint(true), [])

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

  useInput(
    (_input, key, event) => {
      if (!key.tab) return
      event.stopImmediatePropagation()
      if (key.shift) onTabPrev?.()
      else onTabNext?.()
    },
    { isActive: isOtherFocused && !question.multiSelect && !routesToPreview },
  )

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
      value: OTHER_OPTION_VALUE,
      label: 'Other',
      placeholder: question.multiSelect ? 'Type something' : 'Type something.',
      initialValue: questionState?.textInputValue ?? '',
      onChange: (value: string) => {
        otherTextRef.current = value
        setShowEmptyOtherHint(false)
        onUpdateQuestionState(questionText, { textInputValue: value }, question.multiSelect ?? false)
      },
      ...(isApolloPoll ? { indexLabel: apolloCustomIndexLabel() } : {}),
    },
  ]

  const enterHint = showEmptyOtherHint
    ? question.multiSelect
      ? 'Type something first, then Enter to add it'
      : 'Type something first, then Enter to answer with it'
    : isNextFocused
      ? 'Enter to continue'
      : isOtherFocused
        ? question.multiSelect
          ? 'Enter to add your text'
          : 'Enter to answer with your text'
        : 'Enter to select'

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
        {enterHint} ·{' '}
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
                  const textInput = values.includes(OTHER_OPTION_VALUE) ? otherText() : undefined
                  onAnswer(questionText, values, textInput, false)
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
                onEmptyInputSubmit={showEmptyHint}
                onTabOut={direction => (direction === 'next' ? onTabNext?.() : onTabPrev?.())}
                onSubmitFocusChange={setIsNextFocused}
              />
            ) : (
              <Select
                key={question.question}
                options={options}
                defaultValue={selectedValue as string | undefined}
                defaultFocusValue={selectedValue as string | undefined}
                onChange={((value: string) => {
                  onUpdateQuestionState(questionText, { selectedValue: value }, false)
                  const textInput = value === OTHER_OPTION_VALUE ? otherText() : undefined
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
                onEmptyInputSubmit={showEmptyHint}
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
