import { normalize } from 'node:path'

import { getMnemeHome, getMemoryBaseDir, isMnemeEnabled, isMnemePath } from '../mneme/paths.js'
import { isAgentMemoryPath } from './agentMemory.js'
import { CORRECT_TOOL_NAME, RETAIN_TOOL_NAME } from '../constants/tools/memory.js'
import { getMercuryHome } from './envUtils.js'
import { foldPathCase, hostPathSpellings, msysDrivePathToNative } from './platform/paths.js'
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/utils/memoryFileDetection.ts:48')
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
  return notBuilt('src/utils/memoryFileDetection.ts:84')
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  const path = pattern.replace(/\\/g, '/')
  if (path.includes('.jsonl') || (path.includes('session-memory') && (path.includes('.md') || path.endsWith('*')))) return true
  return isMnemeEnabled() && (path.includes('agent-memory/') || path.includes('agent-memory-local/'))
}
