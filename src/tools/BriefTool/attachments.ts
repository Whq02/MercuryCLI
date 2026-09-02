// Attachment path validation and stat-resolution for the user-message
// tools.

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ValidationResult } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { IMAGE_EXTENSION_REGEX } from '../../utils/imagePaste.js'

export type ResolvedAttachment = {
  /** The expanded absolute path. */
  path: string
  size: number
  isImage: boolean
  /** Optional upload identifier for bridge-carried attachments. */
  uploadId?: string
}

/** Expand ~ and resolve cwd-relative paths. */
function expandAttachmentPath(raw: string): string {
  const expanded = raw.startsWith('~/')
    ? join(homedir(), raw.slice(2))
    : raw === '~'
      ? homedir()
      : raw
  return isAbsolute(expanded) ? expanded : join(getCwd(), expanded)
}

/**
 * Validate attachment paths: each must stat to a regular file. Refusals
 * name the RAW path the model supplied (never the expanded one) and carry
 * a non-zero error code; a missing file also names the current working
 * directory; unexpected errors propagate.
 */
export async function validateAttachmentPaths(
  paths: readonly string[],
): Promise<ValidationResult> {
  for (const rawPath of paths) {
    const expanded = expandAttachmentPath(rawPath)
    try {
      const info = await stat(expanded)
      if (!info.isFile()) {
        return {
          result: false,
          message: `Attachment is not a regular file: ${rawPath}`,
          errorCode: 1,
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          result: false,
          message: `Attachment not found: ${rawPath} (current working directory: ${getCwd()})`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `Attachment is not readable (permission denied): ${rawPath}`,
          errorCode: 1,
        }
      }
      throw error
    }
  }
  return { result: true }
}

/**
 * Stat-resolve attachments serially (local and fast; keeps ordering
 * deterministic). The second stat is intentional: validation ran earlier
 * and the file may have moved since — if it did, the error should reach
 * the model.
 */
export async function resolveAttachments(
  paths: readonly string[],
  options: { replBridgeEnabled: boolean; signal?: AbortSignal },
): Promise<ResolvedAttachment[]> {
  void options
  const resolved: ResolvedAttachment[] = []
  for (const rawPath of paths) {
    const expanded = expandAttachmentPath(rawPath)
    const info = await stat(expanded)
    resolved.push({
      path: expanded,
      size: info.size,
      isImage: IMAGE_EXTENSION_REGEX.test(expanded),
    })
  }
  return resolved
}
