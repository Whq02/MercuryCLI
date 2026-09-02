/**
 * Shell output post-processing, shared by the Bash and PowerShell tools:
 * blank-line stripping (with CRLF normalisation), truncation with an honest
 * line count, base64 image data-URI handling, and the working-directory reset.
 */
import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { setCwd } from '../../utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { pathInAllowedWorkingPath } from '../../utils/permissions/filesystem.js'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
  ToolResultBlockParam,
} from '../../types/wire.js'

// ── blank-line stripping ────────────────────────

/**
 * Normalise CRLF and lone CR to LF (captured Windows shell output ends
 * every line with a carriage return, and a stray CR mis-paints the terminal
 * row), then drop leading and trailing all-whitespace lines. Interior blank
 * lines and leading whitespace on the first content line survive — this is not
 * `trim()`.
 */
export function stripEmptyLines(content: string): string {
  const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalised.split('\n')
  let start = 0
  let end = lines.length - 1
  while (start <= end && (lines[start] as string).trim() === '') start++
  while (end >= start && (lines[end] as string).trim() === '') end--
  if (start > end) return ''
  return lines.slice(start, end + 1).join('\n')
}

// ── image data-URI handling ──────────────────────────────────────────────────

const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+_-]+;base64,/i
const DATA_URI_RE = /^data:([^;]+);base64,([^\r\n]+)$/

/** Whether content begins with an image data URL. Case-insensitive. */
export function isImageOutput(content: string): boolean {
  return IMAGE_DATA_URL_RE.test(content)
}

/** Parse a `data:<mediaType>;base64,<payload>` URI (case-sensitive, anchored). */
export function parseDataUri(s: string): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match) return null
  return { mediaType: match[1] as string, data: match[2] as string }
}

/** Build an image tool-result block from data-URI stdout, or null. */
export function buildImageToolResult(stdout: string, toolUseID: string): ToolResultBlockParam | null {
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  const source: Base64ImageSource = {
    type: 'base64',
    data: parsed.data,
    media_type: parsed.mediaType as Base64ImageSource['media_type'],
  }
  const image: ImageBlockParam = { type: 'image', source }
  return { type: 'tool_result', tool_use_id: toolUseID, content: [image] }
}

/** The maximum data-URI size accepted for resize (a larger URI exhausts memory). Contract data. */
const MAX_IMAGE_DATA_URI_BYTES = 20 * 1024 * 1024

/**
 * Resize and re-encode a shell-produced image. Reads from the full output file
 * when one is present (stdout is capped and would decode to a corrupt image).
 * Returns null when there is nothing to resize; performs no error handling of
 * its own beyond the size gate. The stat and the read are awaited: this runs
 * on the tool's async road and the file is up to the 20 MB cap — a
 * synchronous read of it froze the whole cockpit for the read's duration.
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  if (outputFilePath !== undefined) {
    const { stat, readFile } = await import('node:fs/promises')
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_DATA_URI_BYTES) return null
    source = await readFile(outputFilePath, 'utf8')
  }
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buffer = Buffer.from(parsed.data, 'base64')
  const subtype = mediaSubtype(parsed.mediaType)
  const resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.byteLength, subtype)
  // The re-encode scheme is the literal `data:image/` + the helper's returned
  // (bare-subtype) media type — the source media type is not carried through.
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

/** The extension derived from a media type's subtype, defaulting to png. */
function mediaSubtype(mediaType: string): string {
  const parts = mediaType.split('/')
  return parts.length > 1 ? (parts[1] as string) : 'png'
}

// ── output formatting ─────────────────────────────────────────────────────────

/** The share of an over-long output kept from its head; the rest of the
 *  budget keeps the tail, where a build or test run states its verdict. */
const HEAD_SHARE = OUTPUT_HEAD_SHARE

/** Format shell output for a tool result: total line count, truncation, image flag.
 *  An output past the length cap keeps its head AND its tail around one
 *  middle notice — a head-only cut hid exactly the lines a long run ends
 *  with (the failing test, the exit summary), and the model had to re-run
 *  or read the file to learn the verdict.
 *
 *  `preExcerpted` (the tail defect): a spilled
 *  result arrives ALREADY excerpted by TaskOutput — head + tail around its
 *  own honest notice (true byte count + the spill path), a hair over the
 *  budget by exactly that notice's length. Re-cutting here SLICED THAT
 *  NOTICE AWAY and replaced it with a fabricated count of the second cut's
 *  own middle ("[2 lines truncated]" for a run that dropped ~59,500 — the
 *  2 was the eaten notice's newline wrapper). This function cannot know
 *  what upstream dropped, so it must not invent a number: a pre-excerpted
 *  result passes through whole and the upstream notice stays the one
 *  notice. */
export function formatOutput(content: string, opts?: { preExcerpted?: boolean }): { totalLines: number; truncatedContent: string; isImage?: boolean } {
  const isImage = isImageOutput(content)
  if (isImage) {
    return { totalLines: 1, truncatedContent: content, isImage: true }
  }
  const maxLength = getMaxOutputLength()
  const totalLines = countCharInString(content, '\n') + 1
  if (content.length <= maxLength || opts?.preExcerpted === true) {
    return { totalLines, truncatedContent: content, isImage: false }
  }
  const headBudget = Math.floor(maxLength * HEAD_SHARE)
  const tailBudget = maxLength - headBudget
  let head = content.slice(0, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = content.slice(content.length - tailBudget)
  const tailNewline = tail.indexOf('\n')
  if (tailNewline !== -1 && tailNewline < tailBudget / 2) tail = tail.slice(tailNewline + 1)
  const middle = content.slice(head.length, content.length - tail.length)
  const removedLines = Math.max(1, countCharInString(middle, '\n'))
  const notice = `\n\n[${removedLines} ${plural(removedLines, 'line')} truncated from the middle — the head and the tail of the output are shown]\n\n`
  return { totalLines, truncatedContent: head + notice + tail, isImage: false }
}

// ── working-directory reset ───────────────────────────────────────────────────

/** Append the shell-cwd-reset notice to stderr. */
export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

/**
 * Reset the shell cwd when it has drifted outside the project. Returns true
 * when the caller should tell the model (append the notice); false when the
 * reset was policy (or nothing changed).
 */
export function resetCwdIfOutsideProject(toolPermissionContext: ToolPermissionContext): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  if (shouldMaintainProjectWorkingDir()) {
    setCwd(originalCwd)
    return false
  }
  // Fast path: the original cwd is always an allowed working directory, so the
  // syscall-bearing allowed-path test is skipped when the cwd has not moved.
  if (cwd !== originalCwd && !pathInAllowedWorkingPath(cwd, toolPermissionContext)) {
    setCwd(originalCwd)
    return true
  }
  return false
}

// ── structured-content summary ────────────────────────────────────────────────

/** Summarise a list of content blocks for display (no consumer today). */
export function createContentSummary(content: ContentBlockParam[]): string {
  let imageCount = 0
  let textCount = 0
  const previews: string[] = []
  for (const block of content) {
    if (block.type === 'image') {
      imageCount++
    } else if (block.type === 'text' && typeof (block as { text?: string }).text === 'string' && (block as { text: string }).text !== '') {
      textCount++
      const text = (block as { text: string }).text
      previews.push(text.length > 200 ? `${text.slice(0, 200)}…` : text)
    }
  }
  const parts: string[] = []
  if (imageCount > 0) parts.push(`${imageCount} ${plural(imageCount, 'image')}`)
  if (textCount > 0) parts.push(`${textCount} ${plural(textCount, 'text block')}`)
  const header = `MCP result${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`
  return previews.length > 0 ? `${header}\n\n${previews.join('\n\n')}` : header
}
