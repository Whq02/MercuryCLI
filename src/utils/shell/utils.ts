import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE, type OutputBudget } from './outputLimits.js'
import { filterShellOutput, isShellOutputFilterOn, outputFilterFooter } from './outputFilter.js'
import { getScratchpadDir } from '../permissions/filesystem.js'
import { countCharInString, plural } from '../stringUtils.js'
import { cutAroundSpillNotice } from '../toolErrors.js'
import { clampClause } from '../waitCeiling.js'
import { maybeResizeAndDownsampleImageBuffer } from '../imageResizer.js'
import { createSystemMessage } from '../messages/systemMessages.js'
import { shellWordOwed } from './shellRecord.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  Base64ImageSource,
  ImageBlockParam,
  ToolResultBlockParam,
} from '../../types/wire.js'


const TOOL_USE_SUMMARY_LIMIT = 100

export function truncateForSummary(command: string): string {
  return command.length > TOOL_USE_SUMMARY_LIMIT ? command.slice(0, TOOL_USE_SUMMARY_LIMIT) : command
}

export async function sayWhatTheShellOwes(context: Pick<ToolUseContext, 'appendSystemMessage'>): Promise<void> {
  const owed = await shellWordOwed()
  if (owed.user !== null) {
    if (context.appendSystemMessage) context.appendSystemMessage(createSystemMessage(owed.user, 'warning'))
    else process.stderr.write(`${owed.user}\n`)
  }
  if (owed.model !== null) throw new Error(owed.model)
}

const DATA_IMAGE_PREFIX_RE = /^data:image\/[a-z0-9.+_-]+;base64,/i
const BASE64_DATA_URI_RE = /^data:([^;]+);base64,([^\r\n]+)$/
const MAX_IMAGE_SPILL_BYTES = 20 * 1024 * 1024

export function stripEmptyLines(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start++
  let end = lines.length - 1
  while (end >= start && lines[end]!.trim() === '') end--
  if (start > end) return ''
  return lines.slice(start, end + 1).join('\n')
}

export function isImageOutput(content: string): boolean {
  return DATA_IMAGE_PREFIX_RE.test(content)
}

export function buildImageToolResult(stdout: string, toolUseID: string): ToolResultBlockParam | null {
  const match = BASE64_DATA_URI_RE.exec(stdout.trim())
  if (!match) return null
  const mediaType = match[1]! as Base64ImageSource['media_type']
  const data = match[2]!
  const imageBlock: ImageBlockParam = {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data,
    },
  }
  return {
    type: 'tool_result',
    tool_use_id: toolUseID,
    content: [imageBlock],
  }
}

export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let raw = stdout
  if (outputFilePath !== undefined) {
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_SPILL_BYTES) return null
    raw = await readFile(outputFilePath, 'utf8')
  }
  const match = BASE64_DATA_URI_RE.exec(raw.trim())
  if (!match) return null
  const mediaType = match[1]!
  const data = match[2]!
  const buffer = Buffer.from(data, 'base64')
  const subtype = mediaSubtype(mediaType)
  const resized = await maybeResizeAndDownsampleImageBuffer(buffer, buffer.length, subtype, {
    role: 'tool-result',
  })
  return imageDataUrl(mediaSubtype(resized.mediaType), resized.buffer)
}

const imageDataUrl = (subtype: string, bytes: Buffer): string =>
  ['data:image/', subtype, ';base64,', bytes.toString('base64')].join('')

function mediaSubtype(mediaType: string): string {
  const parts = mediaType.split('/')
  return parts.length > 1 ? parts[1]! : 'png'
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

export async function applyShellOutputFilter(out: string, raw: { taskId: string; spilledPath: string | undefined }): Promise<string> {
  if (!isShellOutputFilterOn() || isImageOutput(out)) return out
  const filtered = filterShellOutput(out)
  if (!filtered.changed) return out
  let rawPath = raw.spilledPath
  if (rawPath === undefined) {
    try {
      const destination = join(getScratchpadDir(), `${raw.taskId}.output`)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, out, 'utf8')
      rawPath = destination
    } catch {
      rawPath = undefined
    }
  }
  return `${filtered.text}\n${outputFilterFooter(filtered.leftOut, rawPath)}`
}

export async function redactedCopy(source: string, destination: string, redact: (text: string) => string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  let carry = ''
  const redacting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = carry + chunk.toString('utf8')
      const cut = text.lastIndexOf('\n')
      if (cut === -1) {
        carry = text
        callback()
        return
      }
      carry = text.slice(cut + 1)
      callback(null, redact(text.slice(0, cut + 1)))
    },
    flush(callback) {
      callback(null, carry === '' ? undefined : redact(carry))
    },
  })
  await pipeline(createReadStream(source, { encoding: 'utf8' }), redacting, createWriteStream(destination))
}

export function formatExcerpt(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return cutAroundSpillNotice(content, maxLength) ?? formatOutput(content, { maxLength }).truncatedContent
}

export function outputBudgetClause(budget: OutputBudget): string | undefined {
  if (budget.clampedTo === undefined) return undefined
  return `[${clampClause('max_output_chars', budget.effective, budget.clampedTo, 'chars')}]`
}

