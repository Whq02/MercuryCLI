import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function generateTempFilePath(
  prefix: string = 'mercury-prompt',
  extension: string = '.md',
  options?: { contentHash?: string },
): string {
  const id =
    options?.contentHash !== undefined
      ? createHash('sha256').update(options.contentHash).digest('hex').slice(0, 16)
      : randomUUID()
  return join(tmpdir(), `${prefix}-${id}${extension}`)
}
