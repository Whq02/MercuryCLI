import { stat } from 'node:fs/promises'
import { closeSync, openSync, readSync } from 'node:fs'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'
import {
  addAnchoredLineNumbers,
  lineAnchorsEnabled,
} from '../../services/changeTransaction/lineAnchors.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { rememberAnchoredSnapshot } from '../../services/changeTransaction/snapshotRing.js'
import {
  mintFileAnchor,
  mintRangeAnchor,
} from '../../services/changeTransaction/snapshotAnchor.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from '../../services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import { hasBinaryExtension } from '../../constants/files.js'
import { PDF_TARGET_RAW_SIZE } from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { formatFileSize } from '../../utils/format.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
  type ImageDimensions,
} from '../../utils/imageResizer.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { isAutoMemFile } from '../../utils/memoryFileDetection.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { mapNotebookCellsToToolResult, readNotebook } from '../../utils/notebook.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool, matchingRuleForInput } from '../../utils/permissions/filesystem.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { extractPDFPages, getPDFPageCount, readPDF } from '../../utils/pdf.js'
import { isPDFExtension, isPDFSupported, parsePDFPageRange } from '../../utils/pdfUtils.js'
import { resolveModelCapabilities } from '../../utils/model/capabilities.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import type { Message } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import { getDefaultFileReadingLimits, type FileReadingLimits } from './limits.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  LINE_FORMAT_INSTRUCTION_LEGACY,
  MAX_LINES_TO_READ,
  MAX_PDF_PAGES_PER_REQUEST,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  renderPromptTemplate,
} from './prompt.js'
import {
  classifyReadTarget,
  isDirectoryTarget,
  readTargetPromptLines,
  readTargetsEnabled,
  renderDirectoryTarget,
  renderResourceTarget,
  renderUrlDelegation,
} from './readTarget.js'
import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

/**
 * The Read tool: the model's single front door onto file content — text
 * with line numbers, images, PDFs, notebooks, and (capability-gated)
 * directories, resources and URL delegations — under strict byte and token
 * budgets, recording what the model has seen so later writes can be proven
 * safe.
 */

// ── input ───────────────────────────────────────────────────────────────────

const stockFields = () => ({
  file_path: z.string().describe('Absolute path of the file to open'),
  offset: semanticNumber(z.number().int().min(0).optional()).describe(
    'The line number reading starts from; pass it only when the whole file is too large for a single read',
  ),
  limit: semanticNumber(z.number().int().gt(0).optional()).describe(
    'The maximum number of lines to return; pass it only when the whole file is too large for a single read.',
  ),
  pages: z
    .string()
    .optional()
    .describe(
      `Page range for PDF files (e.g., "2-6", "9", "12-24"). Only applicable to PDF files. Maximum ${MAX_PDF_PAGES_PER_REQUEST} pages per request.`,
    ),
})

/** The widest (anchor-capable) shape — the static type derives from this. */
const anchoredSchemaFactory = () =>
  z.strictObject({
    ...stockFields(),
    line_anchors: semanticBoolean(z.boolean().optional()).describe(
      'Set true to stamp each text line prefix with its content anchor ("N#hhhh") — the copyable address for anchor-qualified Edit hunks. Off, the output is the plain numbered form.',
    ),
  })

type WidestReadSchema = ReturnType<typeof anchoredSchemaFactory>

/**
 * The runtime input schema, gate-selected at first materialisation (the
 * Edit tool's pattern): the widest static type asserted over the strictly
 * more restrictive stock shape when the hashline layer is off.
 */
const inputSchema = lazySchema((): WidestReadSchema =>
  lineAnchorsEnabled()
    ? anchoredSchemaFactory()
    : (z.strictObject(stockFields()) as unknown as WidestReadSchema),
)

/** An empty or whitespace-only page selection reads as ABSENT (the whole
 *  file), not as an invalid range: `pages: ""` means "no page selection". */
function selectedPages(pages: string | undefined): string | undefined {
  return pages && pages.trim() !== '' ? pages : undefined
}

export type Input = z.infer<WidestReadSchema>

// ── output ──────────────────────────────────────────────────────────────────

export type Output =
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
        /** The staleness anchor the rendered result carries as its
         *  "(anchor: …)" tail — a field, so a persisted result re-renders
         *  byte-identical (an @-mentioned file rides every later request). */
        anchor?: string
        /** An auto-memory file's modification time, rendered as the
         *  "(memory file — last updated …)" prefix; a field for the same reason. */
        memoryUpdatedAt?: number
      }
    }
  | {
      type: 'image'
      file: {
        base64: string
        type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        originalSize: number
        dimensions?: ImageDimensions
      }
    }
  | { type: 'notebook'; file: { filePath: string; cells: unknown[] } }
  | { type: 'pdf'; file: { filePath: string; base64: string; originalSize: number } }
  | {
      type: 'parts'
      file: { filePath: string; originalSize: number; count: number; outputDir: string }
    }
  | { type: 'file_unchanged'; file: { filePath: string } }

// Resumed transcripts guard persisted results through this schema before
// rendering. Everything the rendered result's BYTES depend on is a schema
// field (the anchor tail, the memory-freshness prefix): a persisted
// @-mention result is re-rendered on every later request, and a value held
// only on the live object's identity would vanish on a resume and rewrite a
// sent turn — the preserved-thinking check then drops every thinking block
// after it. Paint-only options stay off the schema (it flows into
// published SDK types).
const outputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    file: z.object({
      filePath: z.string(),
      content: z.string(),
      numLines: z.number(),
      startLine: z.number(),
      totalLines: z.number(),
      anchor: z.string().optional(),
      memoryUpdatedAt: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal('image'),
    file: z.object({
      base64: z.string(),
      type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      originalSize: z.number(),
      dimensions: z
        .object({
          originalWidth: z.number().optional(),
          originalHeight: z.number().optional(),
          displayWidth: z.number().optional(),
          displayHeight: z.number().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('notebook'),
    file: z.object({ filePath: z.string(), cells: z.array(z.unknown()) }),
  }),
  z.object({
    type: z.literal('pdf'),
    file: z.object({ filePath: z.string(), base64: z.string(), originalSize: z.number() }),
  }),
  z.object({
    type: z.literal('parts'),
    file: z.object({
      filePath: z.string(),
      originalSize: z.number(),
      count: z.number(),
      outputDir: z.string(),
    }),
  }),
  z.object({ type: z.literal('file_unchanged'), file: z.object({ filePath: z.string() }) }),
])

// ── side channels (paint-only options, never fields on the output schema) ──

/** Results whose text rows carry per-line anchors (the opt-in read mode). */
const resultLineAnchors = new WeakSet<object>()

// ── file-read listeners ─────────────────────────────────────────────────────

type FileReadListener = (filePath: string, content: string) => void

const fileReadListeners = new Set<FileReadListener>()

/** Register a listener; the returned unsubscriber is safe to call during a
 *  callback (notification iterates a snapshot). */
export function registerFileReadListener(listener: FileReadListener): () => void {
  fileReadListeners.add(listener)
  return () => {
    fileReadListeners.delete(listener)
  }
}

function notifyFileReadListeners(filePath: string, content: string): void {
  for (const listener of [...fileReadListeners]) {
    try {
      listener(filePath, content)
    } catch (err) {
      logError(err)
    }
  }
}

// ── token validation ────────────────────────────────────────────────────────

/** Catchable by name from outside this slice (attachment building). */
export class MaxFileReadTokenExceededError extends Error {
  readonly tokenCount: number
  readonly maxTokens: number

  constructor(tokenCount: number, maxTokens: number) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). ` +
        `Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
    this.tokenCount = tokenCount
    this.maxTokens = maxTokens
  }
}

/**
 * Cheap estimate first; a provider count only when the estimate exceeds a
 * quarter of the cap, falling back to the estimate when unavailable.
 */
async function validateContentTokens(content: string, ext: string, maxTokens: number): Promise<void> {
  const estimate = roughTokenCountEstimationForFileType(content, ext)
  if (!estimate || estimate <= maxTokens / 4) return
  let effective = estimate
  try {
    const accurate = await countTokensWithAPI(content)
    if (accurate !== null) effective = accurate
  } catch {
    // Keep the estimate.
  }
  if (effective > maxTokens) {
    throw new MaxFileReadTokenExceededError(effective, maxTokens)
  }
}

// ── cyber-risk reminder ─────────────────────────────────────────────────────

/** Referenced by other surfaces; blank lines both sides are part of the value. */
export const CYBER_RISK_MITIGATION_REMINDER = `

<system-reminder>
Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.
</system-reminder>
`

/** Canonical short names exempt from the reminder — contract data. */
const CYBER_RISK_REMINDER_EXEMPT_MODELS = new Set(['claude-opus-4-6'])

function cyberRiskReminderFor(mainLoopModel: string): string {
  try {
    if (CYBER_RISK_REMINDER_EXEMPT_MODELS.has(getCanonicalName(mainLoopModel))) return ''
  } catch {
    // An unresolvable model keeps the reminder.
  }
  return CYBER_RISK_MITIGATION_REMINDER
}

// ── validation data ─────────────────────────────────────────────────────────

/** Contract data: paths that would hang or stream forever. `/dev/null` is
 *  deliberately absent. */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

const BLOCKED_PROC_FD_PATTERN = /^\/proc\/.+\/fd\/[012]$/

function isBlockingDevicePath(path: string): boolean {
  return BLOCKED_DEVICE_PATHS.has(path) || BLOCKED_PROC_FD_PATTERN.test(path)
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

function extensionOf(rawPath: string): string {
  const base = rawPath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

// ── screenshot-name retry ───────────────────────────────────────────────────

const SCREENSHOT_NAME_PATTERN = /^([\s\S]*)([  ])(AM|PM)(\.png)$/

/** The same name with the other space variant, when the shape applies. */
function alternateScreenshotPath(path: string): string | null {
  const match = SCREENSHOT_NAME_PATTERN.exec(path)
  if (!match) return null
  const alternate = match[2] === ' ' ? ' ' : ' '
  return `${match[1]}${alternate}${match[3]}${match[4]}`
}

async function friendlyNotFoundError(requestedPath: string, expandedPath: string): Promise<Error> {
  let suggestion: string | undefined
  try {
    suggestion = await suggestPathUnderCwd(expandedPath)
  } catch {
    suggestion = undefined
  }
  if (suggestion === undefined) {
    const similar = findSimilarFile(expandedPath)
    if (similar !== undefined) suggestion = similar
  }
  let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
  if (suggestion) message += ` Did you mean ${suggestion}?`
  return new Error(message)
}

// ── image reading ───────────────────────────────────────────────────────────

const IMAGE_TOKEN_BUDGET_DEFAULT = 25000

type ImageOutput = Extract<Output, { type: 'image' }>

/**
 * The budget-aware image reader: one read of the bytes, magic-byte format
 * detection, a standard resize/downsample attempt, then aggressive
 * compression from the same buffer when the token estimate overruns the
 * budget. Both over-budget paths drop the dimension metadata.
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = IMAGE_TOKEN_BUDGET_DEFAULT,
  maxBytes?: number,
): Promise<ImageOutput> {
  const fsImpl = getFsImplementation()
  const buffer = fsImpl.readFileBytesSync
    ? fsImpl.readFileBytesSync(filePath)
    : (await import('node:fs')).readFileSync(filePath)
  if (buffer.length === 0) {
    throw new Error(`Empty image file (zero bytes): ${filePath}`)
  }
  const detected = detectImageFormatFromBuffer(buffer)
  const detectedSubtype = detected.split('/')[1] || 'png'

  let resized: { buffer: Buffer; mediaType: string; dimensions?: ImageDimensions }
  try {
    resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, detectedSubtype)
  } catch (err) {
    if (err instanceof ImageResizeError) throw err
    logError(err)
    resized = { buffer, mediaType: detectedSubtype }
  }

  const base64 = resized.buffer.toString('base64')
  const estimatedTokens = Math.ceil(base64.length / 8)
  const overTokenBudget = estimatedTokens > maxTokens
  const overByteBudget = maxBytes !== undefined && resized.buffer.length > maxBytes

  if (!overTokenBudget && !overByteBudget) {
    return {
      type: 'image',
      file: {
        base64,
        type: `image/${resized.mediaType}` as ImageOutput['file']['type'],
        originalSize: buffer.length,
        ...(resized.dimensions ? { dimensions: resized.dimensions } : {}),
      },
    }
  }

  // Over budget: compress aggressively FROM THE SAME BUFFER (no re-read);
  // dimensions are dropped on every over-budget path.
  try {
    const compressed = await compressImageBufferWithTokenLimit(buffer, maxTokens, detected)
    return {
      type: 'image',
      file: {
        base64: compressed.base64,
        type: compressed.mediaType as ImageOutput['file']['type'],
        originalSize: buffer.length,
      },
    }
  } catch (err) {
    logError(err)
  }
  try {
    const { getImageProcessor } = await import('./imageProcessor.js')
    const sharp = await getImageProcessor()
    const lastResort = await sharp(buffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer()
    return {
      type: 'image',
      file: {
        base64: lastResort.toString('base64'),
        type: 'image/jpeg',
        originalSize: buffer.length,
      },
    }
  } catch (err) {
    logError(err)
    return {
      type: 'image',
      file: {
        base64,
        type: `image/${resized.mediaType}` as ImageOutput['file']['type'],
        originalSize: buffer.length,
      },
    }
  }
}

// ── lanes ───────────────────────────────────────────────────────────────────

type LaneResult = { data: Output; newMessages?: Message[] }

async function readNotebookLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  context: ToolUseContext,
  limits: FileReadingLimits,
): Promise<LaneResult> {
  const cells = await readNotebook(resolvedPath)
  const serialized = JSON.stringify(cells)
  const serializedBytes = Buffer.byteLength(serialized, 'utf8')
  if (serializedBytes > limits.maxSizeBytes) {
    throw new Error(
      `Notebook content (${formatFileSize(serializedBytes)}) exceeds the maximum allowed size (${formatFileSize(limits.maxSizeBytes)}). Read a slice of the notebook from the shell instead, e.g.:
- first 10 cells: jq '.cells[:10]' "${resolvedPath}"
- a cell range: jq '.cells[10:20]' "${resolvedPath}"
- the cell count: jq '.cells | length' "${resolvedPath}"
- all code sources: jq -r '.cells[] | select(.cell_type=="code") | .source[]' "${resolvedPath}"`,
    )
  }
  await validateContentTokens(serialized, 'ipynb', limits.maxTokens)
  const timestamp = getFileModificationTime(resolvedPath)
  context.readFileState.set(keyPath, {
    content: serialized,
    timestamp,
    offset: input.offset ?? 0,
    limit: input.limit,
  })
  context.nestedMemoryAttachmentTriggers?.add(keyPath)
  logFileOperation({ operation: 'read', tool: 'FileReadTool', filePath: resolvedPath, content: serialized })
  return { data: { type: 'notebook', file: { filePath: resolvedPath, cells } } }
}

async function readImageLane(
  resolvedPath: string,
  keyPath: string,
  context: ToolUseContext,
  limits: FileReadingLimits,
): Promise<LaneResult> {
  // The text byte cap does not apply to images; they have their own budget.
  const data = await readImageWithTokenBudget(resolvedPath, limits.maxTokens)
  context.nestedMemoryAttachmentTriggers?.add(keyPath)
  logFileOperation({ operation: 'read', tool: 'FileReadTool', filePath: resolvedPath })
  const newMessages: Message[] = []
  if (data.file.dimensions) {
    const metadataText = createImageMetadataText(data.file.dimensions, resolvedPath)
    if (metadataText) {
      newMessages.push(createUserMessage({ content: metadataText, isMeta: true }))
    }
  }
  return { data, newMessages: newMessages.length > 0 ? newMessages : undefined }
}

async function readPdfLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  context: ToolUseContext,
): Promise<LaneResult> {
  const pages = selectedPages(input.pages)
  if (pages !== undefined) {
    const range = parsePDFPageRange(pages)
    // Validation guarantees a parseable in-cap range; defend anyway.
    const extraction = await extractPDFPages(resolvedPath, {
      firstPage: range?.firstPage,
      lastPage: range?.lastPage,
    })
    if (!extraction.success) {
      throw new Error(extraction.error.message)
    }
    logFileOperation({ operation: 'read', tool: 'FileReadTool', filePath: resolvedPath })
    const outputDir = extraction.data.file.outputDir
    const entries = getFsImplementation()
      .readdirSync(outputDir)
      .map(entry => (typeof entry === 'string' ? entry : (entry as { name: string }).name))
      .filter(name => name.endsWith('.jpg'))
      .sort()
    const blocks: ContentBlockParam[] = []
    for (const name of entries) {
      try {
        const pageBuffer = (await import('node:fs')).readFileSync(`${outputDir}/${name}`)
        const resized = await maybeResizeAndDownsampleImageBuffer(pageBuffer, pageBuffer.length, 'jpeg')
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: `image/${resized.mediaType}`,
            data: resized.buffer.toString('base64'),
          },
        } as ContentBlockParam)
      } catch (err) {
        logError(err)
      }
    }
    const data: Output = {
      type: 'parts',
      file: {
        filePath: resolvedPath,
        originalSize: extraction.data.file.originalSize,
        count: entries.length,
        outputDir,
      },
    }
    context.nestedMemoryAttachmentTriggers?.add(keyPath)
    if (blocks.length > 0) {
      return { data, newMessages: [createUserMessage({ content: blocks, isMeta: true })] }
    }
    return { data }
  }

  const pageCount = await getPDFPageCount(resolvedPath)
  if (pageCount !== null && pageCount > 10) {
    throw new Error(
      `This PDF has ${pageCount} pages. Use the \`pages\` parameter to read up to ${MAX_PDF_PAGES_PER_REQUEST} pages at a time (e.g. pages: "1-${MAX_PDF_PAGES_PER_REQUEST}").`,
    )
  }
  const stats = await stat(resolvedPath)
  const turnModel = context.options.mainLoopModel
  const pdfSupported = isPDFSupported(turnModel)
  if (!pdfSupported || stats.size > PDF_TARGET_RAW_SIZE) {
    // Run page extraction for its side effect; the outcome is ignored.
    await extractPDFPages(resolvedPath).catch(() => undefined)
  }
  if (!pdfSupported) {
    // The pages fallback delivers page IMAGES — only offer it where image
    // blocks actually reach the model (the capability record's call).
    const pagesFallback = resolveModelCapabilities(turnModel).media.images
      ? `, or use the \`pages\` parameter to read up to ${MAX_PDF_PAGES_PER_REQUEST} pages at a time as images`
      : ` (image-based page reading is also unavailable on this model — extract the text with a shell tool such as \`pdftotext\` instead)`
    throw new Error(
      `Reading a whole PDF inline is not supported for the current model — switch to a model that takes PDF input${pagesFallback}. Page extraction requires the poppler tools (macOS: \`brew install poppler\`; Debian/Ubuntu: \`sudo apt-get install poppler-utils\`).`,
    )
  }
  const result = await readPDF(resolvedPath)
  if (!result.success) {
    throw new Error(result.error.message)
  }
  logFileOperation({ operation: 'read', tool: 'FileReadTool', filePath: resolvedPath })
  context.nestedMemoryAttachmentTriggers?.add(keyPath)
  const documentBlock = {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: result.data.file.base64,
    },
  } as unknown as ContentBlockParam
  return {
    data: result.data,
    newMessages: [createUserMessage({ content: [documentBlock], isMeta: true })],
  }
}

async function readTextLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  ext: string,
  context: ToolUseContext,
  limits: FileReadingLimits,
): Promise<LaneResult> {
  const lineOffset = Math.max(0, (input.offset ?? 1) - 1)
  const maxLines = input.limit ?? MAX_LINES_TO_READ
  // A UTF-16BE BOM is a crisp, two-byte fact the read door must speak
  // BEFORE showing content (FC-092): decoded as UTF-8 the file is pure
  // mojibake with an edit anchor minted for it, and the Edit door then
  // refuses the same file for its lossy decode — the operator learned the
  // file was unreadable only AFTER being shown its contents. The refusal
  // teaches the same conversion the write doors teach; UTF-16LE (which the
  // decoder speaks) and BOM-less files are untouched.
  {
    const bom = Buffer.alloc(2)
    try {
      const fd = openSync(resolvedPath, 'r')
      try {
        readSync(fd, bom, 0, 2, 0)
      } finally {
        closeSync(fd)
      }
    } catch {
      /* unreadable here means the range read below speaks the real error */
    }
    if (bom[0] === 0xfe && bom[1] === 0xff) {
      throw new Error(
        'File is UTF-16BE (big-endian BOM): reading it as text yields replacement characters, and the edit doors refuse its lossy decode. Convert it first (for example `iconv -f utf-16be -t utf-8`), or read it with a shell command.',
      )
    }
  }
  // The byte cap applies only when no explicit line window was requested.
  const maxBytes = input.limit === undefined ? limits.maxSizeBytes : undefined
  const range = await readFileInRange(
    resolvedPath,
    lineOffset,
    maxLines,
    maxBytes,
    context.abortController.signal,
  )
  await validateContentTokens(range.content, ext, limits.maxTokens)

  // A read that covered the whole file is a FULL read whatever window the
  // caller asked for: the post-compact restore passes a line budget as
  // `limit`, and recording it verbatim made every restored entry a partial
  // window — the edit path's content-identity fallback (a full-read entry
  // passes on equal bytes when only the mtime moved) was disabled for
  // exactly those files, so an edit admitted at validation failed at
  // execution for a file nobody changed (FN-015 rank 59).
  const coveredWholeFile =
    lineOffset === 0 && range.lineCount === range.totalLines && range.readBytes === range.totalBytes
  context.readFileState.set(keyPath, {
    content: range.content,
    timestamp: Math.floor(range.mtimeMs),
    offset: coveredWholeFile ? 0 : (input.offset ?? 0),
    limit: coveredWholeFile ? undefined : input.limit,
  })
  context.nestedMemoryAttachmentTriggers?.add(keyPath)
  notifyFileReadListeners(resolvedPath, range.content)

  // The values the rendered result's bytes depend on are minted BEFORE the
  // result and ride it as fields (the Output doc): a persisted result must
  // re-render byte-identical on every later request.
  const memoryUpdatedAt = isAutoMemFile(resolvedPath) ? Math.floor(range.mtimeMs) : undefined
  let anchor: string | undefined
  if (changeTransactionEnabled() && range.content.length > 0) {
    const wholeFile =
      lineOffset === 0 &&
      range.lineCount === range.totalLines &&
      range.readBytes === range.totalBytes
    anchor = wholeFile
      ? mintFileAnchor(range.content)
      : mintRangeAnchor(range.content, lineOffset + 1, range.lineCount)
  }
  const data: Output = {
    type: 'text',
    file: {
      filePath: resolvedPath,
      content: range.content,
      numLines: range.lineCount,
      startLine: input.offset ?? 1,
      totalLines: range.totalLines,
      ...(anchor !== undefined ? { anchor } : {}),
      ...(memoryUpdatedAt !== undefined ? { memoryUpdatedAt } : {}),
    },
  }

  // The opt-in anchored presentation: a paint decision only — the recorded
  // read state, the anchor tail, and every other seam are the plain read's.
  if (lineAnchorsEnabled() && input.line_anchors === true && range.content.length > 0) {
    resultLineAnchors.add(data)
  }
  if (anchor !== undefined) {
    if (anchorPatchEnabled() || staleEditRecoveryEnabled()) {
      // The session evidence BOTH recovery lanes feed on: the snapshot ring
      // feeds stale-anchor recovery (the opt-in patch dialect AND, since
      // FN-013 LOOP-03, the default hunks path); the seen-lines ledger
      // records exactly which lines this read DISPLAYED.
      try {
        const owner = ownerFromToolUseContext(context)
        rememberAnchoredSnapshot(owner, anchor, range.content, resolvedPath)
        const generation = fileGeneration(resolvedPath)
        if (generation !== null) {
          recordSeenLines(owner, resolvedPath, generation, lineOffset + 1, range.lineCount)
        }
      } catch {
        // Evidence recording never breaks a read.
      }
    }
  }
  logFileOperation({ operation: 'read', tool: 'FileReadTool', filePath: resolvedPath, content: range.content })
  return { data }
}

// ── serialisation helpers ───────────────────────────────────────────────────

function serializeTextResult(file: Extract<Output, { type: 'text' }>['file'], data: object): string {
  if (file.content === '') {
    if (file.totalLines > 0 && file.startLine > file.totalLines) {
      return `<system-reminder>Warning: the file exists but is shorter than the requested offset. Read was requested to start at line ${file.startLine}, but the file has only ${file.totalLines} lines.</system-reminder>`
    }
    return '<system-reminder>Warning: the file exists but has empty contents.</system-reminder>'
  }
  const prefix =
    file.memoryUpdatedAt !== undefined
      ? `(memory file — last updated ${new Date(file.memoryUpdatedAt).toISOString()})\n`
      : ''
  const numbered = resultLineAnchors.has(data)
    ? addAnchoredLineNumbers({
        content: file.content,
        startLine: file.startLine,
        compact: isCompactLinePrefixEnabled(),
      })
    : addLineNumbers({ content: file.content, startLine: file.startLine })
  const anchorSuffix = file.anchor !== undefined ? `\n(anchor: ${file.anchor})` : ''
  return `${prefix}${numbered}${anchorSuffix}`
}

// ── the tool ────────────────────────────────────────────────────────────────

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  strict: true,
  // Persisting a read result to a file the model would then read back is
  // circular — read results are never persisted.
  maxResultSizeChars: Infinity,
  get inputSchema() {
    return inputSchema()
  },
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // The tool's own verdict: the read-permission ladder over the target path.
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    return checkReadPermissionForTool(FileReadTool, input, context.getAppState().toolPermissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    const summary = input ? getToolUseSummary(input) : null
    return summary ? `Reading ${summary}` : 'Reading a file'
  },
  toAutoClassifierInput(input: Input): string {
    return input.file_path
  },
  getPath(input: Partial<Input> | undefined): string {
    return input?.file_path || getCwd()
  },
  backfillObservableInput(input: Input): void {
    // Hook allowlists must see the expanded path — `~` and relative
    // spellings cannot bypass them.
    input.file_path = expandPath(input.file_path)
  },
  preparePermissionMatcher(input: Input) {
    // The RAW input path, as given — no expansion before rule matching.
    return (rulePattern: string): boolean =>
      matchWildcardPattern(rulePattern, input.file_path)
  },
  async description(): Promise<string> {
    let text = DESCRIPTION
    if (readTargetsEnabled()) {
      text +=
        ' Also reads directories (bounded listings), mercury:// resources, and routes http(s) URL targets to the WebFetch tool by name.'
      try {
        const { readSteeringLine } =
          require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
        const steering = readSteeringLine()
        if (steering) text += steering
      } catch {
        // A steering failure must never break the description.
      }
    }
    return text
  },
  async prompt(options?: { model?: string }): Promise<string> {
    const limits = getDefaultFileReadingLimits()
    const lineFormat =
      (isCompactLinePrefixEnabled() ? LINE_FORMAT_INSTRUCTION : LINE_FORMAT_INSTRUCTION_LEGACY) +
      (lineAnchorsEnabled()
        ? `; with \`line_anchors: true\` each prefix also carries the line's content anchor ("N#hhhh") — the exact address an anchor-qualified Edit hunk carries back`
        : '')
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. Files larger than ${formatFileSize(limits.maxSizeBytes)} error — use offset and limit to read slices`
      : ''
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    const targetLines = readTargetsEnabled() ? readTargetPromptLines() : undefined
    // The media lines state what is true for the model THIS text is sent
    // to; the capability record (route-derived) is the authority.
    const caps = resolveModelCapabilities(options?.model ?? getMainLoopModel())
    return renderPromptTemplate(
      lineFormat,
      maxSizeInstruction,
      offsetInstruction,
      { pdf: caps.media.pdf, images: caps.media.images },
      targetLines,
    )
  },
  async validateInput(input: Input, context: ToolUseContext) {
    // 1. Page range.
    const pages = selectedPages(input.pages)
    let parsedRange: { firstPage: number; lastPage: number } | null = null
    if (pages !== undefined) {
      parsedRange = parsePDFPageRange(pages)
      if (parsedRange === null) {
        return {
          result: false as const,
          message: `Invalid pages parameter: "${input.pages}". Accepted formats are a single page ("3") or an inclusive range ("1-5"). Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      const width = parsedRange.lastPage - parsedRange.firstPage + 1
      // An open-ended upper bound counts as over the cap.
      if (!Number.isFinite(width) || width > MAX_PDF_PAGES_PER_REQUEST) {
        return {
          result: false as const,
          message: `The requested page range spans more than the ${MAX_PDF_PAGES_PER_REQUEST}-page per-request maximum. Request at most ${MAX_PDF_PAGES_PER_REQUEST} pages at a time.`,
          errorCode: 8,
        }
      }
    }

    // 2. Non-file targets skip every filesystem check.
    if (readTargetsEnabled()) {
      const target = classifyReadTarget(input.file_path)
      if (target.kind === 'resource' || target.kind === 'url') {
        if (pages !== undefined) {
          return {
            result: false as const,
            message: 'The pages parameter applies to PDF files only.',
            errorCode: 7,
          }
        }
        return { result: true as const }
      }
    }

    const expanded = expandPath(input.file_path)

    // 3. Read-deny rules.
    const permissionContext = context.getAppState().toolPermissionContext
    if (matchingRuleForInput(expanded, permissionContext, 'read', 'deny')) {
      return {
        result: false as const,
        message: `Reading ${input.file_path} is denied by permission settings.`,
        errorCode: 1,
      }
    }

    // 4. UNC short-circuit: no filesystem call may touch such a path before
    //    permission is granted (SMB credential leak).
    if (input.file_path.startsWith('\\\\') || input.file_path.startsWith('//')) {
      return { result: true as const }
    }

    // 5. Binary extensions (no I/O). hasBinaryExtension takes the PATH —
    // its members carry their dots, and handing it the dotless ext made
    // the refusal unfireable for every extension (FC-091: a real .exe came
    // back as text with 524 replacement characters, is_error false).
    const ext = extensionOf(input.file_path)
    if (
      ext !== '' &&
      hasBinaryExtension(input.file_path) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext)
    ) {
      return {
        result: false as const,
        message: `This tool cannot read binary files, and .${ext} looks binary — reach for a tool built for that format instead.`,
        errorCode: 4,
      }
    }

    // 6. Blocking device files (path-string check only).
    if (isBlockingDevicePath(expanded)) {
      return {
        result: false as const,
        message: `Reading ${input.file_path} is not allowed: it is a device file that would hang or produce infinite output.`,
        errorCode: 9,
      }
    }

    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const limits: FileReadingLimits =
      (context.fileReadingLimits as FileReadingLimits | undefined) ?? getDefaultFileReadingLimits()
    const ext = extensionOf(input.file_path)
    const fullFilePath = expandPath(input.file_path)

    // Non-file target routing (string-only classification over the raw input).
    if (readTargetsEnabled()) {
      const target = classifyReadTarget(input.file_path)
      if (target.kind === 'resource') {
        const rendered = await renderResourceTarget(input.file_path.trim(), {
          owner: ownerFromToolUseContext(context),
          cwd: getCwd(),
          getAppState: context.getAppState,
        })
        return {
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        }
      }
      if (target.kind === 'url') {
        const rendered = renderUrlDelegation(input.file_path)
        return {
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        }
      }
      if (isDirectoryTarget(fullFilePath)) {
        const rendered = renderDirectoryTarget(fullFilePath)
        // Routed results never enter read-state: recording them would
        // duplicate content into attachments and mint edit anchors for
        // something that is not a file.
        return {
          data: {
            type: 'text',
            file: {
              filePath: input.file_path,
              content: rendered.content,
              numLines: rendered.numLines,
              startLine: 1,
              totalLines: rendered.numLines,
            },
          } satisfies Output,
        }
      }
    }

    // Dedup stub: a repeat of a prior Read of the same window on an
    // unmodified file answers `file_unchanged` without re-reading.
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'mercury_read_dedup_killswitch',
      false,
    )
    if (!dedupKillswitch) {
      const entry = context.readFileState.get(fullFilePath)
      if (
        entry &&
        entry.offset !== undefined && // entries written by Edit/Write have no offset
        !entry.isPartialView &&
        entry.offset === (input.offset ?? 0) &&
        entry.limit === input.limit
      ) {
        try {
          const stats = await stat(fullFilePath)
          if (Math.floor(stats.mtimeMs) === entry.timestamp) {
            return {
              data: { type: 'file_unchanged', file: { filePath: fullFilePath } } satisfies Output,
            }
          }
        } catch {
          // A stat failure falls through to a full read.
        }
      }
    }

    // Skill discovery: awaited; loading backgrounds; failures swallowed.
    if (!isEnvTruthy(process.env.MERCURY_SIMPLE)) {
      try {
        const dirs = await discoverSkillDirsForPaths([fullFilePath], getCwd())
        const fresh = dirs.filter(dir => !context.dynamicSkillDirTriggers?.has(dir))
        for (const dir of fresh) context.dynamicSkillDirTriggers?.add(dir)
        if (fresh.length > 0) {
          void Promise.resolve(addSkillDirectories(fresh)).catch(() => undefined)
        }
        activateConditionalSkillsForPaths([fullFilePath], getCwd())
      } catch (err) {
        logError(err)
      }
    }

    const dispatch = async (resolvedPath: string): Promise<LaneResult> => {
      if (ext === 'ipynb') return readNotebookLane(resolvedPath, fullFilePath, input, context, limits)
      if (IMAGE_EXTENSIONS.has(ext)) return readImageLane(resolvedPath, fullFilePath, context, limits)
      if (isPDFExtension(ext)) return readPdfLane(resolvedPath, fullFilePath, input, context)
      return readTextLane(resolvedPath, fullFilePath, input, ext, context, limits)
    }

    let lane: LaneResult
    try {
      lane = await dispatch(fullFilePath)
    } catch (err) {
      if (!isENOENT(err)) throw err
      const alternate = alternateScreenshotPath(fullFilePath)
      if (alternate !== null) {
        try {
          lane = await dispatch(alternate)
          return { data: lane.data, ...(lane.newMessages ? { newMessages: lane.newMessages } : {}) }
        } catch (retryErr) {
          // Only a second not-found falls through; other errors propagate.
          if (!isENOENT(retryErr)) throw retryErr
        }
      }
      throw await friendlyNotFoundError(input.file_path, fullFilePath)
    }
    return { data: lane.data, ...(lane.newMessages ? { newMessages: lane.newMessages } : {}) }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    switch (data.type) {
      case 'image':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: [
            {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: data.file.type,
                data: data.file.base64,
              },
            },
          ],
        }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells as never, toolUseID)
      case 'pdf':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `PDF file: ${data.file.filePath} (${formatFileSize(data.file.originalSize)}). The document content was provided alongside this result.`,
        }
      case 'parts':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `Extracted ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)}) as images.`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: FILE_UNCHANGED_STUB,
        }
      case 'text': {
        const body = serializeTextResult(data.file, data)
        if (data.file.content === '') {
          return { tool_use_id: toolUseID, type: 'tool_result' as const, content: body }
        }
        // The main-loop model is not reachable here; the exemption is
        // resolved through the model owner at serialisation call sites that
        // carry it. Default: reminder on.
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${body}${cyberRiskReminderForCurrentModel()}`,
        }
      }
    }
  },
  extractSearchText(): string {
    // The result card paints summary chrome only — indexing content would
    // produce phantom search hits.
    return ''
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})

/** The reminder for the live main-loop model (read at serialisation time). */
function cyberRiskReminderForCurrentModel(): string {
  try {
    const { getMainLoopModel } =
      require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
    return cyberRiskReminderFor(getMainLoopModel())
  } catch {
    return CYBER_RISK_MITIGATION_REMINDER
  }
}
