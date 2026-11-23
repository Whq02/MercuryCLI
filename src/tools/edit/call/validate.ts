import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { ToolUseContext } from '../../kit/tool.js'
import { changeTransactionEnabled } from '../../engines/change-transaction/contracts.js'
import { applyHunks, formatHunkOutcomes, planHunks, type EditHunkInput } from '../../engines/change-transaction/hunks.js'
import { fileGeneration } from '../../engines/change-transaction/seenLines.js'
import { lineAnchorsEnabled, parseHashedLinesSpelling } from '../../engines/change-transaction/lineAnchors.js'
import { checkAnchor, formatAnchorFailure } from '../../engines/change-transaction/snapshotAnchor.js'
import { ideReadTextAvailable, readWholeTextViaIde } from '../../../integrations/acp/ideToolBridge.js'
import { isRemotePath, remoteMovedSinceRead, remoteShellPath } from '../../../platform/remote-file-target/target.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { isENOENT } from '../../../platform/errors/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../../platform/files/file.js'
import { LOSSY_DECODE_MESSAGE } from '../../../platform/files/syncFileRead.js'
import { controlCharacterPathRefusal, expandPath } from '../../../platform/files/path.js'
import { matchingRuleForInput } from '../../../permissions/rules/filesystem.js'
import { windowsPathNeedsPermission } from '../../../permissions/rules/windowsPath.js'
import { ruleSentence } from '../../../permissions/rules/ruleReason.js'
import { memoryWriteRefusal } from '../../../sessions/memory-shapes/memoryFileDetection.js'
import { validateInputForSettingsFileEdit } from '../../../platform/settings/validateSettingsEdit.js'
import { parseStructuredWriteTarget, validateStructuredEditTarget } from '../../write/structuredTargets.js'
import { modifiedSinceReadMessage } from '../otherSession.js'
import type { FileEditInput } from '../schema.js'
import { applyEditToFile, locateActualString, preserveQuoteStyleForFile } from './editMatching.js'
import { findSection, planAppend, planSectionEdit } from '../sectionEdit.js'
import { ONE_GIB, type FarHeld, type EditMode, tooLargeToEdit, decodeFileBuffer, notFoundSuggestionSentence, staleAtValidation, hasText, hunksInUse, editMode, attemptStaleHunkRecovery, splitLeadingBom } from './fileFacts.js'
import { linesOfMatches, noMatchWords, readKnowledge, readKnowledgeRefusal } from './readKnowledge.js'
import { notUniqueRefusal, IDENTICAL_EDIT_MESSAGE, notFoundMessage, withoutReadPrefixes, linesOfHunks } from './exactMatch.js'

function pathShapeVerdict(input: FileEditInput, context: ToolUseContext) {
  const pathRefusal = controlCharacterPathRefusal(input.file_path)
  if (pathRefusal !== null) {
    return { result: false as const, message: pathRefusal, errorCode: 1 }
  }
  const structuredTarget = isRemotePath(input.file_path) ? null : parseStructuredWriteTarget(input.file_path)
  if (structuredTarget !== null) {
    const permissionContext = context.getAppState().toolPermissionContext
    const editDeny = matchingRuleForInput(structuredTarget.hostPath, permissionContext, 'edit', 'deny')
    if (editDeny) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: ruleSentence(`Editing ${input.file_path}`, 'deny', editDeny),
        errorCode: 2,
      }
    }
    const memoryRefusal = memoryWriteRefusal(structuredTarget.hostPath)
    if (memoryRefusal) {
      return { result: false as const, message: memoryRefusal, errorCode: 2 }
    }
    if (windowsPathNeedsPermission(structuredTarget.hostPath)) return { result: true as const }
    return validateStructuredEditTarget(structuredTarget, input, context, notUniqueRefusal)
  }
  return null
}

function modeShapeRefusal(input: FileEditInput, usingHunks: boolean, mode: EditMode) {
  if (mode === 'append' || mode === 'section') {
    const clash =
      hasText(input.old_string) ||
      (Array.isArray(input.hunks) && input.hunks.length > 0) ||
      input.replace_all === true ||
      (mode === 'append' && hasText(input.new_string)) ||
      (mode === 'section' && hasText(input.append) && hasText(input.new_string)) ||
      (mode === 'section' && !hasText(input.append) && input.new_string === undefined)
    if (clash) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          mode === 'append'
            ? 'append stands alone (or with section): drop old_string, new_string and hunks.'
            : 'section takes exactly one of new_string (replace the section) or append (add inside it), and no old_string or hunks.',
        errorCode: 13,
      }
    }
  } else if (!usingHunks && (input.old_string === undefined || input.new_string === undefined)) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: 'old_string and new_string are required unless hunks, append or section are provided.',
      errorCode: 13,
    }
  }
  if (
    usingHunks &&
    (hasText(input.old_string) || hasText(input.new_string) || hasText(input.section) || hasText(input.append) || input.replace_all)
  ) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message:
        'hunks and old_string/new_string/replace_all are mutually exclusive — use one edit mode per call.',
      errorCode: 13,
    }
  }
  if (usingHunks && !hasText(input.expected_anchor)) {
    const everyHunkAnchorQualified =
      lineAnchorsEnabled() &&
      (input.hunks ?? []).every(h => parseHashedLinesSpelling(h.lines) !== null)
    if (!everyHunkAnchorQualified) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          'hunks require expected_anchor — the bare fa:… or ra:… value inside the "(anchor: …)" of your preceding Read of this file, without the wrapper.' +
          (lineAnchorsEnabled()
            ? ' (Or anchor-qualify every hunk\'s lines from a line_anchors read, such as "12#ab3f", in place of expected_anchor.)'
            : ''),
        errorCode: 13,
      }
    }
  }
  return null
}

function hunksPlanVerdict(input: FileEditInput, expandedPath: string, currentContent: string, recoveredHunks: EditHunkInput[] | undefined, recoveredAnchor: string | undefined) {
  const { bom, body } = splitLeadingBom(currentContent)
  const plan = planHunks(body, recoveredHunks ?? (input.hunks as EditHunkInput[]), recoveredAnchor ?? input.expected_anchor)
  if (!plan.ok) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: `${plan.message} Nothing was written.${plan.outcomes.length > 1 ? ` Outcomes: ${formatHunkOutcomes(plan.outcomes)}.` : ''}`,
      errorCode: 13,
    }
  }
  const settingsRefusal = validateInputForSettingsFileEdit(
    expandedPath,
    currentContent,
    () => bom + applyHunks(body, plan),
  )
  if (settingsRefusal !== null) {
    return { ...settingsRefusal, behavior: 'ask' as const }
  }
  return { result: true as const, meta: { plannedHunkCount: String(plan.spans.length) } }
}

function appendSectionPlanVerdict(input: FileEditInput, mode: EditMode, expandedPath: string, currentContent: string) {
  const planned =
    mode === 'append'
      ? { ok: true as const, updated: planAppend(currentContent, input.append ?? '') }
      : planSectionEdit(
          currentContent,
          input.section ?? '',
          hasText(input.append) ? { append: input.append } : { replace: input.new_string ?? '' },
        )
  if (!planned.ok) {
    return { result: false as const, behavior: 'ask' as const, message: `${planned.message} Nothing was written.`, errorCode: 8 }
  }
  const settingsRefusal = validateInputForSettingsFileEdit(expandedPath, currentContent, () => planned.updated)
  if (settingsRefusal !== null) {
    return { ...settingsRefusal, behavior: 'ask' as const }
  }
  return { result: true as const }
}

export async function validateEditInput(input: FileEditInput, context: ToolUseContext, held?: FarHeld) {
  const pathVerdict = pathShapeVerdict(input, context)
  if (pathVerdict !== null) return pathVerdict
  const usingHunks = hunksInUse(input)
  const mode = editMode(input)

  const modeRefusal = modeShapeRefusal(input, usingHunks, mode)
  if (modeRefusal !== null) return modeRefusal

  const expandedPath = held !== undefined ? held.path : expandPath(input.file_path)

  const { old_string, new_string } = input
  if (mode === 'exact' && hasText(old_string) && old_string === new_string) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: IDENTICAL_EDIT_MESSAGE,
      errorCode: 1,
    }
  }

  if (held === undefined && isRemotePath(input.file_path)) {
    const { remoteEntryRefusal, remoteValidation } = await import('../../../platform/remote-files/bridge.js')
    const entry = remoteEntryRefusal(input.file_path.trim())
    if (entry !== null) return { result: false as const, message: entry, errorCode: 1 }
    return remoteValidation(input.file_path, null, 'edit', 'Editing', context)
  }

  const permissionContext = context.getAppState().toolPermissionContext
  const editDeny = matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')
  if (editDeny) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: ruleSentence(`Editing ${input.file_path}`, 'deny', editDeny),
      errorCode: 2,
    }
  }
  const memoryRefusal = memoryWriteRefusal(expandedPath)
  if (memoryRefusal) {
    return { result: false as const, message: memoryRefusal, errorCode: 2 }
  }

  if (held === undefined && windowsPathNeedsPermission(input.file_path)) return { result: true as const }

  let generationAtStat: string | null = null
  if (held === undefined && !ideReadTextAvailable()) {
    try {
      const stats = await stat(expandedPath)
      if (stats.size > ONE_GIB) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: tooLargeToEdit(stats.size),
          errorCode: 10,
        }
      }
      generationAtStat = fileGeneration(expandedPath)
    } catch (err) {
      if (!isENOENT(err)) throw err
    }
  }

  let fileExists = true
  let currentContent = ''
  let decodeLossless = true
  if (held !== undefined) {
    fileExists = held.fileExists
    currentContent = held.content
    decodeLossless = held.lossless
    generationAtStat = fileGeneration(expandedPath)
  } else if (ideReadTextAvailable()) {
    try {
      const ideMeta = await readWholeTextViaIde(expandedPath, context.abortController.signal)
      if (ideMeta !== null) {
        currentContent = ideMeta.content
        decodeLossless = ideMeta.losslessDecode
        generationAtStat = fileGeneration(expandedPath)
      }
    } catch (err) {
      if (!isENOENT(err) && !/no such file|not found|ENOENT/i.test(err instanceof Error ? err.message : String(err))) {
        throw err
      }
      fileExists = false
    }
  } else {
    try {
      const buffer = await readFile(expandedPath)
      const decoded = decodeFileBuffer(buffer)
      currentContent = decoded.content
      decodeLossless = decoded.lossless
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }
  }
  if (fileExists && !decodeLossless) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: LOSSY_DECODE_MESSAGE,
      errorCode: 14,
    }
  }

  try {
    input = withoutReadPrefixes(input, currentContent)
  } catch (error) {
    return { result: false as const, message: error instanceof Error ? error.message : String(error), errorCode: 13 }
  }
  const oldString = input.old_string ?? ''
  const newString = input.new_string ?? ''

  if (!fileExists) {
    if (mode === 'exact' && oldString === '') {
      return { result: true as const }
    }
    if (mode === 'append') {
      return { result: true as const }
    }
    if (held !== undefined) return { result: false as const, behavior: 'ask' as const, message: await held.missing(), errorCode: 4 }
    const suggestion = await notFoundSuggestionSentence(expandedPath)
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: `There is no file at that path. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion}`,
      errorCode: 4,
      meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
    }
  }

  if (mode === 'exact' && oldString === '') {
    if (currentContent.trim() !== '') {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          'Cannot create a new file — a file already exists at this path with content in it.',
        errorCode: 3,
      }
    }
    return { result: true as const }
  }

  if (expandedPath.toLowerCase().endsWith('.ipynb')) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message:
        held !== undefined
          ? `Edit does not change a notebook on another machine, and NotebookEdit works on this machine's files; change it with a command run on ${remoteShellPath(expandedPath)?.host ?? 'that machine'}.`
          : 'Use the NotebookEdit tool to edit Jupyter notebooks.',
      errorCode: 5,
    }
  }

  const located = mode === 'exact' ? locateActualString(currentContent, oldString) : null

  const touched =
    mode === 'exact'
      ? linesOfMatches(currentContent, oldString, input.replace_all === true)
      : mode === 'section'
        ? (() => {
            const found = findSection(currentContent, input.section ?? '')
            return found.ok ? [{ start: found.start, end: found.end }] : null
          })()
        : mode === 'hunks'
          ? linesOfHunks(input.hunks as EditHunkInput[] | undefined)
          : null
  const knowledge =
    mode === 'append'
      ? null
      : readKnowledge(context, expandedPath, input.file_path, currentContent, input.expected_anchor, touched, true, {
          lines: touched,
          missing:
            mode === 'section'
              ? 'the section heading was not found in the current content'
              : mode === 'hunks'
                ? "a hunk's line address does not parse"
                : 'the old_string was not found in the current content',
          hunks: mode === 'hunks',
        }, { generation: generationAtStat, ...(mode === 'exact' ? { oldString: located?.kind === 'found' ? located.actual : oldString } : {}) })
  const refusedUnread = knowledge !== null && knowledge.verdict === 'refused' && knowledge.unread
  if (located !== null && located.kind !== 'none' && !refusedUnread) {
    const notUnique = notUniqueRefusal(currentContent, oldString, input.replace_all === true, located)
    if (notUnique !== null) return notUnique
  }
  if (knowledge !== null && knowledge.verdict === 'refused') {
    const words = located !== null && located.kind === 'none' && !knowledge.unread
      ? noMatchWords(context, expandedPath, input.file_path, currentContent, input.expected_anchor, oldString, newString)
      : ''
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: `${knowledge.message}${words}`,
      errorCode: 6,
      meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
    }
  }

  const entry = context.readFileState.get(expandedPath)
  if (
    mode !== 'append' &&
    entry !== undefined &&
    !entry.isPartialView &&
    (await staleAtValidation(entry, expandedPath, currentContent, context.abortController.signal, held === undefined ? undefined : remoteMovedSinceRead(context.readFileState, expandedPath, held.mtimeMs, entry.timestamp))) &&
    readKnowledgeRefusal(context, expandedPath, input.file_path, currentContent, input.expected_anchor, touched, false) !== null
  ) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: modifiedSinceReadMessage(),
      errorCode: 7,
    }
  }

  let recoveredHunks: EditHunkInput[] | undefined
  let recoveredAnchor: string | undefined
  if (changeTransactionEnabled() && hasText(input.expected_anchor)) {
    const check = checkAnchor(input.expected_anchor, currentContent, input.file_path)
    if (!check.ok) {
      const recovery =
        check.reason !== 'malformed' && usingHunks
          ? attemptStaleHunkRecovery(
              context,
              input.expected_anchor,
              splitLeadingBom(currentContent).body,
              input.hunks as EditHunkInput[],
              input.file_path,
            )
          : null
      if (recovery === null) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: formatAnchorFailure(check, input.expected_anchor),
          errorCode: check.reason === 'malformed' ? 12 : 11,
          meta: check.currentAnchor ? { currentAnchor: check.currentAnchor } : undefined,
        }
      }
      recoveredHunks = recovery.hunks
      recoveredAnchor = recovery.freshAnchor
    }
  }

  if (usingHunks) {
    return hunksPlanVerdict(input, expandedPath, currentContent, recoveredHunks, recoveredAnchor)
  }

  if (mode === 'append' || mode === 'section') {
    return appendSectionPlanVerdict(input, mode, expandedPath, currentContent)
  }

  const actualOldString = located !== null && located.kind === 'found' ? located.actual : null
  if (actualOldString === null) {
    return {
      result: false as const,
      behavior: 'ask' as const,
      message: notFoundMessage(currentContent, oldString, newString, { context, expandedPath, displayPath: input.file_path, expectedAnchor: input.expected_anchor }),
      errorCode: 8,
      meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
    }
  }

  const preservedNewString = await preserveQuoteStyleForFile(expandedPath, currentContent, oldString, actualOldString, newString)
  const settingsRefusal = validateInputForSettingsFileEdit(expandedPath, currentContent, () =>
    applyEditToFile(currentContent, actualOldString, preservedNewString, input.replace_all),
  )
  if (settingsRefusal !== null) {
    return { ...settingsRefusal, behavior: 'ask' as const }
  }

  return { result: true as const, meta: { actualOldString } }
}
