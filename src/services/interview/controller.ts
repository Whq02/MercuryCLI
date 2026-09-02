/**
 * The interview controller — the UI-free bridge between the AskUserQuestion
 * tool boundary and the ONE interview-session authority (store.ts).
 *
 * RESPONSIBILITIES:
 *   - IDENTITY ADOPTION: a tool input's declared ids (question.id /
 *     decisionId / option.id — the A3 contract) are adopted verbatim; absent
 *     ids are minted ONCE here at presentation. Display text is never
 *     identity.
 *   - ROUND CONTINUITY: a new tool call while the live session is still open
 *     joins it as the next presentation round (re-asked ids upsert in
 *     place); a completed/cancelled live session yields a fresh one.
 *   - THE BOUNDARY ADAPTER (A3): typed outcomes leave through the inherited
 *     toolUseConfirm surface without contaminating it — submit / discuss /
 *     finish ride onAllow with an id-keyed `updatedInput` carrying the
 *     typed `outcome`; cancel stays the bare reject the shared plumbing has
 *     always meant by it. The 26 other toolUseConfirm consumers never see a
 *     new vocabulary.
 *
 * The UI layers (the Wave B components) subscribe to the store and call the
 * actions here; nothing below this file imports React.
 */

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

/** The boundary the inherited permission plumbing hands us. */
export interface InterviewBoundary {
  /** Allow with the (possibly updated) tool input — the submit/discuss/finish route. */
  onAllow: (updatedInput: Record<string, unknown>) => void
  /** The historical bare rejection — the cancel route. */
  onReject: () => void
}

/** The A3 wire convention for multi-select answer strings: JSON-quoted labels
 *  joined with ', ' — distinct selections can never collide. */
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

/** Adopt-or-mint identity over a tool-input question list. Minted ids are
 *  deterministic within a call only in ORDER (iq_/io_ prefixes, random body)
 *  — identity STABILITY across rounds comes from the model declaring ids
 *  (the A2 doctrine + A3 schema), never from text matching. */
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

/** Open (or join) the live session for one tool call. Returns the presented
 *  questions with their adopted identity. */
export function presentToolCall(init: {
  input: { questions: Question[] }
  toolUseId?: string
  mission?: string
}): { sessionId: string; questions: InterviewQuestion[] } {
  let live = interviewSnapshot()
  const isOpen = (s: InterviewSessionState): boolean =>
    s.sessionId !== null &&
    (s.phase === 'asking' || s.phase === 'discussing' || s.phase === 'reviewing')
  // C3: with no live session, a pending tool_use re-presented after a
  // restart (same toolUseId) — or a declared-id continuation — ADOPTS its
  // durable session instead of minting a fresh one. Identity, never text.
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
  // A presentation arriving mid-discussion IS the return (C1): the operator
  // talked it through with the model and the model came back — fold the
  // typed return first so focus lands on the discussed question with its
  // draft, notes, and context intact. A discussion never silently answers;
  // any proposal arrives as a fresh draft through the ordinary actions.
  if (joinable && live.phase === 'discussing' && live.discussing) {
    appendInterviewEvent({
      kind: 'discussion-returned',
      eventId: mintInterviewId('ie'),
      atMs: Date.now(),
      questionId: live.discussing,
    })
  }
  // The SAME tool call re-presented (a restart, a remount past the WeakSet,
  // a queue re-head): the declared tool_use id anchors identity, so the
  // known session questions re-present VERBATIM — re-minting from the
  // id-less input would duplicate every question under fresh ids.
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

// ── in-interview actions (each = one typed event) ───────────────────────────

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

/** Attach a context REFERENCE (bodies live in their owner stores — the
 *  imageStore / pasteStore / shelf; the session stores refs + scope only,
 *  law B4). Absent questionId ⇒ interview-wide. Re-attaching a
 *  detached refId is the undo route — same identity, same scope semantics. */
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

// ── context bodies at the boundary (read ONCE from the owner stores) ────────

const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Numeric image id from an `image:<n>` refId; null for other shapes. */
export function imageRefNumericId(refId: string): number | null {
  const m = /^image:(\d+)$/.exec(refId)
  return m ? Number(m[1]) : null
}

/**
 * Materialize the session's context REFERENCES into boundary content blocks —
 * the ONE place bodies are read (each exactly once, at submit/discuss/finish):
 * image refs from the imageStore, large-paste refs from the pasteStore, each
 * text body tagged with its refId and decision scope so the model can join it
 * to the decision record. A missing body is a logged skip, never a throw.
 */
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

// ── the boundary adapter: typed outcomes through the inherited surface ──────

/** The id-keyed updatedInput the tool contract (A3) understands. */
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
    // The presented (identity-carrying) questions replace the raw input list
    // so the result mapping joins on ids.
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
  // The decision record persists BEFORE the boundary fires: the model's next
  // turn (the planning consumer) must find it durably readable.
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
  // The historical bare rejection — the shared plumbing's own meaning of
  // cancel; the typed event above is the durable truth.
  boundary.onReject()
}
