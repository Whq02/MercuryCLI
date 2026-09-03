import { stat } from 'node:fs/promises'

import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppStateStore.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { calculateCommitAttribution, type AttributionData } from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from './sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'


export type AttributionTexts = {
  commit: string
  pr: string
}

const DEFAULT_PR_ATTRIBUTION = 'Generated with [Mercury CLI](https://mercury-cli.ai)'
const DEFAULT_COMMIT_TRAILER = 'Co-Authored-By: Mercury <https://mercury-cli.ai>'

export function getAttributionTexts(): AttributionTexts {
  const settings = getInitialSettings()
  const attribution = settings.attribution
  if (attribution) {
    return {
      commit: attribution.commit ?? DEFAULT_COMMIT_TRAILER,
      pr: attribution.pr ?? DEFAULT_PR_ATTRIBUTION,
    }
  }
  if (settings.includeMercuryCoAuthor === false) {
    return { commit: '', pr: '' }
  }
  return { commit: DEFAULT_COMMIT_TRAILER, pr: DEFAULT_PR_ATTRIBUTION }
}

type PromptCountEntry = {
  type: string
  message?: { content?: unknown }
}

function containsTerminalOutputTag(text: string): boolean {
  return TERMINAL_OUTPUT_TAGS.some(tag => text.includes(`<${tag}>`))
}

export function countUserPromptsInMessages(entries: readonly PromptCountEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!content) continue
    if (typeof content === 'string') {
      if (content.trim().length === 0) continue
      if (containsTerminalOutputTag(content)) continue
      count++
      continue
    }
    if (Array.isArray(content)) {
      const hasRealBlock = content.some(block => {
        if (typeof block !== 'object' || block === null) return false
        const type = (block as { type?: unknown }).type
        if (type === 'text') {
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' && !containsTerminalOutputTag(text)
        }
        return type === 'image' || type === 'document'
      })
      if (hasRealBlock) count++
    }
  }
  return count
}

const MEMORY_ACCESS_TOOL_NAMES = new Set<string>([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

type TranscriptScanEntry = {
  type?: string
  subtype?: string
  isSidechain?: boolean
  message?: { content?: unknown }
}

function countMemoryAccesses(entries: TranscriptScanEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const blockRecord = block as { type?: unknown; name?: unknown; input?: unknown }
      if (blockRecord.type !== 'tool_use') continue
      if (typeof blockRecord.name !== 'string') continue
      if (!MEMORY_ACCESS_TOOL_NAMES.has(blockRecord.name)) continue
      if (isMemoryFileAccess(blockRecord.name, blockRecord.input)) count++
    }
  }
  return count
}

type TranscriptStatistics = {
  promptCount: number
  memoryAccessCount: number
}

async function getTranscriptStatistics(): Promise<TranscriptStatistics> {
  try {
    const transcriptPath = getTranscriptPath()
    const { size } = await stat(transcriptPath)
    const { postBoundaryBuf } = await readTranscriptForLoad(transcriptPath, size)
    const entries: TranscriptScanEntry[] = []
    for (const line of postBoundaryBuf.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as TranscriptScanEntry)
      } catch {
      }
    }
    let lastBoundaryIndex = -1
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as TranscriptScanEntry
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        lastBoundaryIndex = i
      }
    }
    const currentArc = entries.slice(lastBoundaryIndex + 1)
    const promptCount = countUserPromptsInMessages(
      currentArc.filter(entry => !entry.isSidechain) as PromptCountEntry[],
    )
    return { promptCount, memoryAccessCount: countMemoryAccesses(currentArc) }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

async function computePRAttributionData(getAppState: () => AppState): Promise<AttributionData | null> {
  try {
    const state = getAppState().attribution
    if (!state) {
      logForDebugging('enhanced PR attribution: no attribution state')
      return null
    }
    const trackedPaths =
      state.fileStates instanceof Map
        ? [...state.fileStates.keys()]
        : Object.keys(state.fileStates ?? {})
    logForDebugging(`enhanced PR attribution: ${trackedPaths.length} tracked files`)
    if (trackedPaths.length === 0) return null
    return await calculateCommitAttribution([state], trackedPaths)
  } catch (err) {
    logError(err)
    return null
  }
}

export async function getEnhancedPRAttribution(getAppState: () => AppState): Promise<string> {
  const settings = getInitialSettings()
  const customPr = settings.attribution?.pr
  if (customPr) return customPr
  if (settings.includeMercuryCoAuthor === false) return ''

  const [attributionData, statistics] = await Promise.all([
    computePRAttributionData(getAppState),
    getTranscriptStatistics(),
  ])
  const percentage = attributionData?.summary.percentage ?? 0
  const { promptCount, memoryAccessCount } = statistics
  logForDebugging(
    `enhanced PR attribution: pct=${percentage} prompts=${promptCount} memories=${memoryAccessCount}`,
  )
  if (percentage === 0 && promptCount === 0 && memoryAccessCount === 0) {
    return DEFAULT_PR_ATTRIBUTION
  }
  const memoryClause =
    memoryAccessCount > 0
      ? `, ${memoryAccessCount} ${memoryAccessCount === 1 ? 'memory' : 'memories'} recalled`
      : ''
  const line = `${DEFAULT_PR_ATTRIBUTION} (${percentage}% ${promptCount}-shotted${memoryClause})`
  logForDebugging(`enhanced PR attribution: ${line}`)
  return line
}
