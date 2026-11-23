import type { ToolUseContext } from '../../kit/tool.js'
import { applyHunks, formatHunkOutcomes, planApplyRegions, planHunks, spanText, type EditHunkInput } from '../../engines/change-transaction/hunks.js'
import { fileGeneration } from '../../engines/change-transaction/seenLines.js'
import {
  recordNoChangeOutcome,
} from '../../engines/change-transaction/repetitionPolicy.js'
import {
  anchorDomainLines,
  formatFreshAnchorBlocks,
  lineAnchorsEnabled,
  parseHashedLinesSpelling,
} from '../../engines/change-transaction/lineAnchors.js'
import { mintFileAnchor } from '../../engines/change-transaction/snapshotAnchor.js'
import { serializeIntentDigest } from '../../engines/change-transaction/repetitionPolicy.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { remoteMovedSinceRead } from '../../../platform/remote-file-target/target.js'
import { getCheckedFileModificationTime } from '../../../platform/files/file.js'
import { plural } from '../../../platform/text/strings.js'
import { modifiedSinceReadMessage } from '../otherSession.js'
import type { FileEditInput } from '../schema.js'
import { applyEditToFile, findActualString } from './editMatching.js'
import { findSection, planAppend, planSectionEdit, sectionHeadingOf } from '../sectionEdit.js'
import { getPatchFromContents } from '../../../platform/text/diff.js'
import { convertLeadingTabsToSpaces } from '../../../platform/files/file.js'
import { HUNK_SPAN_ELISION, type Output, type EditMode, isFullReadEntry, sha16, hasText, splitLeadingBom } from './fileFacts.js'
import { linesOfMatches, readCoversRanges, recordCarry, type ReadKnowledge, clippedReadRefusal, readKnowledge } from './readKnowledge.js'
import { linesOfHunks } from './exactMatch.js'
import type { EditedLinesResult } from '../editResult.js'

type RemoteBridge = typeof import('../../../platform/remote-files/bridge.js')

export function sameCallKnowledge(context: ToolUseContext, input: FileEditInput, mode: EditMode, expandedPath: string, freshContent: string, far: RemoteBridge | null, currentMtimeMs: number | undefined) {
  let sameCall: Extract<ReadKnowledge, { verdict: 'carry' }> | null = null
  const touched = mode === 'exact'
    ? linesOfMatches(freshContent, input.old_string ?? '', input.replace_all === true)
    : mode === 'section'
      ? (() => {
          const found = findSection(freshContent, input.section ?? '')
          return found.ok ? [{ start: found.start, end: found.end }] : null
        })()
      : mode === 'hunks'
        ? linesOfHunks(input.hunks as EditHunkInput[] | undefined)
        : null
  const clipped = clippedReadRefusal(context, expandedPath, input.file_path, freshContent, touched, mode === 'exact' ? findActualString(freshContent, input.old_string ?? '') ?? input.old_string : undefined)
  if (clipped !== null) throw new Error(clipped)
  const entry = context.readFileState.get(expandedPath)
  const intact = entry !== undefined && readCoversRanges(entry, touched) && (
    (far !== null ? !remoteMovedSinceRead(context.readFileState, expandedPath, currentMtimeMs, entry.timestamp) : (currentMtimeMs ?? getCheckedFileModificationTime(expandedPath)) <= entry.timestamp) ||
    (isFullReadEntry(entry) && entry.content === freshContent)
  )
  if (!intact) {
    const knowledge = readKnowledge(context, expandedPath, input.file_path, freshContent, input.expected_anchor, touched, 'content', undefined, { generation: fileGeneration(expandedPath) })
    if (knowledge.verdict === 'refused') throw new Error(modifiedSinceReadMessage())
    if (knowledge.verdict === 'carry') {
      recordCarry(ownerFromToolUseContext(context), expandedPath, knowledge.carry.generation, knowledge.carry.windows)
      sameCall = knowledge
    }
  }
  return sameCall
}

export function hunksEdit(freshContent: string, effectiveHunks: EditHunkInput[] | undefined, effectiveAnchor: string | undefined, expandedPath: string) {
  let updatedFile: string
  let patch: ReturnType<typeof getPatchFromContents>
  let reportedOldString: string
  let reportedNewString: string
  let freshLineAnchors: string | undefined
  let what: string
  const { bom, body } = splitLeadingBom(freshContent)
  const plan = planHunks(body, effectiveHunks as EditHunkInput[], effectiveAnchor)
  if (!plan.ok) {
    throw new Error(`${plan.message} Nothing was written.${plan.outcomes.length > 1 ? ` Outcomes: ${formatHunkOutcomes(plan.outcomes)}.` : ''}`)
  }
  updatedFile = bom + applyHunks(body, plan)
  if (
    lineAnchorsEnabled() &&
    (effectiveHunks as EditHunkInput[]).some(h => parseHashedLinesSpelling(h.lines) !== null)
  ) {
    const block = formatFreshAnchorBlocks(anchorDomainLines(updatedFile), planApplyRegions(plan))
    if (block !== '') freshLineAnchors = block
  }
  reportedOldString = plan.spans
    .map(span => spanText(body, span))
    .join(HUNK_SPAN_ELISION)
  reportedNewString = (effectiveHunks as EditHunkInput[])
    .map(hunk => hunk.replace)
    .join(HUNK_SPAN_ELISION)
  patch =
    updatedFile === freshContent
      ? []
      : getPatchFromContents({
          filePath: expandedPath,
          oldContent: convertLeadingTabsToSpaces(freshContent),
          newContent: convertLeadingTabsToSpaces(updatedFile),
        })
  const hunkTotal = (effectiveHunks as EditHunkInput[]).length
  what = `${hunkTotal} ${plural(hunkTotal, 'hunk')} applied`
  return { updatedFile, patch, reportedOldString, reportedNewString, freshLineAnchors, what }
}

export function appendSectionEdit(freshContent: string, input: FileEditInput, mode: EditMode, expandedPath: string) {
  let updatedFile: string
  let patch: ReturnType<typeof getPatchFromContents>
  let reportedOldString: string
  let reportedNewString: string
  let what: string
  const planned =
    mode === 'append'
      ? { ok: true as const, updated: planAppend(freshContent, input.append ?? ''), sectionText: '' }
      : planSectionEdit(
          freshContent,
          input.section ?? '',
          hasText(input.append) ? { append: input.append } : { replace: input.new_string ?? '' },
        )
  if (!planned.ok) {
    throw new Error(`${planned.message} Nothing was written.`)
  }
  updatedFile = planned.updated
  reportedOldString = planned.sectionText
  reportedNewString = hasText(input.append) ? input.append : input.new_string ?? ''
  patch =
    updatedFile === freshContent
      ? []
      : getPatchFromContents({
          filePath: expandedPath,
          oldContent: convertLeadingTabsToSpaces(freshContent),
          newContent: convertLeadingTabsToSpaces(updatedFile),
        })
  what =
    mode === 'append'
      ? 'appended at the end'
      : hasText(input.append)
        ? `appended inside section "${sectionHeadingOf(input.section ?? '')}"`
        : `section "${sectionHeadingOf(input.section ?? '')}" replaced`
  return { updatedFile, patch, reportedOldString, reportedNewString, what }
}

export function carriageReturnEdit(rawBefore: string, freshContent: string, input: FileEditInput, expandedPath: string) {
  let rawUpdated: string
  let updatedFile: string
  let patch: ReturnType<typeof getPatchFromContents>
  let reportedOldString: string
  let reportedNewString: string
  let occurrences: number
  let what: string
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''
  rawUpdated = applyEditToFile(rawBefore, oldString, newString, input.replace_all)
  updatedFile = rawUpdated.replaceAll('\r\n', '\n')
  patch = getPatchFromContents({ filePath: expandedPath, oldContent: freshContent, newContent: updatedFile })
  reportedOldString = oldString
  reportedNewString = newString
  occurrences = input.replace_all ? rawBefore.split(oldString).length - 1 : 1
  what = `line endings changed at ${occurrences} ${occurrences === 1 ? 'place' : 'places'} (the bytes differ only in carriage returns)`
  return { rawUpdated, updatedFile, patch, reportedOldString, reportedNewString, occurrences, what }
}

type NoChangeFacts = {
  context: ToolUseContext
  input: FileEditInput
  usingHunks: boolean
  mode: EditMode
  reportedOldString: string
  reportedNewString: string
  replaceAll: boolean
  expandedPath: string
  freshContent: string
  userModified: boolean
  readThrough: string | undefined
  startedAt: number
  anchorChecked: boolean
}

export function noChangeAnswer({ context, input, usingHunks, mode, reportedOldString, reportedNewString, replaceAll, expandedPath, freshContent, userModified, readThrough, startedAt, anchorChecked }: NoChangeFacts) {
  const owner = ownerFromToolUseContext(context)
  const intentDigest = serializeIntentDigest(
    usingHunks
      ? [
          input.expected_anchor ?? '',
          ...(input.hunks as EditHunkInput[]).flatMap(hunk => [
            hunk.lines,
            hunk.replace,
            hunk.insert ?? '',
          ]),
        ]
      : mode === 'exact'
        ? [reportedOldString, reportedNewString, replaceAll]
        : [mode, input.section ?? '', input.append ?? '', input.new_string ?? ''],
  )
  const verdict = recordNoChangeOutcome(owner, {
    operation: 'file.edit',
    path: expandedPath,
    revision: mintFileAnchor(freshContent),
    intentDigest,
    displayPath: input.file_path,
  })
  const data: Output = {
    filePath: expandedPath,
    oldString: reportedOldString,
    newString: reportedNewString,
    originalFile: freshContent,
    structuredPatch: [],
    userModified,
    replaceAll,
    noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
    ...(readThrough !== undefined ? { readThrough } : {}),
  }
  return {
    data,
    effect: {
      outcome: 'no-change' as const,
      operation: 'file.edit',
      changedPaths: [],
      evidence: usingHunks
        ? 'hunks lane: the planned result is byte-identical to the current content'
        : `${mode === 'exact' ? 'exact-string' : mode} mode: the computed result is byte-identical to the current content`,
      startedAt,
      completedAt: Date.now(),
      details: { anchorChecked },
    },
  }
}

type EditedFacts = {
  expandedPath: string
  reportedOldString: string
  reportedNewString: string
  freshContent: string
  patch: ReturnType<typeof getPatchFromContents>
  userModified: boolean
  replaceAll: boolean
  freshLineAnchors: string | undefined
  staleRecoveryNote: string | undefined
  readThrough: string | undefined
  parseError: string | undefined
  editedLines: EditedLinesResult['editedLines']
  usingHunks: boolean
  hunkCount: number
  added: number
  removed: number
  mode: EditMode
  startedAt: number
  updatedFile: string
  anchorChecked: boolean
}

export function editedAnswer({ expandedPath, reportedOldString, reportedNewString, freshContent, patch, userModified, replaceAll, freshLineAnchors, staleRecoveryNote, readThrough, parseError, editedLines, usingHunks, hunkCount, added, removed, mode, startedAt, updatedFile, anchorChecked }: EditedFacts) {
  const data: Output = {
    filePath: expandedPath,
    oldString: reportedOldString,
    newString: reportedNewString,
    originalFile: freshContent,
    structuredPatch: patch,
    userModified,
    replaceAll,
    ...(freshLineAnchors !== undefined ? { freshLineAnchors } : {}),
    ...(staleRecoveryNote !== undefined ? { staleRecovery: staleRecoveryNote } : {}),
    ...(readThrough !== undefined ? { readThrough } : {}),
    ...(parseError !== undefined ? { parseError } : {}),
    editedLines,
  }
  return {
    data,
    effect: {
      outcome: 'succeeded' as const,
      operation: 'file.edit',
      changedPaths: [expandedPath],
      evidence: usingHunks
        ? `applied ${hunkCount} anchored hunk(s): +${added}/-${removed} lines${staleRecoveryNote !== undefined ? ` · ${staleRecoveryNote}` : ''}`
        : `${mode === 'exact' ? 'exact-string' : mode} mode: +${added}/-${removed} lines`,
      startedAt,
      completedAt: Date.now(),
      details: {
        digest: sha16(updatedFile),
        bytes: Buffer.byteLength(updatedFile, 'utf8'),
        anchorChecked,
      },
    },
  }
}
