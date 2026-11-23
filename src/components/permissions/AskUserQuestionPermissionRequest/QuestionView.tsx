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
import { InteractiveRow } from '../../mercury-ui/InteractiveRow.js'
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
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
  onNotesPasteLarge?: (text: string) => void
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
    hideSubmitTab = questions.length === 1 && !question.multiSelect,
    minContentHeight,
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
              onFocus={(value: string) => {
                const onOther = value === OTHER_OPTION_VALUE
                setIsSubmitFocused(false)
                setIsFocusedOnOther(onOther)
                if (!onOther) setEmptyOtherHint(false)
                onTextInputFocus(onOther)
              }}
              onSubmitFocus={(focused: boolean) => {
                setIsSubmitFocused(focused)
                if (focused) {
                  setIsFocusedOnOther(false)
                  setEmptyOtherHint(false)
                  onTextInputFocus(false)
                }
              }}
              onChange={(values: string[]) =>
                onUpdateQuestionState(question.question, { selectedValue: values })
              }
              onSubmit={(values: string[]) => {
                setEmptyOtherHint(false)
                onUpdateQuestionState(question.question, { selectedValue: values })
                onAnswer(
                  question.question,
                  values,
                  values.includes(OTHER_OPTION_VALUE) ? textInputRef.current : undefined,
                  true,
                )
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
              onTabOut={(dir: 'next' | 'prev') => (dir === 'next' ? onTabNext?.() : onTabPrev?.())}
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
                  onAnswer(question.question, value, undefined, true)
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
              onImagePaste={onImagePaste}
              pastedContents={pastedContents}
              onRemoveImage={onRemoveImage}
            />
          )}
          {renderDiscussFooter(footerNumber, isFooterFocused, onRespondToModel)}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{helpLine}</Text>
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
  onRespondToModel?: () => void | Promise<void>,
): React.ReactNode {
  return (
    <Box marginTop={1}>
      <InteractiveRow
        id="question:discuss-footer"
        directActivate
        selectionBand={false}
        onActivate={
          onRespondToModel
            ? () => {
                void onRespondToModel()
              }
            : undefined
        }
      >
        <Text color={isFooterFocused ? 'suggestion' : undefined} bold={isFooterFocused}>
          {isFooterFocused ? `${figures.pointer} ` : '  '}
          <Text dimColor={!isFooterFocused}>{`${footerNumber}. `}</Text>
          {DISCUSS_OPTION_LABEL}
        </Text>
      </InteractiveRow>
    </Box>
  )
}
