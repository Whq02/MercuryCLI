import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
