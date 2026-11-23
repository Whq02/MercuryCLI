import React from 'react'
import { logError } from '../../../utils/log.js'
import {
  commitAnswer,
  draftAnswer,
  navigateTo,
} from '../../../services/interview/controller.js'
import { interviewSnapshot } from '../../../services/interview/store.js'
import type { InterviewQuestion } from '../../../services/interview/contracts.js'
import type { PastedContent } from '../../../utils/config.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { composeAnswer, type QuestionState } from './questionState.js'
import { QuestionView } from './QuestionView.js'
import { SubmitQuestionsView } from './SubmitQuestionsView.js'

type QuestionViewProps = React.ComponentProps<typeof QuestionView>
type LegacyQuestionOf = (q: InterviewQuestion) => QuestionViewProps['question']

type QuestionAnswerArgs = {
  byText: (questionText: string) => InterviewQuestion | undefined
  session: ReturnType<typeof interviewSnapshot>
  questions: InterviewQuestion[]
  handleSubmit: () => Promise<void>
  editReturnRef: { current: string | null }
  setReviewFocusValue: React.Dispatch<React.SetStateAction<string | undefined>>
}

export function handleQuestionAnswerOf({ byText, session, questions, handleSubmit, editReturnRef, setReviewFocusValue }: QuestionAnswerArgs, questionText: string, label: string | string[], textInput: string | undefined, shouldAdvance: boolean): void {
  const q = byText(questionText)
  if (!q) return
  const isMulti = Array.isArray(label)
  const labels = isMulti ? label : [label]
  const live = interviewSnapshot().questions[q.id]
  const typed = textInput ?? live?.draft?.freeText ?? live?.committed?.freeText ?? ''
  const hasImage = session.context.some(
    c =>
      c.kind === 'image' &&
      (session.contextScope[c.refId] === undefined || session.contextScope[c.refId] === q.id),
  )
  const { commit, keptDraft } = composeAnswer({ question: q, labels, typed, hasImage })
  commitAnswer(q.id, commit)
  if (keptDraft) draftAnswer(q.id, keptDraft)
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
}

type CurrentQuestionArgs = {
  currentQuestion: InterviewQuestion
  toLegacyQuestion: LegacyQuestionOf
  questions: InterviewQuestion[]
  currentQuestionIndex: number
  answers: Record<string, string>
  questionStates: Record<string, QuestionState>
  hideSubmitTab: boolean
  globalContentHeight: number
  globalContentWidth: number
  handleUpdateQuestionState: QuestionViewProps['onUpdateQuestionState']
  handleQuestionAnswer: QuestionViewProps['onAnswer']
  handleTextInputFocus: (isIn: boolean) => void
  handleCancel: () => void
  handleTabNext: () => void
  handleTabPrev: () => void
  handleRespondToModel: () => Promise<void>
  onImagePaste: (
    questionText: string,
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    _sourcePath?: string,
  ) => void
  chipContents: Record<number, PastedContent>
  onRemoveImage: (_questionText: string, id: number) => void
  handleNotesPasteLarge: (questionText: string, text: string) => void
}

export function currentQuestionView({ currentQuestion, toLegacyQuestion, questions, currentQuestionIndex, answers, questionStates, hideSubmitTab, globalContentHeight, globalContentWidth, handleUpdateQuestionState, handleQuestionAnswer, handleTextInputFocus, handleCancel, handleTabNext, handleTabPrev, handleRespondToModel, onImagePaste, chipContents, onRemoveImage, handleNotesPasteLarge }: CurrentQuestionArgs): React.ReactNode {
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
      onUpdateQuestionState={handleUpdateQuestionState}
      onAnswer={handleQuestionAnswer}
      onTextInputFocus={handleTextInputFocus}
      onCancel={handleCancel}
      onSubmit={handleTabNext}
      onTabPrev={handleTabPrev}
      onTabNext={handleTabNext}
      onRespondToModel={() => void handleRespondToModel().catch(logError)}
      onImagePaste={(base64, mediaType, filename, dims, path) =>
        onImagePaste(currentQuestion.text, base64, mediaType, filename, dims, path)
      }
      pastedContents={chipContents}
      onRemoveImage={id => onRemoveImage(currentQuestion.text, id)}
      onNotesPasteLarge={handleNotesPasteLarge}
    />
  )
}

type SubmitViewArgs = {
  questions: InterviewQuestion[]
  session: ReturnType<typeof interviewSnapshot>
  toLegacyQuestion: LegacyQuestionOf
  currentQuestionIndex: number
  answers: Record<string, string>
  allQuestionsAnswered: boolean
  toolUseConfirm: PermissionRequestProps['toolUseConfirm']
  globalContentHeight: number
  handleEditQuestion: (questionText: string) => void
  reviewFocusValue: string | undefined
  handleFinalResponse: (value: 'submit' | 'cancel') => void
}

export function submitQuestionsViewOf({ questions, session, toLegacyQuestion, currentQuestionIndex, answers, allQuestionsAnswered, toolUseConfirm, globalContentHeight, handleEditQuestion, reviewFocusValue, handleFinalResponse }: SubmitViewArgs): React.ReactNode {
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
