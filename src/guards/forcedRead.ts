import { existsSync } from 'node:fs'
import { resolve } from 'path'
import {
  claimContinuation,
  turnBoundaryIndex,
} from '../services/run/continuationLatch.js'
import { processMainOwner } from '../services/run/resolveOwner.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { engageTurnGuard } from './guards.js'

const READ_TOOL_NAMES = new Set(['Read', 'NotebookRead'])

export const FORCED_READ_STOP_HOOK_ID = 'forced-read-stop'

const forcedReadEngagedSessions = new Set<string>()

export function collectReadFilePaths(messages: Message[]): Set<string> {
  const read = new Set<string>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        typeof block.name === 'string' &&
        READ_TOOL_NAMES.has(block.name)
      ) {
        const fp = (block.input as { file_path?: unknown } | null)?.file_path
        if (typeof fp === 'string' && fp.length > 0) {
          read.add(resolve(fp))
        }
      }
    }
  }
  return read
}


export function registerForcedReadGuard(
  sessionId: string,
  targetFiles: string[],
  options?: { maxBlocks?: number },
): void {
  const targets = targetFiles.map(p => resolve(p))
  if (targets.length === 0) return
  if (forcedReadEngagedSessions.has(sessionId)) return
  const maxBlocks = options?.maxBlocks ?? 3
  let blocks = 0
  const missing = new Set(targets.filter(p => !existsSync(p)))
  if (missing.size > 0) {
    logForDebugging(
      `[forced-read] MERCURY_FORCE_READ_FILES target(s) do not exist and can never be satisfied: ${[
        ...missing,
      ].join(', ')}`,
    )
  }
  const describe = (p: string): string =>
    missing.has(p) ? `${p} (not found)` : p
  const words = `You have not yet read a required file in this session. Before you can stop, use the Read tool on each of these files you have not read yet: ${targets
    .map(describe)
    .join(', ')}.`
  engageTurnGuard(sessionId, {
    id: FORCED_READ_STOP_HOOK_ID,
    timeoutMs: 5000,
    judge: ({ messages }) => {
      if (blocks >= maxBlocks) return { hold: false }
      const read = collectReadFilePaths(messages)
      const unread = targets.filter(p => !read.has(p))
      if (unread.length === 0) return { hold: false }
      if (!claimContinuation(processMainOwner(), turnBoundaryIndex(messages), messages.length)) {
        return { hold: false }
      }
      blocks++
      return { hold: true, words }
    },
  })
  forcedReadEngagedSessions.add(sessionId)
}
