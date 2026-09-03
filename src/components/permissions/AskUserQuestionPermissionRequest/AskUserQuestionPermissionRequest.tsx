import type { ContentBlockParam } from '../../../types/wire.js'
import React, { Suspense, use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import {
  getSessionRailRows,
  subscribeSessionRailRows,
} from '../../../utils/cockpit/helmFocus.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { useTheme } from '../../../ink.js'
import { useKeybindings } from '../../../keybindings/useKeybinding.js'
import {
  attachContext,
  buildContextBlocks,
  cancelInterview,
  commitAnswer,
  detachContext,
  draftAnswer,
  imageRefNumericId,
  navigateTo,
  presentToolCall,
  requestDiscussion,
  requestFinish,
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
  InterviewSessionState,
} from '../../../services/interview/contracts.js'
import type { AppState } from '../../../state/AppState.js'
import { useAppState } from '../../../state/AppState.js'
import { AskUserQuestionTool } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import type { PastedContent } from '../../../utils/config.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js'
import { logError } from '../../../utils/log.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js'
import { getPlanFilePath } from '../../../utils/plans.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { OTHER_OPTION_VALUE, projectQuestionState, type QuestionState } from './questionState.js'
import { QuestionView } from './QuestionView.js'
import { SubmitQuestionsView } from './SubmitQuestionsView.js'

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
const MIN_CONTENT_WIDTH = 40
const CONTENT_CHROME_OVERHEAD = 15

export function AskUserQuestionPermissionRequest(props: PermissionRequestProps) {
  const settings = useSettings()
  if (settings.syntaxHighlightingDisabled) {
    return <AskUserQuestionPermissionRequestBody {...props} highlight={null} />
  }
  return (
    <Suspense fallback={<AskUserQuestionPermissionRequestBody {...props} highlight={null} />}>
      <AskUserQuestionWithHighlight {...props} />
    </Suspense>
  )
}

function AskUserQuestionWithHighlight(props: PermissionRequestProps) {
  const highlight = use(getCliHighlightPromise()) as CliHighlight | null
  return <AskUserQuestionPermissionRequestBody {...props} highlight={highlight} />
}

const presented = new WeakSet<object>()

function AskUserQuestionPermissionRequestBody(
  props: PermissionRequestProps & { highlight: CliHighlight | null },
) {
  const { toolUseConfirm, onDone, onReject, highlight } = props

  const parsed = AskUserQuestionTool.inputSchema.safeParse(toolUseConfirm.input)
  const inputQuestions = parsed.success ? (parsed.data.questions ?? []) : []

  if (!presented.has(toolUseConfirm)) {
    presented.add(toolUseConfirm)
    presentToolCall({
      input: { questions: inputQuestions },
      toolUseId: toolUseConfirm.toolUseID,
      mission: inputQuestions[0]?.question,
    })
  }
  const session = useSyncExternalStore(subscribeInterview, interviewSnapshot)

  const questions: InterviewQuestion[] = React.useMemo(
    () =>
      session.questionOrder
        .map(qid => session.questions[qid]?.question)
        .filter((q): q is InterviewQuestion => !!q),
    [session],
  )

  const byText = useCallback(
    (questionText: string): InterviewQuestion | undefined =>
      questions.find(q => q.text === questionText),
    [questions],
  )

  const nextPasteIdRef = useRef(0)

  const { rows: terminalRows, columns: terminalColumns } = useTerminalSize()
  const [theme] = useTheme()
  const toolPermissionContextMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isInPlanMode = toolPermissionContextMode === 'strategy'
  const planFilePath = isInPlanMode ? getPlanFilePath() : undefined

  const railRows = useSyncExternalStore(
    subscribeSessionRailRows,
    getSessionRailRows,
    getSessionRailRows,
  )
  const maxAllowedHeight = Math.max(
    MIN_CONTENT_HEIGHT,
    terminalRows - CONTENT_CHROME_OVERHEAD - railRows,
  )
  const { globalContentHeight, globalContentWidth } = React.useMemo(() => {
    let maxHeight = 0
    let maxWidth = 0
    for (const q of questions) {
      const hasPreview = q.options.some(o => o.preview)
      if (hasPreview) {
        const maxPreviewContentLines = Math.max(1, maxAllowedHeight - 11)
        let maxPreviewBoxHeight = 0
        for (const opt of q.options) {
          if (!opt.preview) continue
          const rendered = applyMarkdown(opt.preview, theme, highlight, terminalColumns)
          const previewLines = rendered.split('\n')
          const isTruncated = previewLines.length > maxPreviewContentLines
          const displayedLines = isTruncated ? maxPreviewContentLines : previewLines.length
          maxPreviewBoxHeight = Math.max(maxPreviewBoxHeight, displayedLines + (isTruncated ? 1 : 0) + 2)
          for (const line of previewLines) maxWidth = Math.max(maxWidth, stringWidth(line))
        }
        const sideByHeight = Math.max(q.options.length + 2, maxPreviewBoxHeight + 2)
        maxHeight = Math.max(maxHeight, sideByHeight + 7)
      } else {
        maxHeight = Math.max(maxHeight, q.options.length + 3 + 7)
      }
    }
    return {
      globalContentHeight: Math.min(Math.max(maxHeight, MIN_CONTENT_HEIGHT), maxAllowedHeight),
      globalContentWidth: Math.max(maxWidth, MIN_CONTENT_WIDTH),
    }
  }, [questions, maxAllowedHeight, theme, highlight, terminalColumns])

  const currentQuestionIndex =
    session.focus === 'review'
      ? questions.length
      : Math.max(0, questions.findIndex(q => q.id === session.focus))
  const isInSubmitView = session.focus === 'review'
  const currentQuestion = isInSubmitView ? null : (questions[currentQuestionIndex] ?? null)

  const answers: Record<string, string> = {}
  const questionStates: Record<string, QuestionState> = {}
  for (const q of questions) {
    const qs = session.questions[q.id]
    if (!qs) continue
    if (qs.committed) answers[q.text] = displayAnswer(qs.committed, q)
    questionStates[q.text] = projectQuestionState(qs)
  }
  const allQuestionsAnswered = questions.every(q => !!answers[q.text])
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect
  const [isInTextInput, setIsInTextInput] = useState(false)
  const editReturnRef = useRef<string | null>(null)
  const [reviewFocusValue, setReviewFocusValue] = useState<string | undefined>(undefined)

  const boundaryWith = useCallback(
    (blocks: ContentBlockParam[] | undefined): InterviewBoundary => ({
      onAllow: updatedInput =>
        toolUseConfirm.onAllow(
          updatedInput as never,
          [],
          undefined,
          blocks && blocks.length > 0 ? blocks : undefined,
        ),
      onReject: () => toolUseConfirm.onReject(),
    }),
    [toolUseConfirm],
  )

  const handleCancel = useCallback(() => {
    cancelInterview({ onAllow: () => {}, onReject: () => toolUseConfirm.onReject() })
    onDone()
    onReject()
  }, [onDone, onReject, toolUseConfirm])

  const handleSubmit = useCallback(async () => {
    const blocks = await buildContextBlocks(session)
    onDone()
    submitInterview(boundaryWith(blocks), toolUseConfirm.input as Record<string, unknown>)
  }, [session, onDone, boundaryWith, toolUseConfirm])

  const handleRespondToClaude = useCallback(async () => {
    const target = currentQuestion ?? questions[0]
    if (!target) {
      handleCancel()
      return
    }
    const blocks = await buildContextBlocks(session)
    onDone()
    requestDiscussion(boundaryWith(blocks), toolUseConfirm.input as Record<string, unknown>, target.id)
  }, [currentQuestion, questions, session, onDone, boundaryWith, toolUseConfirm, handleCancel])

  const handleFinishPlanInterview = useCallback(async () => {
    const blocks = await buildContextBlocks(session)
    onDone()
    requestFinish(boundaryWith(blocks), toolUseConfirm.input as Record<string, unknown>)
  }, [session, onDone, boundaryWith, toolUseConfirm])

  const handleUpdateQuestionState = useCallback(
    (
      questionText: string,
      updates: { selectedValue?: string | string[]; textInputValue?: string },
      isMultiSelect: boolean,
    ) => {
      const q = byText(questionText)
      if (!q) return
      const live = interviewSnapshot().questions[q.id]
      const prior = live?.draft ?? live?.committed
      if (updates.textInputValue !== undefined) {
        const hasPreview = !q.multiSelect && q.options.some(o => o.preview)
        if (hasPreview) {
          setNote(q.id, updates.textInputValue)
        } else {
          draftIfChanged(q.id, live, { optionIds: prior?.optionIds ?? [], freeText: updates.textInputValue })
        }
      }
      if (updates.selectedValue !== undefined) {
        const labels = Array.isArray(updates.selectedValue) ? updates.selectedValue : [updates.selectedValue]
        const optionIds = labels
          .filter(l => l !== OTHER_OPTION_VALUE)
          .map(l => q.options.find(o => o.label === l)?.id)
          .filter((id): id is string => !!id)
        const carriesText = !q.multiSelect || labels.includes(OTHER_OPTION_VALUE)
        const freeText = carriesText ? prior?.freeText : undefined
        draftIfChanged(q.id, live, { optionIds, ...(freeText ? { freeText } : {}) })
      }
      void isMultiSelect
    },
    [byText],
  )

  const handleQuestionAnswer = useCallback(
    (questionText: string, label: string | string[], textInput?: string, shouldAdvance = true) => {
      const q = byText(questionText)
      if (!q) return
      const isMulti = Array.isArray(label)
      const labels = isMulti ? label : [label]
      const optionIds = labels
        .filter(l => l !== OTHER_OPTION_VALUE)
        .map(l => q.options.find(o => o.label === l)?.id)
        .filter((id): id is string => !!id)
      const other = labels.includes(OTHER_OPTION_VALUE)
      const live = interviewSnapshot().questions[q.id]
      const typed = (textInput ?? live?.draft?.freeText ?? live?.committed?.freeText ?? '').trim()
      const hasImage = session.context.some(
        c =>
          c.kind === 'image' &&
          (session.contextScope[c.refId] === undefined || session.contextScope[c.refId] === q.id),
      )
      const freeText = other
        ? typed
          ? hasImage
            ? `${typed} (Image attached)`
            : typed
          : hasImage
            ? '(Image attached)'
            : undefined
        : undefined
      commitAnswer(q.id, { optionIds, ...(freeText ? { freeText } : {}) })
      const isSingleQuestion = questions.length === 1
      if (!isMulti && isSingleQuestion && shouldAdvance) {
        handleSubmit().catch(logError)
        return
      }
      if (shouldAdvance) {
        if (editReturnRef.current === q.text) {
          editReturnRef.current = null
          setReviewFocusValue(q.text)
          navigateTo('review')
          return
        }
        const idx = questions.findIndex(x => x.id === q.id)
        const next = questions[idx + 1]
        navigateTo(next ? next.id : 'review')
      }
    },
    [byText, session, questions, handleSubmit],
  )

  const handleEditQuestion = useCallback(
    (questionText: string) => {
      const q = byText(questionText)
      if (!q) return
      editReturnRef.current = q.text
      setReviewFocusValue(q.text)
      navigateTo(q.id)
    },
    [byText],
  )

  const handleFinalResponse = useCallback(
    (value: 'submit' | 'cancel') => {
      if (value === 'cancel') {
        handleCancel()
        return
      }
      handleSubmit().catch(logError)
    },
    [handleCancel, handleSubmit],
  )

  const maxIndex = hideSubmitTab ? Math.max(0, questions.length - 1) : questions.length
  const handleTabPrev = useCallback(() => {
    if (currentQuestionIndex <= 0) return
    const prev = questions[currentQuestionIndex - 1]
    if (prev) navigateTo(prev.id)
  }, [currentQuestionIndex, questions])
  const handleTabNext = useCallback(() => {
    if (currentQuestionIndex >= maxIndex) return
    const next = questions[currentQuestionIndex + 1]
    navigateTo(next ? next.id : 'review')
  }, [currentQuestionIndex, maxIndex, questions])

  useKeybindings(
    { 'tabs:previous': handleTabPrev, 'tabs:next': handleTabNext },
    { context: 'Tabs', isActive: !(isInTextInput && !isInSubmitView) },
  )

  const onImagePaste = useCallback(
    (
      questionText: string,
      base64Image: string,
      mediaType?: string,
      filename?: string,
      dimensions?: ImageDimensions,
      _sourcePath?: string,
    ) => {
      const q = byText(questionText)
      nextPasteIdRef.current += 1
      const pasteId = nextPasteIdRef.current
      const newContent: PastedContent = {
        id: pasteId,
        type: 'image',
        content: base64Image,
        mediaType: mediaType || 'image/png',
        filename: filename || 'Pasted image',
        dimensions,
      }
      cacheImagePath(newContent)
      void storeImage(newContent)
      attachContext(
        { refId: `image:${pasteId}`, kind: 'image', label: newContent.filename ?? 'Pasted image' },
        q?.id,
      )
    },
    [byText],
  )
  const onRemoveImage = useCallback((_questionText: string, id: number) => {
    detachContext(`image:${id}`)
  }, [])

  const handleNotesPasteLarge = useCallback(
    (questionText: string, text: string) => {
      const q = byText(questionText)
      if (!q) return
      const lines = getPastedTextRefNumLines(text)
      const hash = hashPastedText(text)
      void storePastedText(hash, text)
      attachContext(
        { refId: `paste:${hash}`, kind: 'large-paste', label: `Pasted text · ${lines} lines` },
        q.id,
      )
      const prior = session.questions[q.id]?.note ?? ''
      setNote(q.id, `${prior}${prior && !prior.endsWith(' ') ? ' ' : ''}[Pasted context: ${lines} lines]`)
    },
    [byText, session],
  )

  const chipContents: Record<number, PastedContent> = {}
  if (currentQuestion) {
    for (const ref of session.context) {
      if (ref.kind !== 'image') continue
      const scope = session.contextScope[ref.refId]
      if (scope !== undefined && scope !== currentQuestion.id) continue
      const id = imageRefNumericId(ref.refId)
      if (id === null) continue
      chipContents[id] = { id, type: 'image', content: '', mediaType: 'image/png', filename: ref.label }
    }
  }

  const handleTextInputFocus = useCallback((isIn: boolean) => setIsInTextInput(isIn), [])

  useEffect(() => {
    void session.phase
  }, [session.phase])

  if (currentQuestion) {
    const legacyQuestion = toLegacyQuestion(currentQuestion)
    const legacyQuestions = questions.map(toLegacyQuestion)
    return (
      <QuestionView
        key={currentQuestion.id}
        question={legacyQuestion}
        questions={legacyQuestions}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        questionStates={questionStates}
        hideSubmitTab={hideSubmitTab}
        minContentHeight={globalContentHeight}
        minContentWidth={globalContentWidth}
        planFilePath={planFilePath}
        onUpdateQuestionState={handleUpdateQuestionState}
        onAnswer={handleQuestionAnswer}
        onTextInputFocus={handleTextInputFocus}
        onCancel={handleCancel}
        onSubmit={handleTabNext}
        onTabPrev={handleTabPrev}
        onTabNext={handleTabNext}
        onRespondToClaude={() => void handleRespondToClaude().catch(logError)}
        onFinishPlanInterview={() => void handleFinishPlanInterview().catch(logError)}
        onImagePaste={(base64, mediaType, filename, dims, path) =>
          onImagePaste(currentQuestion.text, base64, mediaType, filename, dims, path)
        }
        pastedContents={chipContents}
        onRemoveImage={id => onRemoveImage(currentQuestion.text, id)}
        onNotesPasteLarge={handleNotesPasteLarge}
      />
    )
  }
  if (isInSubmitView) {
    const noteByText: Record<string, string> = {}
    for (const q of questions) {
      const note = session.questions[q.id]?.note
      if (note?.trim()) noteByText[q.text] = note.trim()
    }
    return (
      <SubmitQuestionsView
        questions={questions.map(toLegacyQuestion)}
        currentQuestionIndex={currentQuestionIndex}
        answers={answers}
        notes={noteByText}
        allQuestionsAnswered={allQuestionsAnswered}
        permissionResult={toolUseConfirm.permissionResult}
        minContentHeight={globalContentHeight}
        onEditQuestion={handleEditQuestion}
        initialFocusValue={reviewFocusValue}
        onFinalResponse={handleFinalResponse}
      />
    )
  }
  return null
}

function toLegacyQuestion(q: InterviewQuestion) {
  return {
    question: q.text,
    header: q.header,
    multiSelect: q.multiSelect,
    options: q.options.map(o => ({
      label: o.label,
      description: o.description,
      ...(o.preview ? { preview: o.preview } : {}),
    })),
  }
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
