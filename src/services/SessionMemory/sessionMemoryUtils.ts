import { getFsImplementation } from '../../utils/fsOperations.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'

export type SessionMemoryConfig = {
  minimumMessageTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
}


let config: SessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }

export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...config }
}

export function setSessionMemoryConfig(partial: Partial<SessionMemoryConfig>): void {
  config = { ...config, ...partial }
}

export function getToolCallsBetweenUpdates(): number {
  return config.toolCallsBetweenUpdates
}


let initialized = false
let lastExtractionTokenCount = 0
let lastSummarizedMessageId: string | undefined = undefined
let extractionInFlightAt: number | null = null

export function hasMetInitializationThreshold(tokens: number): boolean {
  return tokens >= config.minimumMessageTokensToInit
}

export function hasMetUpdateThreshold(tokens: number): boolean {
  return tokens - lastExtractionTokenCount >= config.minimumTokensBetweenUpdate
}

export function isSessionMemoryInitialized(): boolean {
  return initialized
}

export function markSessionMemoryInitialized(): void {
  initialized = true
}

export function recordExtractionTokenCount(tokens: number): void {
  lastExtractionTokenCount = tokens
}

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

export function setLastSummarizedMessageId(id: string | undefined): void {
  lastSummarizedMessageId = id
}


export function markExtractionStarted(): void {
  extractionInFlightAt = Date.now()
}

export function markExtractionCompleted(): void {
  extractionInFlightAt = null
}

const EXTRACTION_STALE_MS = 60_000
const EXTRACTION_WAIT_TIMEOUT_MS = 15_000

export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startedWaitingAt = Date.now()
  while (extractionInFlightAt !== null) {
    if (Date.now() - extractionInFlightAt > EXTRACTION_STALE_MS) return
    if (Date.now() - startedWaitingAt > EXTRACTION_WAIT_TIMEOUT_MS) return
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, 1000)
      timer.unref?.()
    })
  }
}

export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  try {
    return fs.readFileSync(getSessionMemoryPath(), { encoding: 'utf-8' })
  } catch (error) {
    if (isFsInaccessible(error)) return null
    throw error
  }
}

export function resetSessionMemoryState(): void {
  config = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  initialized = false
  lastExtractionTokenCount = 0
  lastSummarizedMessageId = undefined
  extractionInFlightAt = null
}
