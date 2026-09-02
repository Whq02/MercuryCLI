import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import { recallAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import { recoverStaleHunks, staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import {
  applyHunks,
  editHunksEnabled,
  planApplyRegions,
  planHunks,
  spanText,
  type EditHunkInput,
} from '../../services/changeTransaction/hunks.js'
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
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
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
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  preserveUntouchedLineEndings,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import { fileHistoryEnabled, fileHistoryTrackEdit } from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata, type LineEndingType } from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import type { UUID } from 'node:crypto'

import type { FileState } from '../../utils/fileStateCache.js'
import { MAX_LINES_TO_READ } from '../FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME, FILE_UNEXPECTEDLY_MODIFIED_ERROR } from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  inputSchema,
  outputSchema,
  type FileEditInput,
  type FileEditOutput,
} from './types.js'
import {
  applyEditToFile,
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
} from './utils.js'
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

/**
 * The Edit tool: validation, staleness rules, the exact-string and
 * anchored-hunk edit lanes, the write, downstream notification, and the
 * typed effect. A mutation may only land on bytes the model has observed,
 * and one that changes nothing is reported as changing nothing.
 */

const ONE_GIB = 1024 * 1024 * 1024
const HUNK_SPAN_ELISION = '\n...\n'

type Output = FileEditOutput

export type { Output }

// ── shared helpers ──────────────────────────────────────────────────────────

/** UTF-16LE when the buffer opens with the little-endian BOM, else UTF-8.
 *  `lossless` says whether re-encoding the decode reproduces the bytes —
 *  false means U+FFFD landed where bytes were (legacy ANSI/cp1252,
 *  UTF-16BE, torn UTF-8) and a write-back would destroy content the edit
 *  never touched. */
function decodeFileBuffer(buffer: Buffer): { content: string; encoding: BufferEncoding; lossless: boolean } {
  const encoding: BufferEncoding =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8'
  const raw = buffer.toString(encoding)
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lossless: Buffer.from(raw, encoding).equals(buffer),
  }
}

/** The refusal both edit doors speak when the decode was lossy (TASK-017
 *  supplement, S1: a cp1252 file read as UTF-8 came back with replacement
 *  characters and was REWRITTEN with them, destroying every accented byte
 *  the edit never touched). */
const LOSSY_DECODE_MESSAGE =
  'File is not valid UTF-8 (or UTF-16LE): editing would rewrite the undecodable bytes as replacement characters (U+FFFD), destroying content the edit never touches. Convert it first (for example `iconv -f cp1252 -t utf-8`), or change it with a shell command that preserves its encoding.'

async function notFoundSuggestionSentence(expandedPath: string): Promise<string> {
  let suggestion: string | undefined
  try {
    suggestion = await suggestPathUnderCwd(expandedPath)
  } catch {
    suggestion = undefined
  }
  if (suggestion === undefined) suggestion = findSimilarFile(expandedPath)
  return suggestion ? ` Did you mean ${suggestion}?` : ''
}

/** Whether the recorded read covered the whole file (no window). */
function isFullReadEntry(entry: FileState): boolean {
  return (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
}

/**
 * The validation-time staleness test: passes when the mtime is not ahead of
 * the read, when a full read's recorded content equals the current content,
 * or when a partial window re-reads byte-identically.
 */
async function staleAtValidation(
  entry: FileState,
  expandedPath: string,
  currentContent: string,
  signal: AbortSignal,
): Promise<boolean> {
  const mtime = getFileModificationTime(expandedPath)
  if (mtime <= entry.timestamp) return false
  if (isFullReadEntry(entry)) {
    return entry.content !== currentContent
  }
  // Partial window: re-read the same window through the same range reader.
  try {
    const lineOffset = Math.max(0, (entry.offset ?? 1) - 1)
    const window = await readFileInRange(
      expandedPath,
      lineOffset,
      entry.limit ?? MAX_LINES_TO_READ,
      undefined,
      signal,
    )
    return window.content !== entry.content
  } catch {
    // A read error counts as "not intact".
    return true
  }
}

function sha16(content: string): string {
  return runtimeKernel().hash.sha256Hex(content).slice(0, 16)
}

async function discoverSkillsForPath(context: ToolUseContext, filePath: string): Promise<void> {
  try {
    const dirs = await discoverSkillDirsForPaths([filePath], getCwd())
    const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
    for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
    if (fresh.length > 0) {
      void Promise.resolve(addSkillDirectories(fresh)).catch(() => undefined)
    }
    activateConditionalSkillsForPaths([filePath], getCwd())
  } catch (err) {
    logError(err)
  }
}

function patchLineCounts(patch: Array<{ lines: string[] }>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

/** Whether the hunks lane is active for this input (gate-read, never raw). */
function hunksInUse(input: FileEditInput): boolean {
  return editHunksEnabled() && input.hunks !== undefined
}

/**
 * FN-013 LOOP-03 — the default hunks path's stale-anchor relocation. The
 * SAME bounded recovery the opt-in anchor-patch lane always ran, with the
 * safety conditions unchanged: the ring must hold the exact snapshot the
 * anchor was minted from (verified by re-minting inside the recall), every
 * hunk's span plus context must occur at exactly one position in current
 * content, spans pairwise disjoint and in original order. Any weaker case
 * answers null and the caller falls through to today's typed refusal —
 * recovery never rewrites content that changed inside a hunk window. Pure
 * over its inputs (deterministic between the validate and call stages);
 * never throws into the edit path.
 */
function attemptStaleHunkRecovery(
  context: ToolUseContext,
  staleAnchor: string,
  currentBody: string,
  hunks: EditHunkInput[],
  displayPath: string,
): { hunks: EditHunkInput[]; freshAnchor: string; note: string } | null {
  if (!staleEditRecoveryEnabled()) return null
  try {
    const owner = ownerFromToolUseContext(context)
    const recalled = recallAnchoredSnapshot(owner, staleAnchor)
    if (!recalled) return null
    const outcome = recoverStaleHunks({
      staleAnchor,
      snapshotContent: recalled.content,
      currentContent: currentBody,
      hunks,
      displayPath,
    })
    if (!outcome.ok) return null
    return {
      hunks: outcome.hunks,
      freshAnchor: mintFileAnchor(currentBody),
      note: outcome.warnings.join('; '),
    }
  } catch {
    return null
  }
}

/**
 * Split a leading BOM off content the hunks lane is about to plan over.
 * The BOM is encoding furniture the model never sees (reads strip it,
 * anchors normalize it away) — planning and splicing over the marked text
 * would let a line-1 replacement silently destroy a byte the model never
 * observed. The owner re-attaches it on write, the same way it owns
 * encoding and line-ending restore. (The exact-string lane never had the
 * defect: indexOf matches past the BOM.)
 */
function splitLeadingBom(content: string): { bom: string; body: string } {
  return content.charCodeAt(0) === 0xfeff
    ? { bom: content.charAt(0), body: content.slice(1) }
    : { bom: '', body: content }
}

// ── the tool ────────────────────────────────────────────────────────────────

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  strict: true,
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
  async prompt(): Promise<string> {
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path ? `Editing ${input.file_path}` : 'Editing a file'
  },
  toAutoClassifierInput(input: FileEditInput): string {
    return input.file_path
  },
  getPath(input: Partial<FileEditInput> | undefined): string {
    return input?.file_path || getCwd()
  },
  async checkPermissions(input: FileEditInput, context: ToolUseContext) {
    // The write ladder (deny/ask rules, path safety, the implement fast
    // path, allow rules) is the ONE owner of the edit decision; the tool
    // hands it only its name and path accessor (naming them directly avoids
    // a self-referential initializer).
    return checkWritePermissionForTool(
      { name: FILE_EDIT_TOOL_NAME, getPath: (i: Partial<FileEditInput> | undefined) => i?.file_path || getCwd() },
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  backfillObservableInput(input: FileEditInput): void {
    input.file_path = expandPath(input.file_path)
  },
  inputsEquivalent(a: FileEditInput, b: FileEditInput): boolean {
    if (a.hunks !== undefined || b.hunks !== undefined) {
      return (
        a.file_path === b.file_path &&
        a.expected_anchor === b.expected_anchor &&
        JSON.stringify(a.hunks ?? null) === JSON.stringify(b.hunks ?? null)
      )
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
  async validateInput(input: FileEditInput, context: ToolUseContext) {
    const usingHunks = hunksInUse(input)

    // 1. Mode exclusivity.
    if (!usingHunks && (input.old_string === undefined || input.new_string === undefined)) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'old_string and new_string are required unless hunks are provided.',
        errorCode: 13,
      }
    }
    if (
      usingHunks &&
      (input.old_string !== undefined || input.new_string !== undefined || input.replace_all)
    ) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          'hunks and old_string/new_string/replace_all are mutually exclusive — use one edit mode per call.',
        errorCode: 13,
      }
    }
    if (usingHunks && !input.expected_anchor) {
      // The hashline relaxation: a batch whose EVERY hunk is
      // anchor-qualified carries its own staleness contract (the endpoint
      // hashes; external drift is still refused wholesale at step 12), so
      // the file-level anchor becomes optional belt. '#'-bearing spellings
      // count as qualified here even when broken — they refuse with the
      // precise parse message at planning, never with an anchor demand.
      const everyHunkAnchorQualified =
        lineAnchorsEnabled() &&
        (input.hunks ?? []).every(h => parseHashedLinesSpelling(h.lines) !== null)
      if (!everyHunkAnchorQualified) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message:
            'hunks require expected_anchor — carry the parenthesised "(anchor: …)" value from your preceding Read of this file.' +
            (lineAnchorsEnabled()
              ? ' (Or anchor-qualify EVERY hunk\'s lines from a line_anchors read — "12#ab3f" — and the line anchors themselves are the staleness contract.)'
              : ''),
          errorCode: 13,
        }
      }
    }

    const expandedPath = expandPath(input.file_path)

    // 2. Secret guard (bare refusal — no behavior hint, deliberately).
    const proposedBodies = usingHunks
      ? (input.hunks ?? []).map(hunk => hunk.replace)
      : [input.new_string ?? '']
    for (const body of proposedBodies) {
    }

    const oldString = input.old_string ?? ''
    const newString = input.new_string ?? ''

    // 3. Identity refusal (exact lane only).
    const { old_string, new_string } = input
    if (!usingHunks && old_string === new_string) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'old_string and new_string are identical — there is no edit to apply.',
        errorCode: 1,
      }
    }

    // 4. Edit-deny rules.
    const permissionContext = context.getAppState().toolPermissionContext
    if (matchingRuleForInput(expandedPath, permissionContext, 'edit', 'deny')) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `Editing ${input.file_path} is denied by permission settings.`,
        errorCode: 2,
      }
    }

    // 5. UNC short-circuit: zero filesystem calls (SMB credential leak).
    if (input.file_path.startsWith('\\\\') || input.file_path.startsWith('//')) {
      return { result: true as const }
    }

    // 6. Size guard: a 1 GiB stat proxy for the runtime's string ceiling.
    try {
      const stats = await stat(expandedPath)
      if (stats.size > ONE_GIB) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `File is too large to edit (${formatFileSize(stats.size)}; the maximum is ${formatFileSize(ONE_GIB)}).`,
          errorCode: 10,
        }
      }
    } catch (err) {
      if (!isENOENT(err)) throw err
    }

    // 7. Read and decode the current content.
    let fileExists = true
    let currentContent = ''
    let decodeLossless = true
    try {
      const buffer = await readFile(expandedPath)
      const decoded = decodeFileBuffer(buffer)
      currentContent = decoded.content
      decodeLossless = decoded.lossless
    } catch (err) {
      if (!isENOENT(err)) throw err
      fileExists = false
    }
    // 7b. The decode must be lossless, or the write-back destroys bytes the
    // edit never touched — refuse with the move (the S1's own kill).
    if (fileExists && !decodeLossless) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: LOSSY_DECODE_MESSAGE,
        errorCode: 14,
      }
    }

    // 8. Nonexistent file.
    if (!fileExists) {
      if (!usingHunks && oldString === '') {
        return { result: true as const } // file creation
      }
      const suggestion = await notFoundSuggestionSentence(expandedPath)
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion}`,
        errorCode: 4,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }

    // 9. Existing file with an empty old string.
    if (!usingHunks && oldString === '') {
      if (currentContent.trim() !== '') {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message:
            'Cannot create a new file — a file already exists at this path with content in it.',
          errorCode: 3,
        }
      }
      return { result: true as const } // creation over an empty file
    }

    // 10. Notebook guard.
    if (expandedPath.toLowerCase().endsWith('.ipynb')) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'Use the NotebookEdit tool to edit Jupyter notebooks.',
        errorCode: 5,
      }
    }

    // 11. Read-knowledge.
    const entry = context.readFileState.get(expandedPath)
    if (!entry || entry.isPartialView) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: 'Read the file before editing it — the edit needs a prior read of the current content.',
        errorCode: 6,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }

    // 12. Staleness with the two content-identity fallbacks.
    if (
      await staleAtValidation(entry, expandedPath, currentContent, context.abortController.signal)
    ) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: FILE_UNEXPECTEDLY_MODIFIED_ERROR,
        errorCode: 7,
      }
    }

    // 13. Anchor check — before any string match, so a drifted file gets the
    //     actionable stale answer rather than "string not found". A stale
    //     anchor on the hunks lane first attempts the bounded relocation
    //     (FN-013 LOOP-03 — attemptStaleHunkRecovery; any weaker case falls
    //     through to today's typed refusal unchanged).
    let recoveredHunks: EditHunkInput[] | undefined
    let recoveredAnchor: string | undefined
    if (changeTransactionEnabled() && input.expected_anchor) {
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

    // 14. Hunks-lane planning + settings validation on the simulated result
    //     (planned over the BOM-stripped body; the mark re-attaches on the
    //     simulated and real writes alike).
    if (usingHunks) {
      const { bom, body } = splitLeadingBom(currentContent)
      const plan = planHunks(body, recoveredHunks ?? (input.hunks as EditHunkInput[]), recoveredAnchor ?? input.expected_anchor)
      if (!plan.ok) {
        return {
          result: false as const,
          behavior: 'ask' as const,
          message: `${plan.message} Nothing was written.`,
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

    // 15. Exact-string matching with quote normalisation.
    const actualOldString = findActualString(currentContent, oldString)
    if (actualOldString === null) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message: `The old_string was not found in the file.\nString: ${oldString}`,
        errorCode: 8,
        meta: { isPathAbsolute: String(isAbsolute(input.file_path)) },
      }
    }
    const occurrences = currentContent.split(actualOldString).length - 1
    if (occurrences > 1 && !input.replace_all) {
      return {
        result: false as const,
        behavior: 'ask' as const,
        message:
          `Found ${occurrences} matches of the string to replace, but replace_all is false. ` +
          `To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to uniquely identify the instance.\nString: ${oldString}`,
        errorCode: 9,
        meta: { oldString, actualOldString },
      }
    }

    // 16. Settings-file validation against the exact simulated edit.
    const preservedNewString = preserveQuoteStyle(oldString, actualOldString, newString)
    const settingsRefusal = validateInputForSettingsFileEdit(expandedPath, currentContent, () =>
      applyEditToFile(currentContent, actualOldString, preservedNewString, input.replace_all),
    )
    if (settingsRefusal !== null) {
      return { ...settingsRefusal, behavior: 'ask' as const }
    }

    // 17. Success, carrying the resolved actual match.
    return { result: true as const, meta: { actualOldString } }
  },
  async call(input: FileEditInput, context: ToolUseContext, _canUseTool, parentMessage) {
    const startedAt = Date.now()
    const expandedPath = expandPath(input.file_path)
    const usingHunks = hunksInUse(input)
    const anchorChecked = changeTransactionEnabled() && input.expected_anchor !== undefined

    // Skill discovery (skipped in simple mode), diagnostics baseline, parent
    // directory, and the idempotent pre-edit backup — all OUTSIDE the atomic
    // section (each await is an interleaving window; the backup is
    // content-keyed, so an unused one after a refusal is harmless).
    if (!isEnvTruthy(process.env.MERCURY_SIMPLE)) {
      await discoverSkillsForPath(context, expandedPath)
    }
    await diagnosticTracker.beforeFileEdited(expandedPath)
    const parentDir = expandedPath.split(/[\\/]/).slice(0, -1).join('/')
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

    // ── atomic section: no asynchronous work from here to the write ──────
    let freshContent = ''
    let rawBefore = ''
    let fileExists = true
    let encoding: BufferEncoding = 'utf8'
    let lineEndings: LineEndingType = 'LF'
    try {
      const metadata = readFileSyncWithMetadata(expandedPath)
      // The write door's own belt (validation refused already at 7b): a
      // lossy decode written back destroys bytes the edit never touched.
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

    // Re-check staleness against the fresh content (full-read fallback only;
    // a missing entry is fatal here, unlike validation).
    if (fileExists) {
      const entry = context.readFileState.get(expandedPath)
      const intact =
        entry !== undefined &&
        (getFileModificationTime(expandedPath) <= entry.timestamp ||
          (isFullReadEntry(entry) && entry.content === freshContent))
      if (!intact) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
    }

    // Re-verify the carried anchor — closes the validation→execution window.
    // The same relocation the validate stage ran (FN-013 LOOP-03): pure
    // over (anchor, ring, content), so both stages answer identically on
    // unchanged input, and a change INSIDE the window still throws today's
    // refusal here.
    let effectiveHunks = input.hunks as EditHunkInput[] | undefined
    let effectiveAnchor = input.expected_anchor
    let staleRecoveryNote: string | undefined
    if (anchorChecked && input.expected_anchor) {
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

    // Compute the updated content and the display patch.
    let updatedFile: string
    let patch: ReturnType<typeof getPatchFromContents>
    let reportedOldString: string
    let reportedNewString: string
    let freshLineAnchors: string | undefined
    if (usingHunks) {
      const { bom, body } = splitLeadingBom(freshContent)
      const plan = planHunks(body, effectiveHunks as EditHunkInput[], effectiveAnchor)
      if (!plan.ok) {
        throw new Error(`${plan.message} Nothing was written.`)
      }
      // All hunks apply atomically: one write, one effect, one receipt.
      updatedFile = bom + applyHunks(body, plan)
      // The chaining answer: a call that addressed by anchor gets the
      // touched regions re-anchored against the UPDATED content in its own
      // result — the next anchored edit needs no re-read for the shift
      // this one caused. Plain-spelling calls keep today's result bytes.
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
    } else {
      const oldString = input.old_string ?? ''
      const newString = input.new_string ?? ''
      const actualOldString = findActualString(freshContent, oldString) ?? oldString
      const preserved = preserveQuoteStyle(oldString, actualOldString, newString)
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
    }

    const userModified = context.userModifiedInput === true
    const replaceAll = input.replace_all ?? false

    // No-change settlement: byte-identical result ⇒ zero writes, zero
    // notifications, read-state untouched, no mutation analytics.
    if (updatedFile === freshContent) {
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
          : [reportedOldString, reportedNewString, replaceAll],
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
      }
      return {
        data,
        effect: {
          outcome: 'no-change' as const,
          operation: 'file.edit',
          changedPaths: [],
          evidence: usingHunks
            ? 'hunks lane: the planned result is byte-identical to the current content'
            : 'exact-string lane: the computed result is byte-identical to the current content',
          startedAt,
          completedAt: Date.now(),
          details: { anchorChecked },
        },
      }
    }

    // Write, preserving the file's existing encoding and line endings —
    // PER LINE: untouched lines keep their exact terminator (a mixed file
    // must not be homogenised by a one-word edit, FC-017); only the changed
    // region takes the majority style. The reconciled string carries its
    // endings literally, so the writer takes the pass-through 'LF' arm.
    const reconciled = fileExists
      ? preserveUntouchedLineEndings(rawBefore, updatedFile, lineEndings)
      : updatedFile
    writeTextContent(expandedPath, reconciled, encoding, fileExists ? 'LF' : lineEndings)

    // Downstream notifications, in order: diagnostics clear + the SEQUENCED
    // change-then-save composite (both inside the manager guard; failures
    // logged, never thrown), then the unconditional editor notification.
    const lspManager = getLspServerManager()
    if (lspManager) {
      try {
        clearDeliveredDiagnosticsForFile(`file://${expandedPath}`)
        await lspManager.changeAndSaveFile(expandedPath, updatedFile)
      } catch (err) {
        logError(err)
      }
    }
    notifyVscodeFileUpdated(expandedPath, freshContent, updatedFile)

    // Refresh read-state with cleared window fields.
    context.readFileState.set(expandedPath, {
      content: updatedFile,
      timestamp: getFileModificationTime(expandedPath),
      offset: undefined,
      limit: undefined,
    })

    countLinesChanged(patch, fileExists ? undefined : updatedFile)
    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: expandedPath,
      content: updatedFile,
    })

    // (There is no remote-gated single-file git-diff attachment —
    // Mercury never runs as a hosted remote; gitDiff stays
    // absent.)
    const gitDiff: Output['gitDiff'] = undefined

    const { added, removed } = patchLineCounts(patch)
    const hunkCount = usingHunks ? (input.hunks as EditHunkInput[]).length : 0
    const data: Output = {
      filePath: expandedPath,
      oldString: reportedOldString,
      newString: reportedNewString,
      originalFile: freshContent,
      structuredPatch: patch,
      userModified,
      replaceAll,
      ...(gitDiff !== undefined ? { gitDiff } : {}),
      ...(freshLineAnchors !== undefined ? { freshLineAnchors } : {}),
      ...(staleRecoveryNote !== undefined ? { staleRecovery: staleRecoveryNote } : {}),
    }
    return {
      data,
      effect: {
        outcome: 'succeeded' as const,
        operation: 'file.edit',
        changedPaths: [expandedPath],
        evidence: usingHunks
          ? `applied ${hunkCount} anchored hunk(s): +${added}/-${removed} lines${staleRecoveryNote !== undefined ? ` · ${staleRecoveryNote}` : ''}`
          : `exact-string lane: +${added}/-${removed} lines`,
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
        content: text,
        // At the repetition ceiling the model sees an error while the
        // internal effect stays a truthful no-change.
        ...(data.noChange.stop ? { is_error: true } : {}),
      }
    }
    const modifiedClause = data.userModified ? ' (the user modified the change before accepting it)' : ''
    const recoveredClause = data.staleRecovery !== undefined ? ` Your hunks were relocated because the file changed since your read (${data.staleRecovery}) — re-read before further anchored edits.` : ''
    const text = data.replaceAll
      ? `The file ${data.filePath} has been updated${modifiedClause}. All occurrences of the string were replaced.${recoveredClause}`
      : `The file ${data.filePath} has been updated successfully${modifiedClause}.${recoveredClause}`
    // Anchor-addressed calls carry their chaining answer; every other
    // lane's result text is byte-identical to the pre-hashline surface.
    const content = data.freshLineAnchors !== undefined ? `${text}\n\n${data.freshLineAnchors}` : text
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
