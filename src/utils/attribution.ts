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

/**
 * Commit/PR attribution text and the enhanced PR summary computed from the
 * tracked attribution state plus transcript statistics.
 *
 * The outward-facing text is provider-neutral (operator ruling,
 *): it names Mercury — the product — and never a model. The PR
 * line links the public product site (operator-supplied,
 * mercury-cli.ai); the commit trailer still carries no email token, so it
 * stays a watermark rather than a git co-author a hosting platform would
 * resolve to an account.
 */

export type AttributionTexts = {
  commit: string
  pr: string
}

// User-visible text that lands verbatim in commit bodies and PR
// descriptions.
const DEFAULT_PR_ATTRIBUTION = '🤖 Generated with [Mercury CLI](https://mercury-cli.ai)'
const DEFAULT_COMMIT_TRAILER = 'Co-Authored-By: Mercury'

/**
 * The commit trailer and PR line under settings precedence: an explicit
 * `attribution` settings object wins field-by-field; otherwise
 * `includeMercuryCoAuthor: false` yields empty strings for both; otherwise
 * the defaults.
 */
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

// Deliberately structural: both live message objects and parsed transcript
// entries are passed.
type PromptCountEntry = {
  type: string
  message?: { content?: unknown }
}

/** The exact bare opening-tag form; no attribute tolerance. */
function containsTerminalOutputTag(text: string): boolean {
  return TERMINAL_OUTPUT_TAGS.some(tag => text.includes(`<${tag}>`))
}

/**
 * Count user messages that contain real user-typed text. A string content
 * counts when non-empty after trimming and not terminal output. An array
 * content counts when any block is a text block (with a string text) that
 * is not terminal output, or an image or document block — the array form
 * applies NO non-emptiness test. Falsy content never counts; tool-result
 * blocks never count.
 */
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
      // The same predicate the post-tool session hooks use, so the recalled
      // count agrees with what those hooks consider a memory access.
      if (isMemoryFileAccess(blockRecord.name, blockRecord.input)) count++
    }
  }
  return count
}

type TranscriptStatistics = {
  promptCount: number
  memoryAccessCount: number
}

/**
 * Statistics over the current conversation arc only: the transcript is read
 * through the loader that skips attribution-snapshot lines at the
 * file-descriptor level (they can be the large majority of a long session's
 * bytes), entries before the last compact boundary are dropped, and
 * sidechain prompts are excluded. Any failure returns zeroes.
 */
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
        // Skip unparseable lines.
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

/**
 * Attribution data over ALL tracked files in the current state — not only
 * staged ones, because PR files may not be staged. Null when there is no
 * state, it tracks nothing, or the computation fails (logged).
 */
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

/**
 * The enhanced PR attribution line. A non-empty custom PR setting is
 * returned verbatim (note the asymmetry with getAttributionTexts: there an
 * empty `pr` yields an empty line, here it means "not customised");
 * `includeMercuryCoAuthor: false` yields the empty string. Otherwise the
 * shape is `<default line> (<pct>% <n>-shotted[, <m> memories recalled])`
 * — statistics only, never a model name — or the plain default line when
 * all three statistics are zero.
 */
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
