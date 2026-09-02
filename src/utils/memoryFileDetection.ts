import { normalize } from 'node:path'

import { getAutoMemPath, getMemoryBaseDir, isAutoMemoryEnabled, isAutoMemPath } from '../memdir/paths.js'
import { isAgentMemoryPath } from '../tools/AgentTool/agentMemory.js'
import { getMercuryHome } from './envUtils.js'
import { posixPathToWindowsPath, windowsPathToPosixPath } from './windowsPaths.js'


const isWindows = process.platform === 'win32'

function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return isWindows ? slashed.toLowerCase() : slashed
}

function comparableNormalized(path: string): string {
  return comparable(normalize(path))
}

function underDirectory(path: string, directory: string): boolean {
  const dir = comparable(directory).replace(/\/+$/, '')
  return path === dir || path.startsWith(`${dir}/`)
}


export function detectSessionFileType(filePath: string): 'session_memory' | 'session_transcript' | null {
  const path = comparable(filePath)
  if (!underDirectory(path, getMercuryHome())) return null
  if (path.includes('/session-memory/') && path.endsWith('.md')) return 'session_memory'
  if (path.includes('/projects/') && path.endsWith('.jsonl')) return 'session_transcript'
  return null
}

export function detectSessionPatternType(pattern: string): 'session_memory' | 'session_transcript' | null {
  const normalized = pattern.replace(/\\/g, '/')
  if (normalized.includes('session-memory') && (normalized.includes('.md') || normalized.endsWith('*'))) {
    return 'session_memory'
  }
  if (normalized.includes('.jsonl')) return 'session_transcript'
  if (normalized.includes('projects') && normalized.includes('*.jsonl')) return 'session_transcript'
  return null
}


export function isAutoMemFile(filePath: string): boolean {
  if (!isAutoMemoryEnabled()) return false
  return isAutoMemPath(filePath)
}

export type MemoryScope = 'personal' | 'team'

export function memoryScopeForPath(filePath: string): MemoryScope | null {
  return isAutoMemFile(filePath) ? 'personal' : null
}

function isAgentMemFile(filePath: string): boolean {
  if (!isAutoMemoryEnabled()) return false
  return isAgentMemoryPath(filePath)
}

export function isAutoManagedMemoryFile(filePath: string): boolean {
  return isAutoMemFile(filePath) || detectSessionFileType(filePath) !== null || isAgentMemFile(filePath)
}

export function isMemoryDirectory(dirPath: string): boolean {
  const path = comparableNormalized(dirPath)
  const withSlash = `${path}/`
  if (isAutoMemoryEnabled()) {
    if (withSlash.includes('/agent-memory/') || withSlash.includes('/agent-memory-local/')) return true
    const autoMem = comparable(getAutoMemPath())
    if (path === autoMem.replace(/\/+$/, '') || path.startsWith(autoMem)) return true
  }
  const home = getMercuryHome()
  const memoryBase = getMemoryBaseDir()
  const underHome = underDirectory(path, home)
  const underMemoryBase = underDirectory(path, memoryBase)
  if (!underHome && !underMemoryBase) return false
  if (withSlash.includes('/session-memory/')) return true
  if (underHome && withSlash.includes('/projects/')) return true
  if (isAutoMemoryEnabled() && withSlash.includes('/memory/')) return true
  return false
}


function toMingw(path: string): string {
  const posix = windowsPathToPosixPath(path) as string
  return comparable(posix)
}

const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`]*/g

export function isShellCommandTargetingMemory(command: string): boolean {
  const normalizedCommand = comparable(command)
  const roots = [getMercuryHome(), getMemoryBaseDir(), getAutoMemPath()]
  const mentioned = roots.some(root => {
    if (normalizedCommand.includes(comparable(root))) return true
    if (isWindows && normalizedCommand.includes(toMingw(root))) return true
    return false
  })
  if (!mentioned) return false
  const tokens = command.match(PATH_TOKEN) ?? []
  for (const rawToken of tokens) {
    let token = rawToken.replace(/[,;|&>]+$/, '')
    if (isWindows && /^\/[A-Za-z](\/|$)/.test(token)) {
      token = posixPathToWindowsPath(token) as string
    }
    if (isAutoManagedMemoryFile(token) || isMemoryDirectory(token)) return true
  }
  return false
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  if (detectSessionPatternType(pattern) !== null) return true
  if (!isAutoMemoryEnabled()) return false
  const normalized = pattern.replace(/\\/g, '/')
  return normalized.includes('agent-memory/') || normalized.includes('agent-memory-local/')
}
