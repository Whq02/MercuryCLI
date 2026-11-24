import { dirname } from 'node:path'

import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { type Tool, type ToolUseContext } from '../../kit/tool.js'
import {
  recordNoChangeOutcome,
  serializeIntentDigest,
} from '../../engines/change-transaction/repetitionPolicy.js'
import { checkSeenLines, clippedLinesRefusal, fileGeneration, generationOfWrittenBytes, recordWholeFileSeen, wholeFileSeen } from '../../engines/change-transaction/seenLines.js'
import { mintFileAnchor } from '../../engines/change-transaction/snapshotAnchor.js'
import { clearDeliveredDiagnosticsForFile, snapshotDiagnosticsBeforeWrite } from '../../../integrations/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../../integrations/lsp/serverManagerLifecycle.js'
import { runtimeKernel } from '../../../engine/runtime-kernel/runtimeKernel.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { ideReadTextAvailable, ideWriteTextAvailable, readWholeTextViaIde, writeTextViaIdeWithReadBack } from '../../../integrations/acp/ideToolBridge.js'
import { isRemotePath, markRemoteRead, remoteMovedSinceRead } from '../../../platform/remote-file-target/target.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../../integrations/skills/loadSkillsDir.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { countLinesChanged, getPatchForDisplay } from '../../../platform/text/diff.js'
import { isENOENT } from '../../../platform/errors/errors.js'
import {
  getCheckedFileModificationTime,
  getFileModificationTime,
  needsPowerShellBom,
  preserveUntouchedLineEndings,
  writeTextContent,
} from '../../../platform/files/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../engines/change-transaction/fileHistory.js'
import { noteFileTouched } from '../../../sessions/mneme/lineageSession.js'
import { readFileSyncWithMetadata, type LineEndingType } from '../../../platform/files/syncFileRead.js'
import { isEnvTruthy } from '../../../platform/environment/envUtils.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { expandPath } from '../../../platform/files/path.js'
import { beginCreation, settleCreation } from '../../../permissions/rules/ownGround.js'
import { getFsImplementation } from '../../../platform/files/fsOperations.js'
import type { UUID } from 'node:crypto'

import { modifiedSinceReadMessage, unreadExistingWriteMessage } from '../../edit/otherSession.js'
import type { CanUseToolFn } from '../../kit/tool.js'
import { stripSequentialReadPrefixes } from '../../edit/call/editMatching.js'
import { spellLineRanges } from '../../edit/readThrough.js'
import { isFullReadEntry } from '../../edit/EditTool.js'
import { checkIntroducedParseError } from '../parseCheck.js'
import {
  callStructuredWriteTarget,
  parseStructuredWriteTarget,
} from '../structuredTargets.js'
import { WRITE_TOOL_NAME } from '../../kit/names/fileWrite.js'
import type { AssistantMessage } from '../../../engine/message-shapes/message.js'
import type { Input, Output } from './schema.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}


function shapeToExistingFile(rawBody: string, content: string, majority: LineEndingType): string {
  let body = content.replaceAll('\r\n', '\n')
  if (body !== '') {
    if (!rawBody.endsWith('\n') && body.endsWith('\n')) body = body.slice(0, -1)
    else if (rawBody.endsWith('\n') && !body.endsWith('\n')) body = `${body}\n`
  }
  return preserveUntouchedLineEndings(rawBody, body, majority)
}

export async function writeFileCall(input: Input, context: ToolUseContext, canUseTool: CanUseToolFn, parentMessage: AssistantMessage, writeToolItself: () => Tool) {
  const startedAt = Date.now()
  const far = isRemotePath(input.file_path) ? await import('../../../platform/remote-files/bridge.js') : null
  const structuredTarget = far !== null ? null : parseStructuredWriteTarget(input.file_path)
  if (structuredTarget !== null) {
    if (structuredTarget.kind === 'refused') throw new Error(structuredTarget.reason)
    const hostParentDir = dirname(structuredTarget.hostPath)
    if (hostParentDir) {
      await getFsImplementation().mkdir(hostParentDir)
    }
    if (fileHistoryEnabled()) {
      if (structuredTarget.kind === 'sqlite-row') noteFileTouched(structuredTarget.hostPath)
      else await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        structuredTarget.hostPath,
        parentMessage.uuid as UUID,
      )
    }
    return callStructuredWriteTarget(structuredTarget, input.content, context, startedAt)
  }
  const farTarget =
    far === null
      ? null
      : await far.remoteWriteTarget(
          WRITE_TOOL_NAME,
          input.file_path,
          context,
          typeof canUseTool === 'function' && parentMessage !== undefined
            ? path => canUseTool(writeToolItself(), { ...input, file_path: path }, context, parentMessage, `${context.toolUseId ?? 'write'}-resolved`)
            : null,
        )
  if (farTarget !== null && farTarget.kind === 'folder') throw new Error(`The path is a directory, not a file: ${input.file_path}`)
  if (farTarget !== null && farTarget.kind !== 'file' && farTarget.kind !== 'missing' && farTarget.kind !== 'dangling') {
    throw new Error(`Writing to ${farTarget.path} is not allowed: it is ${farTarget.kind === 'other' ? 'a device' : farTarget.kind}, not a file.`)
  }
  const expandedPath = farTarget !== null ? farTarget.path : expandPath(input.file_path)
  const parentDir = far !== null ? '' : dirname(expandedPath)

  if (far === null && !isEnvTruthy(flagEnv('MERCURY_BARE'))) {
    try {
      const dirs = await discoverSkillDirsForPaths([expandedPath], getCwd())
      const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
      for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
      if (fresh.length > 0) {
        void Promise.resolve(addSkillDirectories(fresh)).catch(passedOverAs(undefined))
      }
      activateConditionalSkillsForPaths([expandedPath], getCwd())
    } catch (err) {
      logError(err)
    }
  }
  if (far === null) context.nestedMemoryAttachmentTriggers?.add(expandedPath)

  const created = far !== null ? null : beginCreation(expandedPath)
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

  let fileExists = true
  let rawContent = ''
  let normalizedContent = ''
  let encoding: BufferEncoding = 'utf8'
  let lineEndings: LineEndingType = 'LF'
  let currentMtimeMs: number | undefined
  let farFound: { sum: string; mode: string | null } | null = null
  if (far !== null) {
    try {
      const farMeta = await far.readWholeTextViaRemote(expandedPath, context.abortController.signal)
      rawContent = farMeta.rawContent
      normalizedContent = farMeta.content
      encoding = farMeta.encoding
      lineEndings = farMeta.lineEndings
      currentMtimeMs = farMeta.mtimeMs
      farFound = farMeta.found
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }
  } else if (ideReadTextAvailable()) {
    try {
      const ideMeta = await readWholeTextViaIde(expandedPath, context.abortController.signal)
      if (ideMeta !== null) {
        rawContent = ideMeta.rawContent
        normalizedContent = ideMeta.content
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
      rawContent = metadata.rawContent
      normalizedContent = metadata.content
      encoding = metadata.encoding
      lineEndings = metadata.lineEndings
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }
  }

  const hadBom = rawContent.charCodeAt(0) === 0xfeff
  const rawBody = hadBom ? rawContent.slice(1) : rawContent
  const content = stripSequentialReadPrefixes(input.content, rawBody)
  const shaped = fileExists && rawBody !== '' ? shapeToExistingFile(rawBody, content, lineEndings) : content
  const wantsBom = hadBom || (far === null && needsPowerShellBom(expandedPath) && encoding === 'utf8')
  const producedContent =
    wantsBom && shaped.charCodeAt(0) !== 0xfeff
      ? String.fromCharCode(0xfeff) + shaped
      : shaped
  const suppliedBytes = Buffer.byteLength(input.content, 'utf8')
  const producedBytes = Buffer.byteLength(producedContent, 'utf8')

  if (fileExists && rawContent === producedContent) {
    const owner = ownerFromToolUseContext(context)
    const verdict = recordNoChangeOutcome(owner, {
      operation: 'file.write',
      path: expandedPath,
      revision: mintFileAnchor(normalizedContent),
      intentDigest: serializeIntentDigest([input.content]),
      displayPath: input.file_path,
    })
    const data: Output = {
      type: 'no-change',
      filePath: expandedPath,
      content: input.content,
      structuredPatch: [],
      originalFile: normalizedContent,
      noChange: { streak: verdict.streak, stop: verdict.atCeiling, guidance: verdict.guidance },
    }
    return {
      data,
      effect: {
        outcome: 'no-change' as const,
        operation: 'file.write',
        changedPaths: [],
        evidence: 'the file already holds exactly the produced bytes; nothing was written',
        startedAt,
        completedAt: Date.now(),
      },
    }
  }

  if (fileExists) {
    const owner = ownerFromToolUseContext(context)
    const generation = fileGeneration(expandedPath)
    const clipped = clippedLinesRefusal(owner, expandedPath, input.file_path, generation, null)
    if (clipped !== null) throw new Error(clipped)
    const entry = context.readFileState.get(expandedPath)
    const fullRead = entry !== undefined && !entry.isPartialView && isFullReadEntry(entry) && entry.content === normalizedContent.replace(/^\uFEFF/, '')
    if (!wholeFileSeen(owner, expandedPath, normalizedContent)) {
      if (
        entry !== undefined &&
        !entry.isPartialView &&
        (far !== null ? remoteMovedSinceRead(context.readFileState, expandedPath, currentMtimeMs, entry.timestamp) : (currentMtimeMs ?? getCheckedFileModificationTime(expandedPath)) > entry.timestamp) &&
        !fullRead
      ) {
        throw new Error(modifiedSinceReadMessage())
      }
      if (!fullRead) {
        const end = normalizedContent === '' ? 0 : normalizedContent.split('\n').length - (normalizedContent.endsWith('\n') ? 1 : 0)
        const verdict = generation === null || end === 0 ? null : checkSeenLines(owner, expandedPath, generation, [{ index: 0, start: 1, end, replace: content }])
        const unread = verdict === null || verdict.ok ? [] : verdict.unseen
        const first = unread[0]
        if (first === undefined || (first.start === 1 && first.end === end)) throw new Error(unreadExistingWriteMessage())
        const one = unread.length === 1 && first.start === first.end
        throw new Error(`${one ? 'Line' : 'Lines'} ${spellLineRanges(unread)} ${one ? 'was' : 'were'} not read; Read(file_path: ${JSON.stringify(input.file_path)}, offset: ${first.start}, limit: ${first.end - first.start + 1}) shows ${one ? 'it' : unread.length === 1 ? 'them' : 'the first range'} before replacement.`)
      }
    }
  }

  let writtenContent = shaped.replaceAll('\r\n', '\n')
  let writtenAt: number
  let diverged = false
  const ideWritten =
    far !== null
      ? await far.writeTextViaRemote(expandedPath, shaped, encoding, hadBom, farFound, context.abortController.signal).catch((error: Error) => {
          throw error.name === 'RemoteChangedError' ? new Error(modifiedSinceReadMessage()) : error
        })
      : ideWriteTextAvailable()
        ? await writeTextViaIdeWithReadBack(expandedPath, shaped, encoding, hadBom, context.abortController.signal)
        : null
  if (ideWritten !== null) {
    writtenContent = ideWritten.finalContent
    writtenAt = ideWritten.mtimeMs
    diverged = ideWritten.diverged
    try {
      recordWholeFileSeen(ownerFromToolUseContext(context), expandedPath, ideWritten.generation, writtenContent)
    } catch (err) {
      logError(err)
    }
  } else {
    writeTextContent(expandedPath, shaped, encoding, 'LF', { keepBom: hadBom })
    writtenAt = getFileModificationTime(expandedPath)
    try {
      const writtenGeneration = generationOfWrittenBytes(expandedPath, Buffer.from(producedContent, encoding))
      if (writtenGeneration !== null) {
        recordWholeFileSeen(ownerFromToolUseContext(context), expandedPath, writtenGeneration, writtenContent)
      }
    } catch (err) {
      logError(err)
    }
  }

  const lspManager = far !== null ? null : getLspServerManager()
  if (lspManager) {
    try {
      snapshotDiagnosticsBeforeWrite(expandedPath, fileExists ? normalizedContent : null, writtenContent, lspManager.getDocumentVersion(expandedPath), ownerFromToolUseContext(context))
      clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)
      await lspManager.changeAndSaveFile(expandedPath, writtenContent)
    } catch (err) {
      logError(err)
    }
  }

  context.readFileState.set(expandedPath, {
    content: writtenContent,
    timestamp: writtenAt,
    offset: undefined,
    limit: undefined,
  })
  markRemoteRead(context.readFileState, expandedPath, true)

  const parseError = await checkIntroducedParseError(
    expandedPath,
    fileExists ? normalizedContent : null,
    writtenContent,
    far !== null ? false : undefined,
  )
  if (fileExists) {
    const shownBefore = hadBom ? normalizedContent.slice(1) : normalizedContent
    const patch = getPatchForDisplay({
      filePath: expandedPath,
      fileContents: shownBefore,
      edits: [{ old_string: shownBefore, new_string: writtenContent }],
    })
    countLinesChanged(patch)
    const data: Output = {
      type: 'update',
      filePath: expandedPath,
      content: writtenContent,
      structuredPatch: patch,
      originalFile: normalizedContent,
      ...(parseError !== undefined ? { parseError } : {}),
      ...(diverged ? { diverged: true } : {}),
    }
    return {
      data,
      effect: {
        outcome: 'succeeded' as const,
        operation: 'file.write',
        changedPaths: [expandedPath],
        evidence: `overwrote ${expandedPath} (${suppliedBytes} bytes)`,
        startedAt,
        completedAt: Date.now(),
        details: { digest: sha16(producedContent), bytes: producedBytes },
      },
    }
  }

  countLinesChanged([], writtenContent)
  settleCreation(created)
  const data: Output = {
    type: 'create',
    filePath: expandedPath,
    content: writtenContent,
    structuredPatch: [],
    originalFile: null,
    ...(parseError !== undefined ? { parseError } : {}),
    ...(diverged ? { diverged: true } : {}),
  }
  return {
    data,
    effect: {
      outcome: 'succeeded' as const,
      operation: 'file.write',
      changedPaths: [expandedPath],
      evidence: `created ${expandedPath} (${suppliedBytes} bytes)`,
      startedAt,
      completedAt: Date.now(),
      details: { digest: sha16(producedContent), bytes: producedBytes },
    },
  }
}
