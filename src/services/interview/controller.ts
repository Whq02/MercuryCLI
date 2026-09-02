
import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import { readFile } from 'node:fs/promises'
import type { Question } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { getStoredImagePath } from '../../utils/imageStore.js'
import { maybeResizeAndDownsampleImageBlock } from '../../utils/imageResizer.js'
import { logError } from '../../utils/log.js'
import { retrievePastedText } from '../../utils/pasteStore.js'
import { buildDecisionRecord, persistDecisionRecord } from './decisionRecord.js'
import {
  adoptDurableSessionSync,
  appendInterviewEvent,
  interviewEvents,
  interviewSnapshot,
  mintInterviewId,
  openInterviewSession,
} from './store.js'
import type {
  InterviewAnswerValue,
  InterviewContextRef,
  InterviewOption,
  InterviewQuestion,
  InterviewQuestionId,
  InterviewSessionState,
} from './contracts.js'

export interface InterviewBoundary {
  onAllow: (updatedInput: Record<string, unknown>) => void
  onReject: () => void
}

export function encodeAnswerValue(value: InterviewAnswerValue, question: InterviewQuestion): string {
  const labels = value.optionIds
    .map(id => question.options.find(o => o.id === id)?.label)
    .filter((l): l is string => typeof l === 'string')
  const parts = question.multiSelect ? labels.map(l => JSON.stringify(l)) : labels
  const selected = question.multiSelect ? parts.join(', ') : (parts[0] ?? '')
  if (value.freeText?.trim()) {
    return selected ? `${selected} · ${value.freeText.trim()}` : value.freeText.trim()
  }
  return selected
}

export function adoptQuestions(questions: Question[]): InterviewQuestion[] {
  return questions.map(q => {
    const declared = q as Question & { id?: string; decisionId?: string }
    const id = declared.id ?? mintInterviewId('iq')
    return {
      id,
      decisionId: declared.decisionId ?? `id_${id.slice(3)}`,
      text: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o): InterviewOption => {
        const opt = o as typeof o & { id?: string }
        return {
          id: opt.id ?? mintInterviewId('io'),
          label: o.label,
          description: o.description,
          ...(o.preview ? { preview: o.preview } : {}),
        }
      }),
    }
  })
}

export function presentToolCall(init: {
  input: { questions: Question[] }
  toolUseId?: string
  mission?: string
}): { sessionId: string; questions: InterviewQuestion[] } {
  let live = interviewSnapshot()
  const isOpen = (s: InterviewSessionState): boolean =>
    s.sessionId !== null &&
    (s.phase === 'asking' || s.phase === 'discussing' || s.phase === 'reviewing')
  if (!isOpen(live)) {
    const declaredIds = init.input.questions.flatMap(q => {
      const d = q as Question & { id?: string; decisionId?: string }
      return [d.id, d.decisionId].filter((x): x is string => typeof x === 'string')
    })
    if (adoptDurableSessionSync({ toolUseId: init.toolUseId, declaredIds })) {
      live = interviewSnapshot()
    }
  }
  const joinable = isOpen(live)
  const sessionId = joinable
    ? live.sessionId!
    : openInterviewSession({
        mission: init.mission ?? init.input.questions[0]?.question ?? 'interview',
        toolUseId: init.toolUseId,
      })
  if (joinable && live.phase === 'discussing' && live.discussing) {
    appendInterviewEvent({
      kind: 'discussion-returned',
      eventId: mintInterviewId('ie'),
      atMs: Date.now(),
      questionId: live.discussing,
    })
  }
  const sameCall =
    joinable && init.toolUseId !== undefined && live.toolUseId === init.toolUseId
  const questions = sameCall
    ? live.questionOrder
        .map(qid => live.questions[qid]?.question)
        .filter((q): q is InterviewQuestion => !!q)
    : adoptQuestions(init.input.questions)
  appendInterviewEvent({
    kind: 'questions-presented',
    eventId: mintInterviewId('ie'),
    atMs: Date.now(),
    round: interviewSnapshot().round + 1,
    questions,
  })
  return { sessionId, questions }
}


export function draftAnswer(questionId: InterviewQuestionId, value: InterviewAnswerValue): void {
  appendInterviewEvent({ kind: 'answer-drafted', eventId: mintInterviewId('ie'), atMs: Date.now(), questionId, value })
}

export function commitAnswer(questionId: InterviewQuestionId, value: InterviewAnswerValue): void {
  appendInterviewEvent({ kind: 'answer-committed', eventId: mintInterviewId('ie'), atMs: Date.now(), questionId, value })
}

export function setNote(questionId: InterviewQuestionId, note: string): void {
  appendInterviewEvent({ kind: 'note-set', eventId: mintInterviewId('ie'), atMs: Date.now(), questionId, note })
}

export function navigateTo(target: InterviewQuestionId | 'review'): void {
  appendInterviewEvent({ kind: 'navigated', eventId: mintInterviewId('ie'), atMs: Date.now(), target })
}

export function attachContext(ref: InterviewContextRef, questionId?: InterviewQuestionId): void {
  appendInterviewEvent({
    kind: 'context-attached',
    eventId: mintInterviewId('ie'),
    atMs: Date.now(),
    ref,
    ...(questionId ? { questionId } : {}),
  })
}

export function detachContext(refId: string): void {
  appendInterviewEvent({ kind: 'context-detached', eventId: mintInterviewId('ie'), atMs: Date.now(), refId })
}


const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function imageRefNumericId(refId: string): number | null {
  const m = /^image:(\d+)$/.exec(refId)
  return m ? Number(m[1]) : null
}

export async function buildContextBlocks(
  state: InterviewSessionState,
): Promise<ContentBlockParam[] | undefined> {
  const blocks: ContentBlockParam[] = []
  for (const ref of state.context) {
    const scopeQid = state.contextScope[ref.refId]
    const scope = scopeQid ? (state.questions[scopeQid]?.question.decisionId ?? scopeQid) : 'interview'
    if (ref.kind === 'image') {
      const id = imageRefNumericId(ref.refId)
      const path = id === null ? null : getStoredImagePath(id)
      if (!path) {
        logError(`interview context image body missing: ${ref.refId}`)
        continue
      }
      try {
        const data = (await readFile(path)).toString('base64')
        const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
        const block: ImageBlockParam = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (IMAGE_MEDIA_BY_EXT[ext] ?? 'image/png') as Base64ImageSource['media_type'],
            data,
          },
        }
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        blocks.push(resized.block)
      } catch (e) {
        logError(`interview context image read failed (${ref.refId}): ${e}`)
      }
    } else if (ref.kind === 'large-paste') {
      const hash = ref.refId.startsWith('paste:') ? ref.refId.slice('paste:'.length) : ref.refId
      const body = await retrievePastedText(hash)
      if (body === null) {
        logError(`interview context paste body missing: ${ref.refId}`)
        continue
      }
      blocks.push({
        type: 'text',
        text: `<interview-context ref="${ref.refId}" decision="${scope}">\n${body}\n</interview-context>`,
      })
    }
  }
  return blocks.length > 0 ? blocks : undefined
}


export function buildUpdatedInput(
  state: InterviewSessionState,
  originalInput: Record<string, unknown>,
  outcome: NonNullable<Record<string, unknown>> & { kind: string },
): Record<string, unknown> {
  const answers: Record<string, string> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}
  for (const qid of state.questionOrder) {
    const qs = state.questions[qid]
    if (!qs) continue
    const value = qs.committed ?? qs.draft
    if (value) answers[qid] = encodeAnswerValue(value, qs.question)
    const selectedPreview =
      value && !qs.question.multiSelect
        ? qs.question.options.find(o => o.id === value.optionIds[0])?.preview
        : undefined
    if (qs.note?.trim() || selectedPreview) {
      annotations[qid] = {
        ...(selectedPreview ? { preview: selectedPreview } : {}),
        ...(qs.note?.trim() ? { notes: qs.note.trim() } : {}),
      }
    }
  }
  return {
    ...originalInput,
    questions: state.questionOrder
      .map(qid => state.questions[qid]?.question)
      .filter(Boolean)
      .map(q => ({
        id: q!.id,
        decisionId: q!.decisionId,
        question: q!.text,
        header: q!.header,
        options: q!.options.map(o => ({
          id: o.id,
          label: o.label,
          description: o.description,
          ...(o.preview ? { preview: o.preview } : {}),
        })),
        multiSelect: q!.multiSelect,
      })),
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    outcome,
  }
}

export function submitInterview(boundary: InterviewBoundary, originalInput: Record<string, unknown>): void {
  const recordId = mintInterviewId('ir')
  appendInterviewEvent({ kind: 'submitted', eventId: mintInterviewId('ie'), atMs: Date.now(), decisionRecordId: recordId })
  const state = interviewSnapshot()
  persistDecisionRecord(buildDecisionRecord(state, interviewEvents(), recordId, Date.now()))
  boundary.onAllow(buildUpdatedInput(state, originalInput, { kind: 'answers-submitted', decisionRecordId: recordId }))
}

export function requestDiscussion(
  boundary: InterviewBoundary,
  originalInput: Record<string, unknown>,
  questionId: InterviewQuestionId,
): void {
  appendInterviewEvent({ kind: 'discussion-opened', eventId: mintInterviewId('ie'), atMs: Date.now(), questionId })
  boundary.onAllow(buildUpdatedInput(interviewSnapshot(), originalInput, { kind: 'discussion-requested', questionId }))
}

export function requestFinish(boundary: InterviewBoundary, originalInput: Record<string, unknown>): void {
  const state = interviewSnapshot()
  const retained = state.questionOrder
    .filter(qid => state.questions[qid]?.committed)
    .map(qid => state.questions[qid]!.question.decisionId)
  appendInterviewEvent({
    kind: 'finish-requested',
    eventId: mintInterviewId('ie'),
    atMs: Date.now(),
    retainedDecisionIds: retained,
  })
  boundary.onAllow(
    buildUpdatedInput(interviewSnapshot(), originalInput, { kind: 'finish-requested', retainedDecisionIds: retained }),
  )
}

export function cancelInterview(boundary: InterviewBoundary, opts?: { preserveDraft?: boolean }): void {
  appendInterviewEvent({
    kind: 'cancelled',
    eventId: mintInterviewId('ie'),
    atMs: Date.now(),
    preserveDraft: opts?.preserveDraft ?? true,
  })
  boundary.onReject()
}
