import figures from 'figures'
import React, { useCallback, useContext, useRef, useState } from 'react'
import { CockpitActiveContext } from '../../../context/cockpitActiveContext.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text, useInput } from '../../../ink.js'
import { useOptionalKeybindingContext } from '../../../keybindings/KeybindingContext.js'
import { useActionAffordance } from '../../../keybindings/useShortcutDisplay.js'
import { useAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { DISCUSS_OPTION_LABEL } from '../../../tools/AskUserQuestionTool/prompt.js'
import {
  apolloCustomIndexLabel,
  apolloIndexLabel,
} from '../../../tools/AskUserQuestionTool/apolloLetters.js'
import type { PastedContent } from '../../../utils/config.js'
import { editorDisplayName, getExternalEditor } from '../../../utils/editor.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { type OptionWithDescription, Select, SelectMulti } from '../../CustomSelect/index.js'
import { decodeDomNavKey } from '../../mercury-ui/navSemantics.js'
import { Divider } from '../../design-system/Divider.js'
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
  minContentHeight?: number
  minContentWidth?: number
  onUpdateQuestionState: (
    questionText: string,
    updates: Partial<QuestionState>,
  ) => void
  onAnswer: (
    questionText: string,
    answer: string | string[],
    textInput?: string,
    shouldAdvance?: boolean,
  ) => void
  onTextInputFocus: (isInInput: boolean) => void
  onCancel: () => void
  onSubmit?: () => void
  onTabNext?: () => void
  onTabPrev?: () => void
  onRespondToModel?: () => void | Promise<void>
  onImagePaste?: (
    questionText: string,
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (questionText: string, id: number) => void
  onNotesPasteLarge?: (questionText: string, text: string) => void
}

function buildQuestionHelpLine(args: {
  multiSelect: boolean
  emptyOtherHint: boolean
  isSubmitFocused: boolean
  isFocusedOnOther: boolean
  isFooterFocused: boolean
  questionCount: number
  editorKey: string | null
  editorName: string | null
}): string {
  const enterHint = args.emptyOtherHint
    ? args.multiSelect
      ? 'Type something first, then Enter to add it'
      : 'Type something first, then Enter to answer with it'
    : args.isSubmitFocused
      ? 'Enter to continue'
      : args.isFocusedOnOther && !args.isFooterFocused
        ? args.multiSelect
          ? 'Enter to add your text'
          : 'Enter to answer with your text'
        : 'Enter to select'
  const navHint =
    args.questionCount === 1 ? '↑/↓ to navigate' : 'Tab/Arrow keys to navigate'
  const editorHint =
    args.isFocusedOnOther && !args.isFooterFocused && args.editorKey && args.editorName
      ? ` · ${args.editorKey} to edit in ${args.editorName}`
      : ''
  return `${enterHint} · ${navHint}${editorHint} · Esc to cancel`
}

export function QuestionView(props: Props): React.ReactNode {
  const {
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
    onTabNext,
    onTabPrev,
    onRespondToModel,
    onImagePaste,
    pastedContents,
    onRemoveImage,
    onNotesPasteLarge,
  } = props

  const hasPreview =
    !question.multiSelect && question.options.some(option => Boolean(option.preview))

  const cockpitActive = useContext(CockpitActiveContext)
  const permissionMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isApolloMode = permissionMode === 'apollo'

  const questionState = questionStates[question.question]
  const selectedValue = questionState?.selectedValue
  const textInputValue = questionState?.textInputValue ?? ''
  const textInputRef = useRef(textInputValue)
  textInputRef.current = textInputValue

  const initialOtherFocused =
    !question.multiSelect && selectedValue === OTHER_OPTION_VALUE

  const [prevQuestionKey, setPrevQuestionKey] = useState(question.question)
  const [isFooterFocused, setIsFooterFocused] = useState(false)
  const [isFocusedOnOther, setIsFocusedOnOther] = useState(initialOtherFocused)
  const [isSubmitFocused, setIsSubmitFocused] = useState(false)
  const [emptyOtherHint, setEmptyOtherHint] = useState(false)
  const wasSubmitFocusedRef = useRef(false)

  if (prevQuestionKey !== question.question) {
    setPrevQuestionKey(question.question)
    setIsFooterFocused(false)
    setIsFocusedOnOther(initialOtherFocused)
    setIsSubmitFocused(false)
    setEmptyOtherHint(false)
    wasSubmitFocusedRef.current = false
  }

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

  const footerNumber = question.options.length + 2
  const discussDigit = String(footerNumber)

  useInput(
    (input, key, event) => {
      if (!question.multiSelect && isFocusedOnOther && key.tab) {
        event.stopImmediatePropagation()
        if (key.shift) onTabPrev?.()
        else onTabNext?.()
        return
      }
      if (!isFocusedOnOther && !key.ctrl && !key.meta && input === discussDigit) {
        event.stopImmediatePropagation()
        void onRespondToModel?.()
      }
    },
    { isActive: !hasPreview && !isFooterFocused },
  )

  const handleOpenEditor = useCallback(
    (currentValue: string, setValue: (value: string) => void) => {
      void editPromptInEditor(currentValue, pastedContents).then(result => {
        if (result.content !== null && result.content !== currentValue) {
          textInputRef.current = result.content
          setValue(result.content)
          onUpdateQuestionState(question.question, { textInputValue: result.content })
        }
      })
    },
    [onUpdateQuestionState, pastedContents, question.question],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isFooterFocused) return
      const action = decodeDomNavKey(e, { orientation: 'vertical' })
      if (action === 'movePrevious') {
        e.stopPropagation()
        setIsFooterFocused(false)
        if (wasSubmitFocusedRef.current) {
          setIsSubmitFocused(true)
          wasSubmitFocusedRef.current = false
        } else {
          onTextInputFocus(isFocusedOnOther)
        }
      } else if (action === 'activate') {
        e.stopPropagation()
        void onRespondToModel?.()
      } else if (action === 'cancel') {
        e.stopPropagation()
        onCancel()
      }
    },
    [isFooterFocused, isFocusedOnOther, onCancel, onRespondToModel, onTextInputFocus],
  )

  if (hasPreview) {
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
        onTabNext={onTabNext}
        onTabPrev={onTabPrev}
        onRespondToModel={onRespondToModel}
        onNotesPasteLarge={onNotesPasteLarge}
      />
    )
  }

  const optionItems: OptionWithDescription<string>[] = [
    ...question.options.map((opt, idx) => ({
      type: 'text' as const,
      value: opt.label,
      label: opt.label,
      description: opt.description,
      ...(isApolloMode ? { indexLabel: apolloIndexLabel(idx) } : {}),
    })),
    {
      type: 'input' as const,
      value: OTHER_OPTION_VALUE,
      label: 'Other',
      placeholder: question.multiSelect ? 'Type something' : 'Type something.',
      initialValue: textInputValue,
      onChange: (val: string) => {
        textInputRef.current = val
        setEmptyOtherHint(false)
        onUpdateQuestionState(question.question, { textInputValue: val })
      },
      ...(isApolloMode ? { indexLabel: apolloCustomIndexLabel() } : {}),
    },
  ]

  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const singleSelected =
    typeof selectedValue === 'string' ? selectedValue : undefined
  const multiSelected = Array.isArray(selectedValue) ? selectedValue : []

  const boundImagePaste = onImagePaste
    ? (
        base64Image: string,
        mediaType?: string,
        filename?: string,
        dimensions?: ImageDimensions,
      ) => onImagePaste(question.question, base64Image, mediaType, filename, dimensions)
    : undefined
  const boundRemoveImage = onRemoveImage
    ? (id: number) => onRemoveImage(question.question, id)
    : undefined

  const helpLine = buildQuestionHelpLine({
    multiSelect: question.multiSelect,
    emptyOtherHint,
    isSubmitFocused,
    isFocusedOnOther,
    isFooterFocused,
    questionCount: questions.length,
    editorKey,
    editorName,
  })

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      minHeight={minContentHeight}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Divider color="permission" />
      <Box flexDirection="column">
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color="text" />
        <Box marginTop={1} flexDirection="column">
          {question.multiSelect ? (
            <SelectMulti
              key={question.question}
              options={optionItems}
              defaultValue={multiSelected}
              isDisabled={isFooterFocused}
              scrollMovesFocus={!cockpitActive}
              submitButtonText={isLastQuestion ? 'Submit' : 'Next'}
              onFocus={value => {
                const onOther = value === OTHER_OPTION_VALUE
                setIsSubmitFocused(false)
                setIsFocusedOnOther(onOther)
                if (!onOther) setEmptyOtherHint(false)
                onTextInputFocus(onOther)
              }}
              onSubmitFocus={focused => {
                setIsSubmitFocused(focused)
                if (focused) {
                  setIsFocusedOnOther(false)
                  setEmptyOtherHint(false)
                  onTextInputFocus(false)
                }
              }}
              onChange={values => {
                onUpdateQuestionState(question.question, { selectedValue: values })
              }}
              onSubmit={values => {
                setEmptyOtherHint(false)
                onUpdateQuestionState(question.question, { selectedValue: values })
                onAnswer(question.question, values, textInputRef.current, true)
              }}
              onEmptyInputSubmit={() => setEmptyOtherHint(true)}
              onCancel={onCancel}
              onDownFromLastItem={() => {
                wasSubmitFocusedRef.current = isSubmitFocused
                setIsFooterFocused(true)
                setIsSubmitFocused(false)
                setEmptyOtherHint(false)
                onTextInputFocus(false)
              }}
              onTabOut={dir => {
                if (dir === 'next') onTabNext?.()
                else onTabPrev?.()
              }}
              onOpenEditor={handleOpenEditor}
              onImagePaste={boundImagePaste}
              pastedContents={pastedContents}
              onRemoveImage={boundRemoveImage}
            />
          ) : (
            <Select
              key={question.question}
              options={optionItems}
              defaultValue={singleSelected}
              defaultFocusValue={singleSelected}
              layout="compact-vertical"
              isDisabled={isFooterFocused}
              scrollMovesFocus={!cockpitActive}
              onFocus={value => {
                const onOther = value === OTHER_OPTION_VALUE
                setIsFocusedOnOther(onOther)
                if (!onOther) setEmptyOtherHint(false)
                onTextInputFocus(onOther)
              }}
              onChange={value => {
                setEmptyOtherHint(false)
                if (value === OTHER_OPTION_VALUE) {
                  onUpdateQuestionState(question.question, {
                    selectedValue: OTHER_OPTION_VALUE,
                    textInputValue: textInputRef.current,
                  })
                  onAnswer(question.question, OTHER_OPTION_VALUE, textInputRef.current, true)
                } else {
                  onUpdateQuestionState(question.question, { selectedValue: value })
                  onAnswer(question.question, value, textInputRef.current, true)
                }
              }}
              onEmptyInputSubmit={() => setEmptyOtherHint(true)}
              onCancel={onCancel}
              onDownFromLastItem={() => {
                setIsFooterFocused(true)
                setEmptyOtherHint(false)
                onTextInputFocus(false)
              }}
              onOpenEditor={handleOpenEditor}
              onImagePaste={boundImagePaste}
              pastedContents={pastedContents}
              onRemoveImage={boundRemoveImage}
            />
          )}
          <Box
            marginTop={1}
            onClick={() => {
              void onRespondToModel?.()
            }}
          >
            <Text color={isFooterFocused ? 'suggestion' : undefined} bold={isFooterFocused}>
              {isFooterFocused ? `${figures.pointer} ` : '  '}
              <Text dimColor={!isFooterFocused}>{`${footerNumber}. `}</Text>
              {DISCUSS_OPTION_LABEL}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{helpLine}</Text>
        </Box>
      </Box>
    </Box>
  )
}
