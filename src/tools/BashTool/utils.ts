import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { setCwd } from '../../utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { pathInAllowedWorkingPath } from '../../utils/permissions/filesystem.js'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE, type OutputBudget } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
  ToolResultBlockParam,
} from '../../types/wire.js'


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


const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+_-]+;base64,/i
const DATA_URI_RE = /^data:([^;]+);base64,([^\r\n]+)$/

export function isImageOutput(content: string): boolean {
  return IMAGE_DATA_URL_RE.test(content)
}

export function parseDataUri(s: string): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match) return null
  return { mediaType: match[1] as string, data: match[2] as string }
}

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

const MAX_IMAGE_DATA_URI_BYTES = 20 * 1024 * 1024

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
  const resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.byteLength, subtype, { role: 'tool-result' })
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

function mediaSubtype(mediaType: string): string {
  const parts = mediaType.split('/')
  return parts.length > 1 ? (parts[1] as string) : 'png'
}


const HEAD_SHARE = OUTPUT_HEAD_SHARE

export function formatOutput(content: string, opts?: { preExcerpted?: boolean; maxLength?: number }): { totalLines: number; truncatedContent: string; isImage?: boolean } {
  const isImage = isImageOutput(content)
  if (isImage) {
    return { totalLines: 1, truncatedContent: content, isImage: true }
  }
  const maxLength = opts?.maxLength ?? getMaxOutputLength()
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
  const removedLines = Math.max(1, countCharInString(middle, '\n') - (middle.startsWith('\n') && middle.endsWith('\n') ? 1 : 0))
  const notice = `\n\n[${removedLines} ${plural(removedLines, 'line')} truncated from the middle — the head and the tail of the output are shown]\n\n`
  return { totalLines, truncatedContent: head + notice + tail, isImage: false }
}

const SPILL_NOTICE = /\n\n\[(\d+) bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at [^\n]*?\]\n\n/

export function formatExcerpt(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  const match = SPILL_NOTICE.exec(content)
  if (match === null) return formatOutput(content, { maxLength }).truncatedContent
  const before = content.slice(0, match.index)
  const after = content.slice(match.index + match[0].length)
  const headBudget = Math.floor(maxLength * HEAD_SHARE)
  const tailBudget = maxLength - headBudget
  let head = before.slice(0, headBudget)
  const headNewline = head.lastIndexOf('\n')
  if (head.length < before.length && headNewline > headBudget / 2) head = head.slice(0, headNewline)
  let tail = after.slice(Math.max(0, after.length - tailBudget))
  const tailNewline = tail.indexOf('\n')
  if (tail.length < after.length && tailNewline !== -1 && tailNewline < tailBudget / 2) tail = tail.slice(tailNewline + 1)
  const dropped = Buffer.byteLength(before, 'utf8') - Buffer.byteLength(head, 'utf8') + Buffer.byteLength(after, 'utf8') - Buffer.byteLength(tail, 'utf8')
  const notice = match[0].replace(match[1] as string, String(Number(match[1]) + dropped))
  return head + notice + tail
}

export function outputBudgetClause(budget: OutputBudget): string | undefined {
  if (budget.clampedTo === undefined) return undefined
  return `[max_output_chars clamped to ${budget.effective} chars (the ${budget.clampedTo})]`
}


export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

export function resetCwdIfOutsideProject(toolPermissionContext: ToolPermissionContext): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  if (shouldMaintainProjectWorkingDir()) {
    setCwd(originalCwd)
    return false
  }
  if (cwd !== originalCwd && !pathInAllowedWorkingPath(cwd, toolPermissionContext)) {
    setCwd(originalCwd)
    return true
  }
  return false
}


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
