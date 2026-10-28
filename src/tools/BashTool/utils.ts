import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMaxOutputLength, OUTPUT_HEAD_SHARE, type OutputBudget } from '../../utils/shell/outputLimits.js'
import { filterShellOutput, isShellOutputFilterOn, outputFilterFooter } from '../../utils/shell/outputFilter.js'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
import { cutAroundSpillNotice } from '../../utils/toolErrors.js'
import { clampClause } from '../../utils/waitCeiling.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import type {
  Base64ImageSource,
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

function parseDataUri(s: string): { mediaType: string; data: string } | null {
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
  return imageDataUrl(resized.mediaType, resized.buffer)
}

const imageDataUrl = (subtype: string, bytes: Buffer): string =>
  ['data:image/', subtype, ';base64,', bytes.toString('base64')].join('')

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
