/**
 * The AskUserQuestion consent surface — the Mercury interview workspace's
 * request component (MERCURY INTERVIEW Wave B).
 *
 * REIMPLEMENTED at the owner (the reconstructed-source original is retired):
 * durable interview meaning lives in the ONE session authority
 * (src/services/interview/store.ts) driven through the UI-free controller —
 * this component projects the store snapshot into the child views and routes
 * every child callback to a typed session event. Context is stable REFERENCES
 * in the session (bodies live in the imageStore/pasteStore — B4); component
 * state here is transient presentation only.
 *
 * Outcomes leave through the controller's boundary adapter: submit /
 * discuss / finish ride onAllow with the id-keyed A3 shape; cancel stays the
 * plumbing's own bare rejection. The inherited prose-feedback overloads are
 * gone from this surface.
 */
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
  InterviewQuestion,
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
import { QuestionView } from './QuestionView.js'
import { SubmitQuestionsView } from './SubmitQuestionsView.js'

const MIN_CONTENT_HEIGHT = 12
const MIN_CONTENT_WIDTH = 40
// Row budget the surrounding chrome consumes — nav bar, title, footer, help text.
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

/** One presentation per toolUseConfirm object — remounts (detach/attach,
 *  StrictMode double-invoke) must not mint a duplicate round. */
const presented = new WeakSet<object>()

function AskUserQuestionPermissionRequestBody(
  props: PermissionRequestProps & { highlight: CliHighlight | null },
) {
  const { toolUseConfirm, onDone, onReject, highlight } = props

  const parsed = AskUserQuestionTool.inputSchema.safeParse(toolUseConfirm.input)
  const inputQuestions = parsed.success ? (parsed.data.questions ?? []) : []

  // ── the session authority is the state owner ──────────────────────────────
  if (!presented.has(toolUseConfirm)) {
    presented.add(toolUseConfirm)
    presentToolCall({
      input: { questions: inputQuestions },
      toolUseId: toolUseConfirm.toolUseID,
      mission: inputQuestions[0]?.question,
    })
  }
  const session = useSyncExternalStore(subscribeInterview, interviewSnapshot)

  // The snapshot is reference-stable (swaps only on a fold), so this memo —
  // and everything keyed on `questions` below — holds across focus renders.
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

  // ── transient presentation state (never durable meaning) ──────────────────
  const nextPasteIdRef = useRef(0)

  const { rows: terminalRows, columns: terminalColumns } = useTerminalSize()
  const [theme] = useTheme()
  const toolPermissionContextMode = useAppState((s: AppState) => s.toolPermissionContext.mode)
  const isInPlanMode = toolPermissionContextMode === 'strategy'
  const planFilePath = isInPlanMode ? getPlanFilePath() : undefined

  // ── layout budget — memoized on its material inputs: a focus movement or
  // paste must never re-measure every preview (D1 preview-cost law) ─────────
  // The session rail is CONDITIONAL chrome the constant cannot know (shed by
  // width/emptiness, persistent with the Concourse action): subtract the row
  // count the rail actually paints, published live by SessionTabs.
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
          // B4: measure at the CONTEXT width, not applyMarkdown's
          // process.stdout default — in the cockpit the pane is the
          // narrowed centre column, and a stdout-width measure over-sized
          // the dialog past what the pane can paint.
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

  // ── projections for the (this-slice) child views ──────────────────────────
  const currentQuestionIndex =
    session.focus === 'review'
      ? questions.length
      : Math.max(0, questions.findIndex(q => q.id === session.focus))
  const isInSubmitView = session.focus === 'review'
  const currentQuestion = isInSubmitView ? null : (questions[currentQuestionIndex] ?? null)

  const answers: Record<string, string> = {}
  const questionStates: Record<string, { selectedValue?: string | string[]; textInputValue: string }> = {}
  for (const q of questions) {
    const qs = session.questions[q.id]
    if (!qs) continue
    const value = qs.committed ?? qs.draft
    if (value && qs.committed) {
      answers[q.text] = displayAnswer(qs.committed, q)
    }
    const labels = value
      ? value.optionIds.map(id => q.options.find(o => o.id === id)?.label).filter((l): l is string => !!l)
      : []
    questionStates[q.text] = {
      selectedValue: q.multiSelect ? labels : labels[0],
      textInputValue: qs.note ?? value?.freeText ?? '',
    }
  }
  const allQuestionsAnswered = questions.every(q => !!answers[q.text])
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect
  const [isInTextInput, setIsInTextInput] = useState(false)
  // The review→edit→review round-trip: which row launched the edit,
  // and where the review cursor lands on return.
  const editReturnRef = useRef<string | null>(null)
  const [reviewFocusValue, setReviewFocusValue] = useState<string | undefined>(undefined)

  // ── the boundary (typed outcomes; contentBlocks ride the allow) ───────────
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

  // ── child-callback routing (text → id at this seam only) ──────────────────
  const handleUpdateQuestionState = useCallback(
    (
      questionText: string,
      updates: { selectedValue?: string | string[]; textInputValue?: string },
      isMultiSelect: boolean,
    ) => {
      const q = byText(questionText)
      if (!q) return
      if (updates.textInputValue !== undefined) {
        const hasPreview = !q.multiSelect && q.options.some(o => o.preview)
        if (hasPreview) {
          setNote(q.id, updates.textInputValue)
        } else {
          const prior = session.questions[q.id]?.draft ?? session.questions[q.id]?.committed
          draftAnswer(q.id, { optionIds: prior?.optionIds ?? [], freeText: updates.textInputValue })
        }
      }
      if (updates.selectedValue !== undefined) {
        const labels = Array.isArray(updates.selectedValue) ? updates.selectedValue : [updates.selectedValue]
        const optionIds = labels
          .filter(l => l !== '__other__')
          .map(l => q.options.find(o => o.label === l)?.id)
          .filter((id): id is string => !!id)
        const prior = session.questions[q.id]?.draft ?? session.questions[q.id]?.committed
        draftAnswer(q.id, { optionIds, ...(prior?.freeText ? { freeText: prior.freeText } : {}) })
      }
      void isMultiSelect
    },
    [byText, session],
  )

  const handleQuestionAnswer = useCallback(
    (questionText: string, label: string | string[], textInput?: string, shouldAdvance = true) => {
      const q = byText(questionText)
      if (!q) return
      const isMulti = Array.isArray(label)
      const labels = isMulti ? label : [label]
      const optionIds = labels
        .filter(l => l !== '__other__')
        .map(l => q.options.find(o => o.label === l)?.id)
        .filter((id): id is string => !!id)
      const hasImage = session.context.some(
        c =>
          c.kind === 'image' &&
          (session.contextScope[c.refId] === undefined || session.contextScope[c.refId] === q.id),
      )
      const freeText = textInput?.trim()
        ? hasImage
          ? `${textInput} (Image attached)`
          : textInput
        : !isMulti && label === '__other__' && hasImage
          ? '(Image attached)'
          : undefined
      commitAnswer(q.id, { optionIds, ...(freeText ? { freeText } : {}) })
      const isSingleQuestion = questions.length === 1
      if (!isMulti && isSingleQuestion && shouldAdvance) {
        handleSubmit().catch(logError)
        return
      }
      if (shouldAdvance) {
        // An edit launched from review returns TO review at the same row
        // ordinary answering advances.
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

  // ── navigation ────────────────────────────────────────────────────────────
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

  // ── context = stable references; bodies live in their owner stores (B4) ───
  // An image paste stores its body ONCE (imageStore) and attaches a typed
  // reference scoped to the pasted-on decision. Removing the chip detaches
  // the reference; re-attaching the same refId is the undo route.
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

  // A large text paste into the notes field: the body goes to the pasteStore
  // (content-addressed), the session gets the reference, the note gets a
  // short citation. The model receives the body ONCE at the boundary
  // (buildContextBlocks), tagged with the refId and decision.
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

  // The chips the child views paint — a CONTENT-FREE projection of the
  // session's image references for the focused decision (+ interview-wide).
  // ClickableImageRef resolves pixels by id from the imageStore; nothing here
  // re-reads a body to paint a chip (law VII).
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

  // A completed/cancelled session with the card still mounted paints nothing.
  useEffect(() => {
    void session.phase
  }, [session.phase])

  if (currentQuestion) {
    const legacyQuestion = toLegacyQuestion(currentQuestion)
    const legacyQuestions = questions.map(toLegacyQuestion)
    return (
      <QuestionView
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

/** The child views (this slice) still speak the tool's Question shape. */
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

/** Human-readable committed answer for the child views' answered states. */
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

