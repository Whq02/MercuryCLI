import type { ContentBlockParam } from '../../../types/wire.js'
import React, { Suspense, use, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { usePublish } from '../../../hooks/effects.js'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { useTheme } from '../../../ink.js'
import { useKeybindings } from '../../../keybindings/useKeybinding.js'
import {
  attachContext,
  buildContextBlocks,
  cancelInterview,
  detachContext,
  draftAnswer,
  imageRefNumericId,
  navigateTo,
  presentToolCall,
  requestDiscussion,
  setNote,
  submitInterview,
  type InterviewBoundary,
} from '../../../services/interview/controller.js'
import { getPastedTextRefNumLines } from '../../../history.js'
import { hashPastedText, storePastedText } from '../../../utils/pasteStore.js'
import {
  interviewSnapshot,
  subscribeInterview,
} from '../../../services/interview/store.js'
import type {
  InterviewAnswerValue,
  InterviewQuestion,
  InterviewQuestionState,
} from '../../../services/interview/contracts.js'
import { AskUserQuestionTool } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import type { PastedContent } from '../../../utils/config.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js'
import { logError } from '../../../utils/log.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { OTHER_OPTION_VALUE, projectQuestionState, type QuestionState } from './questionState.js'
import { currentQuestionView, handleQuestionAnswerOf, submitQuestionsViewOf } from './askUserQuestionParts.js'

const MIN_CONTENT_HEIGHT = 12

function sameAnswer(a: InterviewAnswerValue | undefined, b: InterviewAnswerValue): boolean {
  if (!a) return false
  if ((a.freeText ?? '') !== (b.freeText ?? '')) return false
  return a.optionIds.length === b.optionIds.length && a.optionIds.every((id, i) => id === b.optionIds[i])
}

function draftIfChanged(questionId: string, live: InterviewQuestionState | undefined, value: InterviewAnswerValue): void {
  if (sameAnswer(live?.draft, value)) return
  draftAnswer(questionId, value)
}

export function AskUserQuestionPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const settings = useSettings()
  if (settings.view?.syntaxOff) {
    return <AskUserQuestionPermissionRequestBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<AskUserQuestionPermissionRequestBody {...props} highlight={null} />}>
      <AskUserQuestionWithHighlight {...props} />
    </Suspense>
  )
}

function AskUserQuestionWithHighlight(props: PermissionRequestProps) {
  const highlight = use(getCliHighlightPromise())
  return <AskUserQuestionPermissionRequestBody {...props} highlight={highlight} />
}

const presented = new WeakSet<object>()

function toLegacyQuestion(q: InterviewQuestion) {
  return {
    id: q.id,
    decisionId: q.decisionId,
    question: q.text,
    header: q.header,
    multiSelect: q.multiSelect,
    options: q.options.map(o => ({
      id: o.id,
      label: o.label,
      description: o.description,
      ...(o.preview !== undefined ? { preview: o.preview } : {}),
    })),
  }
}

function computeGlobalContentSize(
  questions: InterviewQuestion[],
  terminalRows: number,
  theme: Parameters<typeof applyMarkdown>[1],
  highlight: CliHighlight | null,
): { height: number; width: number } {
  const maxAllowedHeight = Math.max(MIN_CONTENT_HEIGHT, terminalRows - 15)
  let height = MIN_CONTENT_HEIGHT
  let width = 40
  for (const q of questions) {
    for (const opt of q.options) {
      if (!opt.preview) continue
      const rendered = applyMarkdown(opt.preview, theme, highlight)
      const lines = rendered.split('\n')
      height = Math.max(height, lines.length + 2)
      for (const line of lines) {
        width = Math.max(width, stringWidth(line) + 4)
      }
    }
  }
  return {
    height: Math.max(MIN_CONTENT_HEIGHT, Math.min(maxAllowedHeight, height)),
    width: Math.max(40, width),
  }
}

function applyQuestionStateUpdate(
  q: InterviewQuestion,
  live: InterviewQuestionState | undefined,
  updates: Partial<QuestionState>,
): void {
  const isPreviewQuestion = !q.multiSelect && q.options.some(o => Boolean(o.preview))
  if (isPreviewQuestion && updates.textInputValue !== undefined) {
    setNote(q.id, updates.textInputValue)
    if (updates.selectedValue === undefined) return
  }

  const selectedLabels =
    updates.selectedValue !== undefined
      ? Array.isArray(updates.selectedValue)
        ? updates.selectedValue
        : [updates.selectedValue]
      : undefined

  const optionIds =
    selectedLabels !== undefined
      ? selectedLabels
          .filter(label => label !== OTHER_OPTION_VALUE)
          .map(label => q.options.find(o => o.label === label)?.id)
          .filter((id): id is string => typeof id === 'string')
      : (live?.draft?.optionIds ?? live?.committed?.optionIds ?? [])

  const priorFreeText = live?.draft?.freeText ?? live?.committed?.freeText
  let freeText: string | undefined
  if (isPreviewQuestion) {
    freeText = priorFreeText
  } else if (updates.textInputValue !== undefined) {
    freeText = updates.textInputValue
  } else if (q.multiSelect && selectedLabels !== undefined) {
    freeText = selectedLabels.includes(OTHER_OPTION_VALUE) ? priorFreeText : undefined
  } else {
    freeText = priorFreeText
  }

  const value: InterviewAnswerValue = {
    optionIds,
    ...(freeText ? { freeText } : {}),
  }
  draftIfChanged(q.id, live, value)
}

function buildChipContents(
  session: ReturnType<typeof interviewSnapshot>,
  currentQuestionId: string | undefined,
  cache: Record<number, PastedContent>,
): Record<number, PastedContent> {
  const result: Record<number, PastedContent> = {}
  for (const ref of session.context) {
    if (ref.kind !== 'image') continue
    const scope = session.contextScope[ref.refId]
    if (scope !== undefined && scope !== currentQuestionId) continue
    const id = imageRefNumericId(ref.refId)
    if (id === null) continue
    result[id] = cache[id] ?? {
      id,
      type: 'image',
      content: '',
      filename: ref.label,
    }
  }
  return result
}

function makeBoundary(
  toolUseConfirm: PermissionRequestProps['toolUseConfirm'],
  onReject: () => void,
  contentBlocks?: ContentBlockParam[],
): InterviewBoundary {
  const nonEmpty = contentBlocks && contentBlocks.length > 0 ? contentBlocks : undefined
  return {
    onAllow: updatedInput => {
      void toolUseConfirm.onAllow(updatedInput, [], undefined, nonEmpty)
    },
    onReject: () => {
      onReject()
      toolUseConfirm.onReject()
    },
  }
}

function attachPastedImage(
  questionId: string | undefined,
  nextImageIdRef: { current: number },
  chipCache: Record<number, PastedContent>,
  base64Image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
): void {
  let id = nextImageIdRef.current
  for (const ref of interviewSnapshot().context) {
    const existing = imageRefNumericId(ref.refId)
    if (existing !== null && existing >= id) id = existing + 1
  }
  nextImageIdRef.current = id + 1
  const pasted: PastedContent = {
    id,
    type: 'image',
    content: base64Image,
    mediaType: mediaType ?? 'image/png',
    filename,
    dimensions,
    sourcePath,
  }
  chipCache[id] = pasted
  cacheImagePath(pasted)
  void storeImage(pasted).catch(logError)
  attachContext(
    { refId: `image:${id}`, kind: 'image', label: filename ?? `Image #${id}` },
    questionId,
  )
}

function attachLargePasteNote(questionId: string, text: string): void {
  const hash = hashPastedText(text)
  void storePastedText(hash, text).catch(logError)
  const numLines = getPastedTextRefNumLines(text)
  const marker = `[Pasted context: ${numLines} lines]`
  attachContext({ refId: `paste:${hash}`, kind: 'large-paste', label: marker }, questionId)
  const existing = interviewSnapshot().questions[questionId]?.note ?? ''
  setNote(questionId, existing ? `${existing} ${marker}` : marker)
}

function AskUserQuestionPermissionRequestBody(
  props: PermissionRequestProps & { highlight: CliHighlight | null },
): React.ReactNode {
  const { toolUseConfirm, onDone, onReject, highlight } = props
  const parsed = AskUserQuestionTool.inputSchema.parse(toolUseConfirm.input)
  const { rows: terminalRows } = useTerminalSize()
  const [theme] = useTheme()

  usePublish(() => {
    if (presented.has(toolUseConfirm)) return
    presented.add(toolUseConfirm)
    presentToolCall({
      input: { questions: parsed.questions },
      toolUseId: toolUseConfirm.toolUseID,
    })
  }, [toolUseConfirm, parsed.questions])

  const session = useSyncExternalStore(
    subscribeInterview,
    interviewSnapshot,
    interviewSnapshot,
  )

  const [isInTextInput, setIsInTextInput] = useState(false)
  const [reviewFocusValue, setReviewFocusValue] = useState<string | undefined>(undefined)
  const editReturnRef = useRef<string | null>(null)
  const nextImageIdRef = useRef(1)
  const chipCacheRef = useRef<Record<number, PastedContent>>({})

  const questions: InterviewQuestion[] = session.questionOrder
    .map(id => session.questions[id]?.question)
    .filter((q): q is InterviewQuestion => !!q)

  const byText = useCallback(
    (questionText: string) => questions.find(q => q.text === questionText),
    [questions],
  )

  const isReview = session.focus === 'review'
  const rawIndex = isReview
    ? questions.length
    : questions.findIndex(q => q.id === session.focus)
  const currentQuestionIndex = isReview ? questions.length : Math.max(0, rawIndex)
  const currentQuestion = isReview ? undefined : questions[currentQuestionIndex]
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect
  const totalTabs = hideSubmitTab ? questions.length : questions.length + 1

  const { height: globalContentHeight, width: globalContentWidth } =
    computeGlobalContentSize(questions, terminalRows, theme, highlight)

  const answers: Record<string, string> = {}
  const questionStates: Record<string, QuestionState> = {}
  for (const q of questions) {
    const qs = session.questions[q.id]
    if (!qs) continue
    questionStates[q.text] = projectQuestionState(qs)
    if (qs.committed) {
      const rendered = displayAnswer(qs.committed, q)
      if (rendered) answers[q.text] = rendered
    }
  }
  const allQuestionsAnswered =
    questions.length > 0 && questions.every(q => Boolean(answers[q.text]))

  const handleTabPrev = useCallback(() => {
    if (currentQuestionIndex <= 0) return
    const target = questions[currentQuestionIndex - 1]
    if (target) navigateTo(target.id)
  }, [currentQuestionIndex, questions])

  const handleTabNext = useCallback(() => {
    if (currentQuestionIndex >= totalTabs - 1) return
    const nextIdx = currentQuestionIndex + 1
    if (nextIdx >= questions.length) {
      if (!hideSubmitTab) navigateTo('review')
      return
    }
    const target = questions[nextIdx]
    if (target) navigateTo(target.id)
  }, [currentQuestionIndex, totalTabs, questions, hideSubmitTab])

  useKeybindings(
    { 'tabs:previous': handleTabPrev, 'tabs:next': handleTabNext },
    { context: 'Tabs', isActive: isReview || !isInTextInput },
  )

  const handleUpdateQuestionState = useCallback(
    (questionText: string, updates: Partial<QuestionState>) => {
      const q = byText(questionText)
      if (!q) return
      applyQuestionStateUpdate(q, interviewSnapshot().questions[q.id], updates)
    },
    [byText],
  )

  const handleCancel = useCallback(() => {
    cancelInterview({
      onAllow: () => {},
      onReject: () => {
        onDone()
        onReject()
        toolUseConfirm.onReject()
      },
    })
  }, [onDone, onReject, toolUseConfirm])

  const handleSubmit = useCallback(async () => {
    const blocks = await buildContextBlocks(interviewSnapshot())
    onDone()
    submitInterview(makeBoundary(toolUseConfirm, onReject, blocks), toolUseConfirm.input)
  }, [onDone, onReject, toolUseConfirm])

  const handleRespondToModel = useCallback(async () => {
    const target = currentQuestion ?? questions[0]
    if (!target) {
      handleCancel()
      return
    }
    const blocks = await buildContextBlocks(interviewSnapshot())
    onDone()
    requestDiscussion(
      makeBoundary(toolUseConfirm, onReject, blocks),
      toolUseConfirm.input,
      target.id,
    )
  }, [currentQuestion, questions, handleCancel, onDone, onReject, toolUseConfirm])

  const handleQuestionAnswer = useCallback(
    (questionText: string, label: string | string[], textInput?: string, shouldAdvance = true) => {
      handleQuestionAnswerOf(
        { byText, session, questions, handleSubmit, editReturnRef, setReviewFocusValue },
        questionText,
        label,
        textInput,
        shouldAdvance,
      )
    },
    [byText, session, questions, handleSubmit],
  )

  const handleEditQuestion = useCallback(
    (questionText: string) => {
      const q = byText(questionText)
      if (!q) return
      editReturnRef.current = q.text
      navigateTo(q.id)
    },
    [byText],
  )

  const handleFinalResponse = useCallback(
    (value: 'submit' | 'cancel') => {
      if (value === 'submit') handleSubmit().catch(logError)
      else handleCancel()
    },
    [handleSubmit, handleCancel],
  )

  const onImagePaste = useCallback(
    (
      questionText: string,
      base64Image: string,
      mediaType?: string,
      filename?: string,
      dimensions?: ImageDimensions,
      sourcePath?: string,
    ) => {
      attachPastedImage(
        byText(questionText)?.id,
        nextImageIdRef,
        chipCacheRef.current,
        base64Image,
        mediaType,
        filename,
        dimensions,
        sourcePath,
      )
    },
    [byText],
  )

  const onRemoveImage = useCallback((_questionText: string, id: number) => {
    delete chipCacheRef.current[id]
    detachContext(`image:${id}`)
  }, [])

  const handleNotesPasteLarge = useCallback(
    (questionText: string, text: string) => {
      const q = byText(questionText)
      if (q) attachLargePasteNote(q.id, text)
    },
    [byText],
  )

  const chipContents = buildChipContents(session, currentQuestion?.id, chipCacheRef.current)

  if (questions.length === 0) return null

  if (isReview) {
    return submitQuestionsViewOf({
      questions,
      session,
      toLegacyQuestion,
      currentQuestionIndex,
      answers,
      allQuestionsAnswered,
      toolUseConfirm,
      globalContentHeight,
      handleEditQuestion,
      reviewFocusValue,
      handleFinalResponse,
    })
  }

  if (!currentQuestion) return null

  return currentQuestionView({
    currentQuestion,
    toLegacyQuestion,
    questions,
    currentQuestionIndex,
    answers,
    questionStates,
    hideSubmitTab,
    globalContentHeight,
    globalContentWidth,
    handleUpdateQuestionState,
    handleQuestionAnswer,
    handleTextInputFocus: setIsInTextInput,
    handleCancel,
    handleTabNext,
    handleTabPrev,
    handleRespondToModel,
    onImagePaste,
    chipContents,
    onRemoveImage,
    handleNotesPasteLarge,
  })
}

function displayAnswer(
  value: { optionIds: string[]; freeText?: string },
  q: InterviewQuestion,
): string {
  const labels = value.optionIds
    .map(id => q.options.find(o => o.id === id)?.label)
    .filter((l): l is string => !!l)
  const joined = labels.join(', ')
  if (value.freeText?.trim()) return joined ? `${joined} · ${value.freeText.trim()}` : value.freeText.trim()
  return joined
}

