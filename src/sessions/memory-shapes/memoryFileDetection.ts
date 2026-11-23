import { normalize } from 'node:path'

import { getMnemeHome, getMemoryBaseDir, isMnemeEnabled, isMnemePath } from '../mneme/paths.js'
import { isAgentMemoryPath } from '../../crew/agents/agentMemory.js'
import { CORRECT_TOOL_NAME, RETAIN_TOOL_NAME } from '../../tools/kit/names/memory.js'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { foldPathCase, hostPathSpellings, msysDrivePathToNative } from '../../platform/host-os/paths.js'

const PATH_TOKEN_PATTERN = /(?:[A-Za-z]:[/\\]|\/)[^\s"'`]*/g


function comparable(path: string): string {
  return foldPathCase(path.replace(/\\/g, '/'))
}

function comparableNormalized(path: string): string {
  return comparable(normalize(path))
}

function underDirectory(path: string, directory: string): boolean {
  const dir = comparable(directory).replace(/\/+$/, '')
  return path === dir || path.startsWith(`${dir}/`)
}


export function isMnemeFile(filePath: string): boolean {
  if (!isMnemeEnabled()) return false
  return isMnemePath(filePath)
}

export function memoryWriteRefusal(filePath: string): string | null {
  if (!isMnemeFile(filePath)) return null
  return `${filePath} is Mercury's memory: save with ${RETAIN_TOOL_NAME} and change with ${CORRECT_TOOL_NAME} — a direct write is refused.`
}

export function isAutoManagedMemoryFile(filePath: string): boolean {
  if (isMnemeFile(filePath)) return true
  const path = comparable(filePath)
  if (underDirectory(path, getMercuryHome()) && (
    (path.includes('/session-memory/') && path.endsWith('.md')) ||
    (path.includes('/projects/') && path.endsWith('.jsonl'))
  )) return true
  return isMnemeEnabled() && isAgentMemoryPath(filePath)
}

export function isMemoryDirectory(dirPath: string): boolean {
  const path = comparableNormalized(dirPath)
  const parts = `${path}/`
  const enabled = isMnemeEnabled()
  if (enabled) {
    if (parts.includes('/agent-memory/') || parts.includes('/agent-memory-local/')) return true
    const home = comparable(getMnemeHome())
    if (path === home.replace(/\/+$/, '') || path.startsWith(home)) return true
  }
  const inHome = underDirectory(path, getMercuryHome())
  if (!inHome && !underDirectory(path, getMemoryBaseDir())) return false
  return parts.includes('/session-memory/') || (inHome && parts.includes('/projects/')) ||
    (enabled && parts.includes('/memory/'))
}

export function isShellCommandTargetingMemory(command: string): boolean {
  const comparableCommand = comparable(command)
  const roots = [getMercuryHome(), getMemoryBaseDir(), getMnemeHome()]
  if (!roots.some(root => hostPathSpellings(root).some(spelling => comparableCommand.includes(comparable(spelling))))) {
    return false
  }
  for (const [token] of command.matchAll(PATH_TOKEN_PATTERN)) {
    const cleaned = token.replace(/[,;|&>]+$/, '')
    const candidate = msysDrivePathToNative(cleaned, true)
    if (isAutoManagedMemoryFile(candidate) || isMemoryDirectory(candidate)) {
      return true
    }
  }
  return false
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  const path = pattern.replace(/\\/g, '/')
  if (path.includes('.jsonl') || (path.includes('session-memory') && (path.includes('.md') || path.endsWith('*')))) return true
  return isMnemeEnabled() && (path.includes('agent-memory/') || path.includes('agent-memory-local/'))
}
