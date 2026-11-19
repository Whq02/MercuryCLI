
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { applyHunks, formatHunkOutcomes, planApplyRegions, planHunks, spanText, type EditHunkInput } from '../../services/changeTransaction/hunks.js'
import { columnCutsOf, retainColumnCuts, fileGeneration, generationOfWrittenBytes, seenLinesOf } from '../../services/changeTransaction/seenLines.js'
import {
  recordNoChangeOutcome,
} from '../../services/changeTransaction/repetitionPolicy.js'
import {
  anchorDomainLines,
  formatFreshAnchorBlocks,
  lineAnchorsEnabled,
  parseHashedLinesSpelling,
} from '../../services/changeTransaction/lineAnchors.js'
import {
  checkAnchor,
  formatAnchorFailure,
  mintFileAnchor,
} from '../../services/changeTransaction/snapshotAnchor.js'
import { serializeIntentDigest } from '../../services/changeTransaction/repetitionPolicy.js'
import { clearDeliveredDiagnosticsForFile, snapshotDiagnosticsBeforeWrite } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { ideReadTextAvailable, ideWriteTextAvailable, readRangeViaIde, readWholeTextViaIde, writeTextViaIdeWithReadBack } from '../../services/acp/ideToolBridge.js'
import { isRemotePath, markRemoteRead, remoteIdentity, remoteMovedSinceRead, remoteShellPath } from '../../services/remoteFiles/target.js'
import { getCwd } from '../../utils/cwd.js'
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE, getFileModificationTime, preserveUntouchedLineEndings, writeTextContent } from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { noteFileTouched } from '../../mneme/lineageSession.js'
import { LOSSY_DECODE_MESSAGE, readFileSyncWithMetadata, type LineEndingType } from '../../utils/fileRead.js'
import { logError } from '../../utils/log.js'
import { controlCharacterPathRefusal, expandPath, hasControlCharacter } from '../../utils/path.js'
import { plural } from '../../utils/stringUtils.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { memoryWriteRefusal } from '../../utils/memoryFileDetection.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import type { UUID } from 'node:crypto'
import type { CanUseToolFn } from '../../Tool.js'
import { checkIntroducedParseError } from '../FileWriteTool/parseCheck.js'
import {
  callStructuredEditTarget,
  expandStructuredTargetPath,
  hostPathOfWriteTarget,
  isSqliteRowTarget,
  parseStructuredWriteTarget,
  sqliteRowRewindNote,
  validateStructuredEditTarget,
} from '../FileWriteTool/structuredTargets.js'
import { FILE_EDIT_TOOL_NAME } from './constants.js'
import { modifiedSinceReadMessage } from './otherSession.js'
import { getEditToolDescription } from './prompt.js'
import { inputSchema, outputSchema, type FileEditInput } from './types.js'
import { applyEditToFile, areFileEditsInputsEquivalent, findActualString, getPatchForEdit, locateActualString, preserveQuoteStyleForFile } from './utils.js'
import { findSection, planAppend, planSectionEdit, sectionHeadingOf } from './sectionEdit.js'
import { EDIT_RESULT_CLOSE, buildEditedLines, editResultHead } from './editResult.js'
import { getPatchFromContents } from '../../utils/diff.js'
import { convertLeadingTabsToSpaces } from '../../utils/file.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import { ONE_GIB, HUNK_SPAN_ELISION, type Output, type FarHeld, tooLargeToEdit, decodeFileBuffer, notFoundSuggestionSentence, isFullReadEntry, staleAtValidation, sha16, discoverSkillsForPath, patchLineCounts, hasText, hunksInUse, editMode, attemptStaleHunkRecovery, splitLeadingBom } from './edit/fileFacts.js'
import { linesOfMatches, readCoversRanges, recordCarry, postLineAtOrAfter, knowledgeBeforeWrite, noMatchWords, writtenBytesOf, stampOwnEditAsSeen, sameCallReadThrough, type ReadKnowledge, clippedReadRefusal, readKnowledge, readKnowledgeRefusal } from './edit/readKnowledge.js'
import { notUniqueRefusal, IDENTICAL_EDIT_MESSAGE, notFoundMessage, withoutReadPrefixes, linesOfHunks } from './edit/exactMatch.js'
export { isFullReadEntry } from './edit/fileFacts.js'
export { readKnowledgeRefusal } from './edit/readKnowledge.js'
export { matchExactEdit, linesOfHunks } from './edit/exactMatch.js'

export type { Output }

export const APPLIED_NO_REREAD_NOTE =
  'The change is applied and its lines count as read (a failed call would have errored); no Read is needed before the next edit.'

function editToolItself(): unknown {
  return FileEditTool
}

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  strict: true,
  keepEmptyInputs: ['old_string', 'new_string'],
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: 100_000,
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  async description(): Promise<string> {
    return 'A tool for editing files'
  },
  async prompt({ tools, model }): Promise<string> {
    return getEditToolDescription(new Set(tools.map(tool => tool.name)), model)
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing a file'
  },
  getPath(input: Partial<FileEditInput> | undefined): string {
    if (isRemotePath(input?.file_path)) return input!.file_path!
    return input?.file_path ? hostPathOfWriteTarget(input.file_path) : getCwd()
  },
  async checkPermissions(input: FileEditInput, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_EDIT_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(
      {
        name: FILE_EDIT_TOOL_NAME,
        getPath: (i: Partial<FileEditInput> | undefined) => (i?.file_path ? hostPathOfWriteTarget(i.file_path) : getCwd()),
      },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: FileEditInput): void {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path) ? remoteIdentity(input.file_path) : expandStructuredTargetPath(input.file_path)
  },
  inputsEquivalent(a: FileEditInput, b: FileEditInput): boolean {
    const mode = editMode(a)
    if (mode !== editMode(b)) return false
    if ((hasText(a.expected_anchor) ? a.expected_anchor : undefined) !== (hasText(b.expected_anchor) ? b.expected_anchor : undefined)) return false
    if (mode === 'hunks') {
      return a.file_path === b.file_path && JSON.stringify(a.hunks) === JSON.stringify(b.hunks)
    }
    if (mode === 'append' || mode === 'section') {
      return a.file_path === b.file_path &&
        (hasText(a.section) ? a.section : undefined) === (hasText(b.section) ? b.section : undefined) &&
        (hasText(a.append) ? a.append : undefined) === (hasText(b.append) ? b.append : undefined) &&
        (hasText(a.append) ? undefined : a.new_string) === (hasText(b.append) ? undefined : b.new_string)
    }
    return areFileEditsInputsEquivalent(
      {
        file_path: a.file_path,
        edits: [
          {
            old_string: a.old_string ?? '',
            new_string: a.new_string ?? '',
            replace_all: a.replace_all ?? false,
          },
        ],
      },
      {
        file_path: b.file_path,
        edits: [
          {
            old_string: b.old_string ?? '',
            new_string: b.new_string ?? '',
            replace_all: b.replace_all ?? false,
          },
        ],
      },
    )
  },
  async validateInput(input: FileEditInput, context: ToolUseContext, held?: FarHeld) {
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
    const usingHunks = hunksInUse(input)
    const mode = editMode(input)

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
      const { remoteEntryRefusal, remoteValidation } = await import('../../services/remoteFiles/bridge.js')
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

    if (mode === 'append' || mode === 'section') {
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
  },
  async call(input: FileEditInput, context: ToolUseContext, canUseTool, parentMessage) {
    const startedAt = Date.now()
    const far = isRemotePath(input.file_path) ? await import('../../services/remoteFiles/bridge.js') : null
    const structuredTarget = far !== null ? null : parseStructuredWriteTarget(input.file_path)
    if (structuredTarget !== null) {
      if (structuredTarget.kind === 'refused') throw new Error(structuredTarget.reason)
      if (fileHistoryEnabled()) {
        if (structuredTarget.kind === 'sqlite-row') noteFileTouched(structuredTarget.hostPath)
        else await fileHistoryTrackEdit(
          context.updateFileHistoryState,
          structuredTarget.hostPath,
          parentMessage.uuid as UUID,
        )
      }
      return callStructuredEditTarget(structuredTarget, input, context, startedAt)
    }
    const farTarget =
      far === null
        ? null
        : await far.remoteWriteTarget(
            FILE_EDIT_TOOL_NAME,
            input.file_path,
            context,
            typeof canUseTool === 'function' && parentMessage !== undefined
              ? path => (canUseTool as CanUseToolFn)(editToolItself() as never, { ...input, file_path: path }, context, parentMessage as never, `${context.toolUseId ?? 'edit'}-resolved`)
              : null,
          )
    if (farTarget !== null && farTarget.kind === 'folder') throw new Error(`The path is a directory, not a file: ${input.file_path}`)
    if (farTarget !== null && farTarget.kind !== 'file' && farTarget.kind !== 'missing' && farTarget.kind !== 'dangling') {
      throw new Error(`Editing ${farTarget.path} is not allowed: it is ${farTarget.kind === 'other' ? 'a device' : farTarget.kind}, not a file.`)
    }
    if (farTarget !== null && farTarget.size > ONE_GIB) throw new Error(tooLargeToEdit(farTarget.size))
    const expandedPath = farTarget !== null ? farTarget.path : expandPath(input.file_path)
    const usingHunks = hunksInUse(input)
    const mode = editMode(input)
    const anchorChecked = changeTransactionEnabled() && hasText(input.expected_anchor)

    if (far === null && !isEnvTruthy(flagEnv('MERCURY_BARE'))) {
      await discoverSkillsForPath(context, expandedPath)
    }
    if (far === null) context.nestedMemoryAttachmentTriggers?.add(expandedPath)
    const parentDir = far !== null ? '' : dirname(expandedPath)
    if (parentDir) {
      await getFsImplementation().mkdir(parentDir)
    }
    if (far === null && fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        expandedPath,
        parentMessage.uuid as UUID,
      )
    }

    let freshContent = ''
    let rawBefore = ''
    let fileExists = true
    let encoding: BufferEncoding = 'utf8'
    let lineEndings: LineEndingType = 'LF'
    let currentMtimeMs: number | undefined
    let farFound: { sum: string; mode: string | null } | null = null
    if (far !== null) {
      let lossless = true
      try {
        const farMeta = await far.readWholeTextViaRemote(expandedPath, context.abortController.signal)
        freshContent = farMeta.content
        rawBefore = farMeta.rawContent
        encoding = farMeta.encoding
        lineEndings = farMeta.lineEndings
        currentMtimeMs = farMeta.mtimeMs
        farFound = farMeta.found
        lossless = farMeta.losslessDecode
      } catch (err) {
        if (!isENOENT(err)) throw err
        fileExists = false
      }
      const held: FarHeld = { path: expandedPath, fileExists, content: freshContent, lossless, mtimeMs: currentMtimeMs, missing: farTarget!.missing }
      const verdict = await (editToolItself() as { validateInput(input: FileEditInput, context: ToolUseContext, held: FarHeld): Promise<{ result: boolean; message?: string }> }).validateInput(input, context, held)
      if (verdict.result === false) throw new Error(verdict.message)
    } else if (ideReadTextAvailable()) {
      try {
        const ideMeta = await readWholeTextViaIde(expandedPath, context.abortController.signal)
        if (ideMeta !== null) {
          freshContent = ideMeta.content
          rawBefore = ideMeta.rawContent
          encoding = ideMeta.encoding
          lineEndings = ideMeta.lineEndings
          currentMtimeMs = ideMeta.mtimeMs
        }
      } catch (err) {
        if (!isENOENT(err) && !/no such file|not found|ENOENT/i.test(err instanceof Error ? err.message : String(err))) {
          throw err
        }
        fileExists = false
      }
    } else {
      try {
        const metadata = readFileSyncWithMetadata(expandedPath)
        if (!metadata.losslessDecode) {
          throw new Error(`${LOSSY_DECODE_MESSAGE} Nothing was written.`)
        }
        freshContent = metadata.content
        rawBefore = metadata.rawContent
        encoding = metadata.encoding
        lineEndings = metadata.lineEndings
      } catch (err) {
        if (!isENOENT(err)) throw err
        fileExists = false
      }
    }

    input = withoutReadPrefixes(input, freshContent)
    let sameCall: Extract<ReadKnowledge, { verdict: 'carry' }> | null = null
    if (fileExists && mode !== 'append') {
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
        (far !== null ? !remoteMovedSinceRead(context.readFileState, expandedPath, currentMtimeMs, entry.timestamp) : (currentMtimeMs ?? getFileModificationTime(expandedPath)) <= entry.timestamp) ||
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
    }

    let effectiveHunks = input.hunks as EditHunkInput[] | undefined
    let effectiveAnchor = input.expected_anchor
    let staleRecoveryNote: string | undefined
    if (anchorChecked && hasText(input.expected_anchor)) {
      const check = checkAnchor(input.expected_anchor, freshContent, input.file_path)
      if (!check.ok) {
        const recovery =
          check.reason !== 'malformed' && usingHunks
            ? attemptStaleHunkRecovery(
                context,
                input.expected_anchor,
                splitLeadingBom(freshContent).body,
                input.hunks as EditHunkInput[],
                input.file_path,
              )
            : null
        if (recovery === null) {
          throw new Error(formatAnchorFailure(check, input.expected_anchor))
        }
        effectiveHunks = recovery.hunks
        effectiveAnchor = recovery.freshAnchor
        staleRecoveryNote = recovery.note
      }
    }

    let updatedFile: string
    let patch: ReturnType<typeof getPatchFromContents>
    let reportedOldString: string
    let reportedNewString: string
    let freshLineAnchors: string | undefined
    let what: string
    let occurrences: number | undefined
    let rawUpdated: string | null = null
    if (usingHunks) {
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
    } else if (mode === 'append' || mode === 'section') {
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
    } else if (fileExists && (input.old_string ?? '') !== '' && input.old_string !== input.new_string && (input.old_string ?? '').replaceAll('\r', '') === (input.new_string ?? '').replaceAll('\r', '') && rawBefore.includes(input.old_string ?? '')) {
      const oldString = input.old_string ?? ''
      const newString = input.new_string ?? ''
      rawUpdated = applyEditToFile(rawBefore, oldString, newString, input.replace_all)
      updatedFile = rawUpdated.replaceAll('\r\n', '\n')
      patch = getPatchFromContents({ filePath: expandedPath, oldContent: freshContent, newContent: updatedFile })
      reportedOldString = oldString
      reportedNewString = newString
      occurrences = input.replace_all ? rawBefore.split(oldString).length - 1 : 1
      what = `line endings changed at ${occurrences} ${occurrences === 1 ? 'place' : 'places'} (the bytes differ only in carriage returns)`
    } else {
      const oldString = input.old_string ?? ''
      const newString = input.new_string ?? ''
      const actualOldString = findActualString(freshContent, oldString) ?? oldString
      const preserved = await preserveQuoteStyleForFile(expandedPath, freshContent, oldString, actualOldString, newString)
      const result = getPatchForEdit({
        filePath: expandedPath,
        fileContents: freshContent,
        oldString: actualOldString,
        newString: preserved,
        replaceAll: input.replace_all,
      })
      updatedFile = result.updatedFile
      patch = result.patch
      reportedOldString = oldString
      reportedNewString = newString
      const verb = newString === '' ? 'removed' : 'replaced'
      if (oldString === '') {
        what = 'file created'
      } else if (input.replace_all) {
        occurrences = freshContent.split(actualOldString).length - 1
        what = occurrences >= 2 ? `all ${occurrences} occurrences ${verb}` : `1 occurrence ${verb} (the only one)`
      } else {
        occurrences = 1
        what = `1 occurrence ${verb}`
      }
    }
    const sameCallParts = sameCall === null ? null : sameCallReadThrough(sameCall.gaps, freshContent, updatedFile, patch, expandedPath)
    const readThrough = sameCallParts === null ? undefined : sameCallParts.text

    const userModified = context.userModifiedInput === true
    const replaceAll = input.replace_all ?? false

    if (rawUpdated === null ? updatedFile === freshContent : rawUpdated === rawBefore) {
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

    const reconciled = rawUpdated ?? (fileExists
      ? preserveUntouchedLineEndings(rawBefore, updatedFile, lineEndings)
      : updatedFile)
    const owner = ownerFromToolUseContext(context)
    const cutsBeforeWrite = columnCutsOf(owner, expandedPath, fileGeneration(expandedPath))
    const knownBeforeWrite = fileExists
      ? knowledgeBeforeWrite(context, expandedPath, input.file_path, freshContent, input.expected_anchor, fileGeneration(expandedPath), seenLinesOf(owner, expandedPath))
      : []
    let writtenAt: number
    let writtenGeneration: string | null
    let finalStateContent = updatedFile
    const ideWritten =
      far !== null
        ? await far.writeTextViaRemote(expandedPath, reconciled, encoding, rawBefore.charCodeAt(0) === 0xfeff, farFound, context.abortController.signal).catch((error: Error) => {
            throw error.name === 'RemoteChangedError' ? new Error(modifiedSinceReadMessage()) : error
          })
        : ideWriteTextAvailable()
          ? await writeTextViaIdeWithReadBack(expandedPath, reconciled, encoding, rawBefore.charCodeAt(0) === 0xfeff, context.abortController.signal)
          : null
    if (ideWritten !== null) {
      writtenAt = ideWritten.mtimeMs
      writtenGeneration = ideWritten.generation
      finalStateContent = ideWritten.finalContent
    } else {
      writeTextContent(expandedPath, reconciled, encoding, fileExists ? 'LF' : lineEndings)
      writtenAt = getFileModificationTime(expandedPath)
      writtenGeneration = generationOfWrittenBytes(expandedPath, writtenBytesOf(expandedPath, reconciled, encoding))
    }
    stampOwnEditAsSeen(owner, expandedPath, writtenGeneration, knownBeforeWrite, patch, updatedFile)
    const built = await buildEditedLines({
      written: updatedFile,
      patch,
      what,
      ...(occurrences !== undefined ? { occurrences } : {}),
      path: expandedPath,
      readWindow: async (start, count) => {
        if (ideWritten !== null) {
          const allLines = finalStateContent === '' ? [] : finalStateContent.split('\n')
          return allLines.slice(start - 1, start - 1 + count)
        }
        const ideSlice = await readRangeViaIde(expandedPath, start - 1, count, undefined, context.abortController.signal)
        if (ideSlice !== null) {
          return ideSlice.lineCount === 0 ? [] : ideSlice.content.split('\n')
        }
        const range = await readFileInRange(expandedPath, start - 1, count, undefined, context.abortController.signal)
        return range.lineCount === 0 ? [] : range.content.split('\n')
      },
      ...(sameCallParts !== null ? { readThrough: { sentence: sameCallParts.sentence, windows: sameCallParts.ranges } } : {}),
      ...(freshLineAnchors !== undefined ? { freshAnchors: freshLineAnchors } : {}),
    })
    const editedLines = built.editedLines
    const shownGeneration = editedLines.readBack === 'same' ? writtenGeneration : editedLines.readBack === 'differs' ? fileGeneration(expandedPath) : null
    if (shownGeneration !== null) recordCarry(owner, expandedPath, shownGeneration, built.windows)
    if (writtenGeneration !== null && cutsBeforeWrite.length > 0) {
      const oldLines = freshContent.split('\n')
      const shiftedCuts = cutsBeforeWrite.map(cut => {
        if (mode !== 'exact') return { ...cut, line: postLineAtOrAfter(cut.line, patch) }
        const hiddenAt = oldLines.slice(0, cut.line - 1).reduce((n, line) => n + line.length + 1, 0) + cut.visibleChars
        let delta = 0
        if (reportedOldString !== '') for (let at = freshContent.indexOf(reportedOldString); at >= 0 && at + reportedOldString.length <= hiddenAt; at = freshContent.indexOf(reportedOldString, at + reportedOldString.length)) {
          delta += reportedNewString.length - reportedOldString.length
          if (!replaceAll) break
        }
        const prefix = updatedFile.slice(0, hiddenAt + delta).split('\n')
        return { line: prefix.length, visibleChars: prefix[prefix.length - 1]!.length }
      }).filter(cut => !built.windows.some(window => window.start <= cut.line && window.end >= cut.line))
      retainColumnCuts(owner, expandedPath, writtenGeneration, shiftedCuts)
    }

    const lspManager = far !== null ? null : getLspServerManager()
    if (lspManager) {
      try {
        snapshotDiagnosticsBeforeWrite(expandedPath, fileExists ? freshContent : null, finalStateContent, lspManager.getDocumentVersion(expandedPath), owner)
        clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)
        await lspManager.changeAndSaveFile(expandedPath, finalStateContent)
      } catch (err) {
        logError(err)
      }
    }

    context.readFileState.set(expandedPath, {
      content: finalStateContent,
      timestamp: writtenAt,
      offset: undefined,
      limit: undefined,
    })
    markRemoteRead(context.readFileState, expandedPath, true)

    countLinesChanged(patch, fileExists ? undefined : updatedFile)

    const { added, removed } = patchLineCounts(patch)
    const hunkCount = usingHunks ? (input.hunks as EditHunkInput[]).length : 0
    const parseError = await checkIntroducedParseError(
      expandedPath,
      fileExists ? freshContent : null,
      updatedFile,
      far !== null ? false : undefined,
    )
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
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.noChange) {
      const text =
        `No changes made to ${data.filePath}: the computed result is byte-identical to the current file content, so nothing was written. ` +
        data.noChange.guidance
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: data.readThrough !== undefined ? `${text}\n\n${data.readThrough}` : text,
        ...(data.noChange.stop ? { is_error: true } : {}),
      }
    }
    const modifiedClause = data.userModified ? ' (the user modified the change before accepting it)' : ''
    const located = data.oldString === '' || data.oldString.includes(HUNK_SPAN_ELISION) ? null : locateActualString(data.originalFile, data.oldString)
    const forgivenClause = located !== null && located.kind === 'found' && located.feedback !== null ? ` ${located.feedback}` : ''
    const relocated = data.staleRecovery !== undefined ? `Your hunks were relocated because the file changed since your read (${data.staleRecovery}) — re-read before further anchored edits.` : null
    const parseSuffix = `${isSqliteRowTarget(data.filePath) ? `\n${sqliteRowRewindNote(data.originalFile)}` : ''}${data.parseError !== undefined ? `\n${data.parseError}` : ''}`
    if (data.editedLines === undefined) {
      const text = `The file ${data.filePath} has been updated successfully${modifiedClause}.${forgivenClause}${relocated === null ? '' : ` ${relocated}`}`
      const anchored = data.freshLineAnchors !== undefined ? `${text}\n\n${data.freshLineAnchors}` : text
      const content = `${data.readThrough !== undefined ? `${anchored}\n\n${data.readThrough}` : anchored}${parseSuffix}`
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
    }
    const head = `${editResultHead(data.filePath, modifiedClause, data.editedLines)}${forgivenClause}`
    const close = relocated ?? (data.editedLines.readBack === 'same' ? EDIT_RESULT_CLOSE : null)
    const content = [head, ...(data.editedLines.body === '' ? [] : [data.editedLines.body]), ...(close === null ? [] : [close]), ...(isSqliteRowTarget(data.filePath) ? [sqliteRowRewindNote(data.originalFile)] : []), ...(data.parseError !== undefined ? [data.parseError] : [])].join('\n')
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
  },
  extractSearchText(data: Output): string {
    if (data.noChange) return ''
    return data.structuredPatch
      .flatMap(hunk => hunk.lines)
      .map(line => (/^[+\- ]/.test(line) ? line.slice(1) : line))
      .join('\n')
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})
