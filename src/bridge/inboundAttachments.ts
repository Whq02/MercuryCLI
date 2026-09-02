import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { z } from 'zod/v4'

import { getSessionId } from '../bootstrap/state.js'
import type { ContentBlockParam } from '../types/wire.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'


export type InboundAttachment = {
  file_uuid: string
  file_name: string
}

const InboundAttachmentSchema = lazySchema(() =>
  z.array(
    z.object({
      file_uuid: z.string(),
      file_name: z.string(),
    }),
  ),
)

const DOWNLOAD_TIMEOUT_MS = 30_000

export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null) return []
  const candidate = (msg as { file_attachments?: unknown }).file_attachments
  if (candidate === undefined) return []
  const parsed = InboundAttachmentSchema().safeParse(candidate)
  return parsed.success ? parsed.data : []
}

function sanitizeAttachmentName(fileName: string): string {
  const sanitized = basename(fileName).replace(/[^A-Za-z0-9._-]/g, '_')
  return sanitized === '' ? 'attachment' : sanitized
}

function attachmentPrefix(fileUuid: string): string {
  const source = fileUuid === '' ? randomUUID() : fileUuid
  return source.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')
}

async function resolveOneAttachment(attachment: InboundAttachment): Promise<string | null> {
  try {
    const token = getBridgeAccessToken()
    if (token === undefined) {
      logForDebugging('inboundAttachments: no access token; skipping attachment')
      return null
    }
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(attachment.file_uuid)}/content`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (response.status !== 200) {
      logForDebugging(`inboundAttachments: download returned ${response.status}; skipping`)
      return null
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const directory = join(getMercuryHome(), 'uploads', getSessionId())
    await mkdir(directory, { recursive: true })
    const filePath = join(
      directory,
      `${attachmentPrefix(attachment.file_uuid)}-${sanitizeAttachmentName(attachment.file_name)}`,
    )
    await writeFile(filePath, bytes)
    return filePath
  } catch (err) {
    logForDebugging(`inboundAttachments: attachment skipped: ${String(err)}`)
    return null
  }
}

export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  const resolved = await Promise.all(attachments.map(resolveOneAttachment))
  const paths = resolved.filter((path): path is string => path !== null)
  if (paths.length === 0) return ''
  return paths.map(path => `@"${path}"`).join(' ') + ' '
}

type TextBlockish = { type?: string; text?: string }

export function prependPathRefs(
  content: string | ContentBlockParam[],
  prefix: string,
): string | ContentBlockParam[] {
  if (prefix === '') return content
  if (typeof content === 'string') return prefix + content
  let lastTextIndex = -1
  for (let index = content.length - 1; index >= 0; index--) {
    if ((content[index] as TextBlockish).type === 'text') {
      lastTextIndex = index
      break
    }
  }
  if (lastTextIndex === -1) {
    return [...content, { type: 'text', text: prefix.trimEnd() } as ContentBlockParam]
  }
  return content.map((block, index) =>
    index === lastTextIndex
      ? ({ ...block, text: prefix + ((block as TextBlockish).text ?? '') } as ContentBlockParam)
      : block,
  )
}

export async function resolveAndPrepend(
  msg: unknown,
  content: string | ContentBlockParam[],
): Promise<string | ContentBlockParam[]> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}
