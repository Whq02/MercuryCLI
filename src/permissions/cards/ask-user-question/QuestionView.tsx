import figures from 'figures'
import React, { useCallback, useContext, useRef, useState } from 'react'
import { CockpitActiveContext } from '../../../screen/cockpit/cockpitActiveContext.js'
import type { KeyboardEvent } from '../../../screen/renderer/events/keyboard-event.js'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import { useOptionalKeybindingContext } from '../../../screen/keys/KeybindingContext.js'
import { useActionAffordance } from '../../../screen/keys/useShortcutDisplay.js'
import { useAppState } from '../../../screen/app-state/AppState.js'
import type { AppState } from '../../../screen/app-state/AppState.js'
import type { Question } from '../../../tools/ask-question/AskUserQuestionTool.js'
import { DISCUSS_OPTION_LABEL } from '../../../tools/ask-question/prompt.js'
import {
  apolloCustomIndexLabel,
  apolloIndexLabel,
} from '../../../tools/ask-question/apolloLetters.js'
import type { PastedContent } from '../../../platform/settings/config.js'
import { editorDisplayName, getExternalEditor } from '../../../platform/editor/externalEditor.js'
import type { ImageDimensions } from '../../../platform/images/imageResizer.js'
import { editPromptInEditor } from '../../../screen/composer/promptEditor.js'
import { type OptionWithDescription, Select, SelectMulti } from '../../../screen/select/index.js'
import { decodeDomNavKey } from '../../../screen/widgets/navSemantics.js'
import { Divider } from '../../../screen/theme/Divider.js'
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
  onSubmit?: () => void
  onTabNext?: () => void
  onTabPrev?: () => void
  onRespondToModel?: () => void | Promise<void>
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
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
    args.questionCount === 1
      ? `${figures.arrowUp}/${figures.arrowDown} to navigate`
      : 'Tab/Arrow keys to navigate'
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
    hideSubmitTab = questions.length === 1 && !question.multiSelect,
    minContentHeight,
    onUpdateQuestionState,
    onAnswer,
    onTextInputFocus,
    onCancel,
    onSubmit,
    onTabNext,
    onTabPrev,
    onRespondToModel,
    onImagePaste,
    pastedContents,
    onRemoveImage,
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
    return <PreviewQuestionView {...props} hideSubmitTab={hideSubmitTab} />
  }

  const optionItems = buildQuestionOptions({
    question,
    isApolloMode,
    textInputValue,
    onChangeOther: val => {
      textInputRef.current = val
      setEmptyOtherHint(false)
      onUpdateQuestionState(question.question, { textInputValue: val })
    },
  })

  const isLastQuestion = currentQuestionIndex === questions.length - 1
  const singleSelected =
    typeof selectedValue === 'string' ? selectedValue : undefined
  const multiSelected = Array.isArray(selectedValue) ? selectedValue : []


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
      marginTop={0}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Box marginTop={cockpitActive ? -1 : 0}>
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
                options={optionItems}
                defaultValue={multiSelected}
                isDisabled={isFooterFocused}
                scrollMovesFocus={false}
                submitButtonText={isLastQuestion ? 'Submit' : 'Next'}
                onFocus={(value: string) => {
                  const onOther = value === OTHER_OPTION_VALUE
                  setIsSubmitFocused(false)
                  setIsFocusedOnOther(onOther)
                  if (!onOther) setEmptyOtherHint(false)
                  onTextInputFocus(onOther)
                }}
                onSubmitFocusChange={(focused: boolean) => {
                  setIsSubmitFocused(focused)
                  if (focused) {
                    setIsFocusedOnOther(false)
                    setEmptyOtherHint(false)
                    onTextInputFocus(false)
                  }
                }}
                onChange={(values: string[]) => {
                  onUpdateQuestionState(question.question, { selectedValue: values }, true)
                  onAnswer(
                    question.question,
                    values,
                    values.includes(OTHER_OPTION_VALUE) ? textInputRef.current : undefined,
                    false,
                  )
                }}
                onSubmit={onSubmit}
                onEmptyInputSubmit={() => setEmptyOtherHint(true)}
                onCancel={onCancel}
                onDownFromLastItem={() => {
                  wasSubmitFocusedRef.current = isSubmitFocused
                  setIsFooterFocused(true)
                  setIsSubmitFocused(false)
                  setEmptyOtherHint(false)
                  onTextInputFocus(false)
                }}
                onTabOut={(dir: 'next' | 'previous') => (dir === 'next' ? onTabNext?.() : onTabPrev?.())}
                onOpenEditor={handleOpenEditor}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
              />
            ) : (
              <Select
                key={question.question}
                options={optionItems}
                defaultValue={singleSelected}
                defaultFocusValue={singleSelected}
                layout="compact-vertical"
                isDisabled={isFooterFocused}
                scrollMovesFocus={false}
                onFocus={value => {
                  const onOther = value === OTHER_OPTION_VALUE
                  setIsFocusedOnOther(onOther)
                  if (!onOther) setEmptyOtherHint(false)
                  onTextInputFocus(onOther)
                }}
                onChange={value => {
                  onUpdateQuestionState(question.question, { selectedValue: value }, false)
                  onAnswer(
                    question.question,
                    value,
                    value === OTHER_OPTION_VALUE ? textInputRef.current : undefined,
                  )
                }}
                onEmptyInputSubmit={() => setEmptyOtherHint(true)}
                onCancel={onCancel}
                onDownFromLastItem={() => {
                  setIsFooterFocused(true)
                  setEmptyOtherHint(false)
                  onTextInputFocus(false)
                }}
                onOpenEditor={handleOpenEditor}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
              />
            )}
          </Box>
          {renderDiscussFooter(footerNumber, isFooterFocused)}
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              {helpLine}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function buildQuestionOptions({
  question,
  isApolloMode,
  textInputValue,
  onChangeOther,
}: {
  question: Question
  isApolloMode: boolean
  textInputValue: string
  onChangeOther: (val: string) => void
}): OptionWithDescription<string>[] {
  return [
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
      onChange: onChangeOther,
      ...(isApolloMode ? { indexLabel: apolloCustomIndexLabel() } : {}),
    },
  ]
}

function renderDiscussFooter(
  footerNumber: number,
  isFooterFocused: boolean,
): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Divider color="inactive" />
      <Box flexDirection="row" gap={1}>
        {isFooterFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
        <Text color={isFooterFocused ? 'suggestion' : undefined}>{`${footerNumber}. ${DISCUSS_OPTION_LABEL}`}</Text>
      </Box>
    </Box>
  )
}
