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
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

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

export function AskUserQuestionPermissionRequest(props: PermissionRequestProps): Unbuilt {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:60')
}

function AskUserQuestionWithHighlight(props: PermissionRequestProps) {
  const highlight = use(getCliHighlightPromise()) as CliHighlight | null
  return <AskUserQuestionPermissionRequestBody {...props} highlight={highlight} />
}

const presented = new WeakSet<object>()

function AskUserQuestionPermissionRequestBody(
  props: PermissionRequestProps & { highlight: CliHighlight | null },
): Unbuilt {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:79')
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

