import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import {
  recordNoChangeOutcome,
  serializeIntentDigest,
} from '../../services/changeTransaction/repetitionPolicy.js'
import { mintFileAnchor } from '../../services/changeTransaction/snapshotAnchor.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
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
  writeTextContent,
} from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import type { UUID } from 'node:crypto'

import type { FileState } from '../../utils/fileStateCache.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema, type FileEditOutput } from '../FileEditTool/types.js'
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

/**
 * The Write tool: whole-file replacement with no-change settlement,
 * read-knowledge and staleness enforcement inside the synchronous write
 * section, honest create/update classification, and a typed effect.
 */

const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe('The absolute path to the file to write (must be absolute, not relative)'),
  content: z.string().describe('The content to write to the file'),
})

/** Deliberately the input SCHEMA type, not the parsed value. */
export type FileWriteToolInput = z.input<typeof inputSchema>

type Input = z.infer<typeof inputSchema>

export type Output = {
  type: 'create' | 'update' | 'no-change'
  filePath: string
  content: string
  structuredPatch: FileEditOutput['structuredPatch']
  originalFile: string | null
  gitDiff?: FileEditOutput['gitDiff']
  noChange?: FileEditOutput['noChange']
}

// Resumed transcripts guard persisted results through this schema; the
// patch and git-diff sub-schemas are Edit's, reused.
const outputSchema = z.object({
  type: z.enum(['create', 'update', 'no-change']),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema()),
  originalFile: z.string().nullable(),
  gitDiff: gitDiffSchema().optional(),
  noChange: z
    .object({ streak: z.number(), stop: z.boolean(), guidance: z.string() })
    .optional(),
})

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

function isFullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
}

const UNREAD_FILE_MESSAGE = 'Read the file before overwriting it — a prior read of the current content is required.'

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  strict: true,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  async description(): Promise<string> {
    // Deliberately a duplicate of the exported description constant.
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
  toAutoClassifierInput(input: Input): string {
    return input.file_path
  },
  getPath(input: Partial<Input> | undefined): string {
    return input?.file_path || getCwd()
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    // The write ladder (deny/ask rules, path safety, the implement fast
    // path, allow rules) is the ONE owner of the write decision; the tool
    // hands it only its name and path accessor (naming them directly avoids
    // a self-referential initializer).
    return checkWritePermissionForTool(
      { name: FILE_WRITE_TOOL_NAME, getPath: (i: Partial<Input> | undefined) => i?.file_path || getCwd() },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: Input): void {
    input.file_path = expandPath(input.file_path)
  },
  async validateInput(input: Input, context: ToolUseContext) {
    // Content-free by law: input checks and the access decision only. The
    // read-knowledge and staleness rules run inside call, after the single
    // current-state snapshot, so an already-matching unread file settles as
    // a no-change on its first call.
    const expandedPath = expandPath(input.file_path)
    const permissionContext = context.getAppState().toolPermissionContext
    if (matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')) {
      return {
        result: false as const,
        message: `Writing to ${input.file_path} is denied by permission settings.`,
        errorCode: 1,
      }
    }
    if (input.file_path.startsWith('\\\\') || input.file_path.startsWith('//')) {
      return { result: true as const }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext, _canUseTool, parentMessage) {
    const startedAt = Date.now()
    const expandedPath = expandPath(input.file_path)
    const parentDir = expandedPath.split(/[\\/]/).slice(0, -1).join('/')

    // Skill discovery and conditional activation — unconditional here,
    // unlike Read/Edit (no simple-mode gate).
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

    await diagnosticTracker.beforeFileEdited(expandedPath)

    // Parent directory BEFORE the write and OUTSIDE the atomic section — a
    // lazy ENOENT-triggered mkdir fires a spurious atomic-write analytics
    // event before the error propagates.
    if (parentDir) {
      await getFsImplementation().mkdir(parentDir)
    }
    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        context.updateFileHistoryState,
        expandedPath,
        parentMessage.uuid as UUID,
      )
    }

    // ── atomic section ────────────────────────────────────────────────────
    let fileExists = true
    let rawContent = ''
    let normalizedContent = ''
    let encoding: BufferEncoding = 'utf8'
    try {
      const metadata = readFileSyncWithMetadata(expandedPath)
      rawContent = metadata.rawContent
      normalizedContent = metadata.content
      encoding = metadata.encoding
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }

    // The file opened with a byte-order mark: the model's content arrives
    // without it (the ranged Read drops the mark), and a plain write left a
    // UTF-16LE file headerless and a UTF-8-BOM file bare (TASK-014
    // w4-f02-02) — the writer re-applies the mark in the file's encoding.
    const hadBom = rawContent.charCodeAt(0) === 0xfeff
    // The exact bytes this call would produce — used ONLY for the equality
    // test and the effect digest/byte count; the write itself passes the
    // model's content through and lets the writer re-apply the BOM rule.
    const wantsBom = hadBom || (needsPowerShellBom(expandedPath) && encoding === 'utf8')
    const producedContent =
      wantsBom && input.content.charCodeAt(0) !== 0xfeff
        ? String.fromCharCode(0xfeff) + input.content
        : input.content
    const suppliedBytes = Buffer.byteLength(input.content, 'utf8')
    const producedBytes = Buffer.byteLength(producedContent, 'utf8')

    // No-change settlement: exact produced bytes against the raw decoded
    // file — normalised content is never mislabelled byte-identical.
    // Settling waives only the read-knowledge requirement; it can never
    // authorise a differing mutation.
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

    // Read-knowledge and staleness — the differing path only, in the same
    // synchronous section as the write (no validation-to-execution race).
    if (fileExists) {
      const entry = context.readFileState.get(expandedPath)
      if (!entry || entry.isPartialView) {
        throw new Error(UNREAD_FILE_MESSAGE)
      }
      const mtime = getFileModificationTime(expandedPath)
      if (
        mtime > entry.timestamp &&
        !(isFullReadEntry(entry) && entry.content === normalizedContent)
      ) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
    }

    // Write with the file's existing encoding but LF endings
    // UNCONDITIONALLY: a whole-file write replaces the file outright, so the
    // payload's own line endings are the intended ones. (Inheriting old
    // endings silently injected carriage returns into shell scripts, and a
    // repository sample could be poisoned by binary files.)
    writeTextContent(expandedPath, input.content, encoding, 'LF', { keepBom: hadBom })

    // Downstream notifications — identical in kind, order and guard to Edit.
    const lspManager = getLspServerManager()
    if (lspManager) {
      try {
        clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)
        await lspManager.changeAndSaveFile(expandedPath, input.content)
      } catch (err) {
        logError(err)
      }
    }
    notifyVscodeFileUpdated(expandedPath, fileExists ? normalizedContent : '', input.content)

    context.readFileState.set(expandedPath, {
      content: input.content.replaceAll('\r\n', '\n'),
      timestamp: getFileModificationTime(expandedPath),
      offset: undefined,
      limit: undefined,
    })

    // Classify from FILE EXISTENCE, never from old-content truthiness: an
    // existing-but-empty file overwritten with content is an update.
    let gitDiff: Output['gitDiff']
    if (fileExists) {
      const patch = getPatchForDisplay({
        filePath: expandedPath,
        fileContents: normalizedContent,
        edits: [{ old_string: normalizedContent, new_string: input.content }],
      })
      countLinesChanged(patch)
      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: expandedPath,
        content: input.content,
        type: 'update',
      })
      const data: Output = {
        type: 'update',
        filePath: expandedPath,
        content: input.content,
        structuredPatch: patch,
        originalFile: normalizedContent,
        ...(gitDiff !== undefined ? { gitDiff } : {}),
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

    countLinesChanged([], input.content)
    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: expandedPath,
      content: input.content,
      type: 'create',
    })
    const data: Output = {
      type: 'create',
      filePath: expandedPath,
      content: input.content,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff !== undefined ? { gitDiff } : {}),
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
    if (data.type === 'create') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `File created successfully at: ${data.filePath}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `The file ${data.filePath} has been updated successfully.`,
    }
  },
  extractSearchText(): string {
    // The create view paints content but the update view paints a diff —
    // indexing raw content would mint phantom hits in update mode. The
    // tool-use record already indexes the path.
    return ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
})

export { DESCRIPTION }
