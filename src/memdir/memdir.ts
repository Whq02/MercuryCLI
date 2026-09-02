import { readFileSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { getOriginalCwd } from '../bootstrap/state.js'
import { experienceCardDoctrineLines } from './experienceCards.js'
import { scribeScopeDoctrineLines } from './scribeScopeDoctrine.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { logForDebugging } from '../utils/debug.js'
import { getErrnoCode } from '../utils/errors.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
} from './memoryTypes.js'
import { getAutoMemPath, isAutoMemoryEnabled, relevantMemoryRecallEnabled } from './paths.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  lineTruncated: boolean
  byteTruncated: boolean
}

export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const lineCount = lines.length
  const byteCount = trimmed.length
  const lineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const byteTruncated = byteCount > MAX_ENTRYPOINT_BYTES
  if (!lineTruncated && !byteTruncated) {
    return { content: trimmed, lineCount, byteCount, lineTruncated, byteTruncated }
  }
  let content = lineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n') : trimmed
  if (content.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = content.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    content = content.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }
  const reason =
    lineTruncated && byteTruncated
      ? `it has ${lineCount} lines and is ${formatFileSize(byteCount)}`
      : lineTruncated
        ? `it has ${lineCount} lines (the limit is ${MAX_ENTRYPOINT_LINES})`
        : `it is ${formatFileSize(byteCount)} (the limit is ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are running too long`
  content += `\n\n> ${ENTRYPOINT_NAME} was truncated because ${reason}. Keep index entries to one line under about 200 characters and move detail into topic files.`
  return { content, lineCount, byteCount, lineTruncated, byteTruncated }
}

export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the write tool; do not run a make-directory command or check for its existence first.'

export async function ensureMemoryDirExists(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    logForDebugging(`memdir: create failed (${getErrnoCode(error) ?? 'unknown'})`)
  }
}

function countMemoryDirEntries(
  dir: string,
  metadata?: { memoryType?: string; truncation?: EntrypointTruncation },
): void {
  void (async () => {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const files = entries.filter(entry => entry.isFile()).length
      const dirs = entries.filter(entry => entry.isDirectory()).length
      void files
      void dirs
      void metadata
    } catch {
    }
  })()
}

function howToSaveSection(skipIndex: boolean): string[] {
  const maintenance =
    'Maintenance: keep name, description and type current with the content; organize by topic, not chronologically; update or remove memories that turn out wrong; never write duplicates — check for an existing memory to update first.'
  if (skipIndex) {
    return [
      '## How to save memories',
      '',
      'Write each memory to its own file (for example `prefers-rebase-workflow.md`) in this format:',
      ...MEMORY_FRONTMATTER_EXAMPLE,
      maintenance,
    ]
  }
  return [
    '## How to save memories',
    '',
    'Saving a memory takes two steps.',
    '',
    '1. Write the memory to its own file (for example `prefers-rebase-workflow.md`) in this format:',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    `2. Add a pointer line to ${ENTRYPOINT_NAME}: one line under about 150 characters in the form \`- [Title](file.md) — hook\`. The index is an INDEX, not a memory — it is always loaded into context, lines past ${MAX_ENTRYPOINT_LINES} truncate, and memory content is never written directly into it.`,
    '',
    maintenance,
  ]
}

const PERSISTENCE_COMPARISON: readonly string[] = [
  '## Memory versus other persistence',
  '',
  'Memory is recalled in FUTURE conversations — never store what only matters in this one: approach alignment for an implementation belongs in the plan (update it when the approach changes), and step tracking belongs in tasks.',
]

export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  const transcriptDir = getProjectDir(getOriginalCwd())
  const shellForm = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memoryRecipe = shellForm
    ? `grep -ri "<term>" ${autoMemDir} --include="*.md"`
    : `Grep with pattern="<term>", path="${autoMemDir}", glob="*.md"`
  const transcriptRecipe = shellForm
    ? `grep -ri "<term>" ${transcriptDir} --include="*.jsonl"`
    : `Grep with pattern="<term>", path="${transcriptDir}", glob="*.jsonl"`
  return [
    '## Searching past context',
    '',
    '1. Topic files in the memory directory:',
    '```',
    memoryRecipe,
    '```',
    '2. Session transcript logs — a last resort; the files are large and slow:',
    '```',
    transcriptRecipe,
    '```',
    'Key the search on specific literal strings — the text of an error, a path, the name of a symbol — rather than general topic words.',
    '',
  ]
}

export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const searchSection =
    getFeatureGateForSearchSection() || relevantMemoryRecallEnabled()
      ? buildSearchingPastContextSection(memoryDir)
      : []
  return [
    `# ${displayName}`,
    `You have a persistent file-based memory system at ${memoryDir}. ${DIR_EXISTS_GUIDANCE}`,
    'Build this memory up over time so future conversations have a complete picture: who the user is, how they want to collaborate, what behaviours to avoid or repeat, and the context behind the work.',
    'When the user explicitly asks you to remember something, save it immediately as whichever type fits. When they ask you to forget something, find and remove the relevant entry.',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    ...howToSaveSection(skipIndex),
    ...WHEN_TO_ACCESS_SECTION,
    ...TRUSTING_RECALL_SECTION,
    ...experienceCardDoctrineLines(),
    ...scribeScopeDoctrineLines(),
    ...PERSISTENCE_COMPARISON,
    ...(extraGuidelines ?? []),
    ...searchSection,
  ]
}

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
function getFeatureGateForSearchSection(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_coral_fern', false)
}

export function buildMemoryPrompt(options: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const lines = buildMemoryLines(options.displayName, options.memoryDir, options.extraGuidelines)
  const entrypointPath = `${options.memoryDir}${ENTRYPOINT_NAME}`
  let rawContent = ''
  try {
    rawContent = readFileSync(entrypointPath, 'utf8')
  } catch {
  }
  if (rawContent.trim() !== '') {
    const truncation = truncateEntrypointContent(rawContent)
    lines.push(`## ${ENTRYPOINT_NAME}`, '', truncation.content)
    countMemoryDirEntries(options.memoryDir, {
      memoryType: options.displayName.replace(/\s+/g, '-'),
      truncation,
    })
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      'The index is currently empty — memories you save will appear there.',
    )
  }
  return lines.join('\n')
}

export async function loadMemoryPrompt(): Promise<string | null> {
  if (!isAutoMemoryEnabled()) return null
  const memoryDir = getAutoMemPath()
  await ensureMemoryDirExists(memoryDir)
  countMemoryDirEntries(memoryDir, { memoryType: 'auto-memory' })
  return buildMemoryLines(
    'auto memory',
    memoryDir,
    undefined,
    relevantMemoryRecallEnabled(),
  ).join('\n')
}
