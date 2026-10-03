import { getFsImplementation } from '../../utils/fsOperations.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'

let lastSummarizedMessageId: string | undefined = undefined

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

export function setLastSummarizedMessageId(id: string | undefined): void {
  lastSummarizedMessageId = id
}

export async function waitForSessionMemoryExtraction(): Promise<void> {}

export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  try {
    return fs.readFileSync(getSessionMemoryPath(), { encoding: 'utf-8' })
  } catch (error) {
    if (isFsInaccessible(error)) return null
    throw error
  }
}
