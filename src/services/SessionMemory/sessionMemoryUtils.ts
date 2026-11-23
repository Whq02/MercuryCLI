import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'

let lastSummarizedMessageId: string | undefined

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

export function setLastSummarizedMessageId(id: string | undefined): void {
  lastSummarizedMessageId = id
}

export async function waitForSessionMemoryExtraction(): Promise<void> {}

export async function getSessionMemoryContent(): Promise<string | null> {
  try {
    return await getFsImplementation().readFile(getSessionMemoryPath(), { encoding: 'utf-8' })
  } catch (error) {
    if (isFsInaccessible(error)) return null
    throw error
  }
}
