import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Temp-file path generation, random or content-stable.
 *
 * The default identifier is a random UUID. When a content hash is supplied
 * the identifier is derived from it instead, which makes the path stable
 * across process boundaries — that matters when the path itself ends up
 * inside content sent to the model, where a random component would change
 * on every subprocess spawn and invalidate the prompt-cache prefix.
 */
export function generateTempFilePath(
  prefix: string = 'claude-prompt',
  extension: string = '.md',
  options?: { contentHash?: string },
): string {
  const identifier = options?.contentHash
    ? createHash('sha256').update(options.contentHash).digest('hex').slice(0, 16)
    : randomUUID()
  return join(tmpdir(), `${prefix}-${identifier}${extension}`)
}
