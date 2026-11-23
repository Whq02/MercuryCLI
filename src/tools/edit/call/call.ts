import { dirname } from 'node:path'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import type { Tool, ToolUseContext, ValidationResult } from '../../kit/tool.js'
import { changeTransactionEnabled } from '../../engines/change-transaction/contracts.js'
import type { EditHunkInput } from '../../engines/change-transaction/hunks.js'
import { columnCutsOf, retainColumnCuts, fileGeneration, generationOfWrittenBytes, seenLinesOf } from '../../engines/change-transaction/seenLines.js'
import { checkAnchor, formatAnchorFailure } from '../../engines/change-transaction/snapshotAnchor.js'
import { clearDeliveredDiagnosticsForFile, snapshotDiagnosticsBeforeWrite } from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../../integrations/lsp/serverManagerLifecycle.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { ideReadTextAvailable, ideWriteTextAvailable, readRangeViaIde, readWholeTextViaIde, writeTextViaIdeWithReadBack } from '../../../integrations/acp/ideToolBridge.js'
import { isRemotePath, markRemoteRead } from '../../../platform/remote-file-target/target.js'
import { countLinesChanged } from '../../../platform/text/diff.js'
import { isEnvTruthy } from '../../../platform/environment/envUtils.js'
import { isENOENT } from '../../../platform/errors/errors.js'
import { getFileModificationTime, preserveUntouchedLineEndings, writeTextContent } from '../../../platform/files/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../engines/change-transaction/fileHistory.js'
import { noteFileTouched } from '../../../sessions/mneme/lineageSession.js'
import { LOSSY_DECODE_MESSAGE, readFileSyncWithMetadata, type LineEndingType } from '../../../platform/files/syncFileRead.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { expandPath } from '../../../platform/files/path.js'
import { readFileInRange } from '../../../platform/files/readFileInRange.js'
import { getFsImplementation } from '../../../platform/files/fsOperations.js'
import type { UUID } from 'node:crypto'
import type { CanUseToolFn } from '../../kit/tool.js'
import { checkIntroducedParseError } from '../../write/parseCheck.js'
import { callStructuredEditTarget, parseStructuredWriteTarget } from '../../write/structuredTargets.js'
import { FILE_EDIT_TOOL_NAME } from '../../kit/names/fileEdit.js'
import { modifiedSinceReadMessage } from '../otherSession.js'
import type { FileEditInput } from '../schema.js'
import { findActualString, getPatchForEdit, preserveQuoteStyleForFile } from './editMatching.js'
import { buildEditedLines } from '../editResult.js'
import type { getPatchFromContents } from '../../../platform/text/diff.js'
import { ONE_GIB, type FarHeld, tooLargeToEdit, discoverSkillsForPath, patchLineCounts, hasText, hunksInUse, editMode, attemptStaleHunkRecovery, splitLeadingBom } from './fileFacts.js'
import { recordCarry, postLineAtOrAfter, knowledgeBeforeWrite, writtenBytesOf, stampOwnEditAsSeen, sameCallReadThrough, type ReadKnowledge } from './readKnowledge.js'
import { withoutReadPrefixes } from './exactMatch.js'
import type { AssistantMessage } from '../../../engine/message-shapes/message.js'
import { sameCallKnowledge, hunksEdit, appendSectionEdit, carriageReturnEdit, noChangeAnswer, editedAnswer } from './callParts.js'

export type EditToolSelf = Tool & {
  validateInput(input: FileEditInput, context: ToolUseContext, held?: FarHeld): Promise<ValidationResult> | ValidationResult
}

export async function editFileCall(input: FileEditInput, context: ToolUseContext, canUseTool: CanUseToolFn, parentMessage: AssistantMessage, editToolItself: () => EditToolSelf) {
  const startedAt = Date.now()
  const far = isRemotePath(input.file_path) ? await import('../../../platform/remote-files/bridge.js') : null
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
            ? path => canUseTool(editToolItself(), { ...input, file_path: path }, context, parentMessage, `${context.toolUseId ?? 'edit'}-resolved`)
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
    const verdict = await editToolItself().validateInput(input, context, held)
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
    sameCall = sameCallKnowledge(context, input, mode, expandedPath, freshContent, far, currentMtimeMs)
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
    ({ updatedFile, patch, reportedOldString, reportedNewString, freshLineAnchors, what } = hunksEdit(freshContent, effectiveHunks, effectiveAnchor, expandedPath))
  } else if (mode === 'append' || mode === 'section') {
    ({ updatedFile, patch, reportedOldString, reportedNewString, what } = appendSectionEdit(freshContent, input, mode, expandedPath))
  } else if (fileExists && (input.old_string ?? '') !== '' && input.old_string !== input.new_string && (input.old_string ?? '').replaceAll('\r', '') === (input.new_string ?? '').replaceAll('\r', '') && rawBefore.includes(input.old_string ?? '')) {
    ({ rawUpdated, updatedFile, patch, reportedOldString, reportedNewString, occurrences, what } = carriageReturnEdit(rawBefore, freshContent, input, expandedPath))
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
    return noChangeAnswer({ context, input, usingHunks, mode, reportedOldString, reportedNewString, replaceAll, expandedPath, freshContent, userModified, readThrough, startedAt, anchorChecked })
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
  return editedAnswer({ expandedPath, reportedOldString, reportedNewString, freshContent, patch, userModified, replaceAll, freshLineAnchors, staleRecoveryNote, readThrough, parseError, editedLines, usingHunks, hunkCount, added, removed, mode, startedAt, updatedFile, anchorChecked })
}
