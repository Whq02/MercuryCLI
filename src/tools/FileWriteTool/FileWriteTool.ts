import { dirname } from 'node:path'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import {
  recordNoChangeOutcome,
  serializeIntentDigest,
} from '../../services/changeTransaction/repetitionPolicy.js'
import { checkSeenLines, clippedLinesRefusal, fileGeneration, generationOfWrittenBytes, recordWholeFileSeen, wholeFileSeen } from '../../services/changeTransaction/seenLines.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { clearDeliveredDiagnosticsForFile, snapshotDiagnosticsBeforeWrite } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { ideReadTextAvailable, ideWriteTextAvailable, readWholeTextViaIde, writeTextViaIdeWithReadBack } from '../../services/acp/ideToolBridge.js'
import { isRemotePath, markRemoteRead, remoteIdentity, remoteMovedSinceRead } from '../../services/remoteFiles/target.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isENOENT } from '../../utils/errors.js'
import {
  getFileModificationTime,
  needsPowerShellBom,
  preserveUntouchedLineEndings,
  writeTextContent,
} from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { noteFileTouched } from '../../mneme/lineageSession.js'
import { readFileSyncWithMetadata, type LineEndingType } from '../../utils/fileRead.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { controlCharacterPathRefusal, expandPath, hasControlCharacter } from '../../utils/path.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { beginCreation, settleCreation } from '../../utils/permissions/ownGround.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { memoryWriteRefusal } from '../../utils/memoryFileDetection.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import type { UUID } from 'node:crypto'

import { modifiedSinceReadMessage, unreadExistingWriteMessage } from '../FileEditTool/otherSession.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { stripSequentialReadPrefixes } from '../FileEditTool/utils.js'
import { spellLineRanges } from '../FileEditTool/readThrough.js'
import { APPLIED_NO_REREAD_NOTE, isFullReadEntry } from '../FileEditTool/FileEditTool.js'
import { gitDiffSchema, hunkSchema, type FileEditOutput } from '../FileEditTool/types.js'
import { checkIntroducedParseError } from './parseCheck.js'
import {
  callStructuredWriteTarget,
  expandStructuredTargetPath,
  hostPathOfWriteTarget,
  isSqliteRowTarget,
  parseStructuredWriteTarget,
  prepareSqliteDeletion,
  sqliteRowReadRefusal,
  sqliteRowRewindNote,
  structuredTargetRefusal,
} from './structuredTargets.js'
import { DESCRIPTION, FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'


const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('Absolute path of the file to write'),
  content: z.string().describe('The content to write to the file'),
})

export type FileWriteToolInput = z.input<typeof inputSchema>

type Input = z.infer<typeof inputSchema>

export type Output = {
  type: 'create' | 'update' | 'no-change' | 'delete' | 'not-found'
  filePath: string
  content: string
  structuredPatch: FileEditOutput['structuredPatch']
  originalFile: string | null
  gitDiff?: FileEditOutput['gitDiff']
  noChange?: FileEditOutput['noChange']
  parseError?: string
  diverged?: boolean
}

const outputSchema = z.object({
  type: z.enum(['create', 'update', 'no-change', 'delete', 'not-found']),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema()),
  originalFile: z.string().nullable(),
  gitDiff: gitDiffSchema().optional(),
  noChange: z
    .object({ streak: z.number(), stop: z.boolean(), guidance: z.string() })
    .optional(),
  parseError: z.string().optional(),
  diverged: z.boolean().optional(),
})

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


function writeToolItself(): unknown {
  return FileWriteTool
}

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  strict: true,
  straightQuoteInputs: ['file_path'],
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  async description(): Promise<string> {
    return 'Writes a file to the local filesystem.'
  },
  async prompt(): Promise<string> {
    return getWriteToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  isResultTruncated,
  getActivityDescription(input: Partial<Input> | undefined): string {
    return input?.file_path ? `Writing ${input.file_path}` : 'Writing a file'
  },
  getPath(input: Partial<Input> | undefined): string {
    if (isRemotePath(input?.file_path)) return input!.file_path!
    return input?.file_path ? hostPathOfWriteTarget(input.file_path) : getCwd()
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (isRemotePath(input.file_path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(FILE_WRITE_TOOL_NAME, input.file_path, null, input, context, 'edit')
    }
    return checkWritePermissionForTool(
      {
        name: FILE_WRITE_TOOL_NAME,
        getPath: (i: Partial<Input> | undefined) => (i?.file_path ? hostPathOfWriteTarget(i.file_path) : getCwd()),
      },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: Input): void {
    if (hasControlCharacter(input.file_path) || windowsPathNeedsPermission(input.file_path)) return
    input.file_path = isRemotePath(input.file_path) ? remoteIdentity(input.file_path) : expandStructuredTargetPath(input.file_path)
  },
  async validateInput(input: Input, context: ToolUseContext) {
    const pathRefusal = controlCharacterPathRefusal(input.file_path)
    if (pathRefusal !== null) {
      return { result: false as const, message: pathRefusal, errorCode: 1 }
    }
    if (isRemotePath(input.file_path)) {
      const { remoteEntryRefusal, remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      const entry = remoteEntryRefusal(input.file_path.trim())
      if (entry !== null) return { result: false as const, message: entry, errorCode: 1 }
      return remoteValidation(input.file_path, null, 'edit', 'Writing to', context)
    }
    const structuredTarget = parseStructuredWriteTarget(input.file_path)
    const permissionContext = context.getAppState().toolPermissionContext
    if (structuredTarget?.kind === 'sqlite-row' && structuredTarget.deleting) {
      const decision = checkWritePermissionForTool({ name: FILE_WRITE_TOOL_NAME, getPath: () => structuredTarget.hostPath }, input, permissionContext)
      if (decision.behavior === 'deny') return { result: false as const, message: decision.message, errorCode: 1 }
    }
    const expandedPath = hostPathOfWriteTarget(input.file_path)
    const writeDeny = matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')
    if (writeDeny) {
      return {
        result: false as const,
        message: ruleSentence(`Writing to ${input.file_path}`, 'deny', writeDeny),
        errorCode: 1,
      }
    }
    const memoryRefusal = memoryWriteRefusal(expandedPath)
    if (memoryRefusal) {
      return { result: false as const, message: memoryRefusal, errorCode: 3 }
    }
    if (structuredTarget !== null) {
      const unreadable = sqliteRowReadRefusal(structuredTarget, input, context)
      if (unreadable !== null) return { result: false as const, message: unreadable.message, errorCode: unreadable.errorCode }
      const refusal = structuredTargetRefusal(structuredTarget, 'write')
      if (refusal !== null) return { result: false as const, message: refusal.message, errorCode: refusal.errorCode }
      if (structuredTarget.kind === 'sqlite-row' && structuredTarget.deleting) {
        try { prepareSqliteDeletion(structuredTarget, input.content, context) }
        catch (error) { return { result: false as const, message: error instanceof Error ? error.message : String(error), errorCode: 4 } }
      }
      return { result: true as const }
    }
    if (windowsPathNeedsPermission(input.file_path)) return { result: true as const }
    let isDirectory = false
    try {
      isDirectory = getFsImplementation().statSync(expandedPath).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory) {
      return {
        result: false as const,
        message: `The path is a directory, not a file: ${input.file_path}`,
        errorCode: 2,
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, canUseTool, parentMessage) {
    const startedAt = Date.now()
    const far = isRemotePath(input.file_path) ? await import('../../services/remoteFiles/bridge.js') : null
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
            FILE_WRITE_TOOL_NAME,
            input.file_path,
            context,
            typeof canUseTool === 'function' && parentMessage !== undefined
              ? path => (canUseTool as CanUseToolFn)(writeToolItself() as never, { ...input, file_path: path }, context, parentMessage as never, `${context.toolUseId ?? 'write'}-resolved`)
              : null,
          )
    if (farTarget !== null && farTarget.kind === 'folder') throw new Error(`The path is a directory, not a file: ${input.file_path}`)
    if (farTarget !== null && farTarget.kind !== 'file' && farTarget.kind !== 'missing' && farTarget.kind !== 'dangling') {
      throw new Error(`Writing to ${farTarget.path} is not allowed: it is ${farTarget.kind === 'other' ? 'a device' : farTarget.kind}, not a file.`)
    }
    const expandedPath = farTarget !== null ? farTarget.path : expandPath(input.file_path)
    const parentDir = far !== null ? '' : dirname(expandedPath)

    if (far === null && !isEnvTruthy(process.env.MERCURY_BARE)) {
      try {
        const dirs = await discoverSkillDirsForPaths([expandedPath], getCwd())
        const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
        for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
        if (fresh.length > 0) {
          void Promise.resolve(addSkillDirectories(fresh)).catch(() => undefined)
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
          (far !== null ? remoteMovedSinceRead(context.readFileState, expandedPath, currentMtimeMs, entry.timestamp) : (currentMtimeMs ?? getFileModificationTime(expandedPath)) > entry.timestamp) &&
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
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    if (data.type === 'delete' || data.type === 'not-found') return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: data.type === 'delete' ? `Deleted one SQLite row at ${data.filePath}; the row is absent on read-back.${data.content === '' ? '' : ` ${data.content} through foreign keys or triggers.`} ${sqliteRowRewindNote(data.originalFile)}` : `Row not found at ${data.filePath}; nothing was deleted.`,
    }
    if (data.type === 'no-change') {
      const guidance = data.noChange?.guidance ?? ''
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content:
          `No changes were made to ${data.filePath}: the file content already matches what was provided, so nothing was written. ${guidance}`.trimEnd(),
        ...(data.noChange?.stop ? { is_error: true } : {}),
      }
    }
    const parseSuffix = data.parseError !== undefined ? `\n${data.parseError}` : ''
    const divergedSuffix = data.diverged === true ? `\nThe file as read back right after the write differs from what was written (formatted on save); its current content counts as read:\n\n${data.content}` : ''
    const anchorSuffix = `\n(anchor: ${mintFileAnchor(data.content)})`
    const rowSuffix = isSqliteRowTarget(data.filePath) ? ` ${sqliteRowRewindNote(data.type === 'create' ? null : data.originalFile)}` : ''
    if (data.type === 'create') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `File created successfully at: ${data.filePath}\n${APPLIED_NO_REREAD_NOTE}${rowSuffix}${divergedSuffix}${anchorSuffix}${parseSuffix}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `The file ${data.filePath} has been updated successfully. ${APPLIED_NO_REREAD_NOTE}${rowSuffix}${divergedSuffix}${anchorSuffix}${parseSuffix}`,
    }
  },
  extractSearchText(): string {
    return ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})

export { DESCRIPTION }
