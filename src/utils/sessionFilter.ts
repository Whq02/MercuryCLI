import type { LogOption } from '../types/logs.js'
import { workspaceRecognizedByGround } from './bootCardFacts.js'


export const SUBSTANTIVE_FILE_SIZE = 4096

const PLACEHOLDER_PROMPTS = new Set(['(session)', 'No prompt'])

function isCommandOnlyPrompt(fp: string): boolean {
  const s = fp.trim()
  if (!s) return false
  if (
    s.startsWith('<command-name>') ||
    s.startsWith('<command-message>') ||
    s.startsWith('<local-command-caveat>') ||
    s.startsWith('<local-command-stdout>')
  ) {
    return true
  }
  return s.startsWith('/')
}

export function isSubstantiveSession(log: LogOption): boolean {
  if (log.customTitle && log.customTitle.trim()) return true

  const fp = (log.firstPrompt ?? '').trim()

  if (fp && !PLACEHOLDER_PROMPTS.has(fp) && !isCommandOnlyPrompt(fp)) {
    return true
  }

  return (log.fileSize ?? 0) >= SUBSTANTIVE_FILE_SIZE
}


export function isProjectSession(log: LogOption, root: string): boolean {
  const raw = (log.projectPath ?? '').trim()
  if (!raw) return true
  if (!root.replace(/[\\/]+$/, '')) return true
  return workspaceRecognizedByGround(root, raw)
}

export function partitionByProject(
  logs: readonly LogOption[],
  root: string,
): { inProject: LogOption[]; elsewhere: LogOption[] } {
  const inProject: LogOption[] = []
  const elsewhere: LogOption[] = []
  for (const l of logs) (isProjectSession(l, root) ? inProject : elsewhere).push(l)
  return { inProject, elsewhere }
}
