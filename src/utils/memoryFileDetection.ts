import { normalize } from 'node:path'

import { getAutoMemPath, getMemoryBaseDir, isAutoMemoryEnabled, isAutoMemPath } from '../memdir/paths.js'
import { isAgentMemoryPath } from '../tools/AgentTool/agentMemory.js'
import { getMercuryHome } from './envUtils.js'
import { posixPathToWindowsPath, windowsPathToPosixPath } from './windowsPaths.js'

/**
 * Classify paths, globs and shell command lines as targeting HARNESS-MANAGED
 * memory (automatic memory, agent memory, session memory, transcripts) — as
 * opposed to user-managed instruction files, which must show full diffs.
 */

const isWindows = process.platform === 'win32'

/** Forward slashes, and lower-case on Windows (case-insensitive filesystem). */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return isWindows ? slashed.toLowerCase() : slashed
}

/** Normalise traversal first, then convert (normalising on Windows yields backslashes, which the conversion flips back). */
function comparableNormalized(path: string): string {
  return comparable(normalize(path))
}

function underDirectory(path: string, directory: string): boolean {
  const dir = comparable(directory).replace(/\/+$/, '')
  return path === dir || path.startsWith(`${dir}/`)
}

// ---------------------------------------------------------------------------
// Session files and patterns
// ---------------------------------------------------------------------------

export function detectSessionFileType(filePath: string): 'session_memory' | 'session_transcript' | null {
  const path = comparable(filePath)
  if (!underDirectory(path, getMercuryHome())) return null
  if (path.includes('/session-memory/') && path.endsWith('.md')) return 'session_memory'
  if (path.includes('/projects/') && path.endsWith('.jsonl')) return 'session_transcript'
  return null
}

/** Separator normalisation only — no case folding, no home test — for glob and search patterns. */
export function detectSessionPatternType(pattern: string): 'session_memory' | 'session_transcript' | null {
  const normalized = pattern.replace(/\\/g, '/')
  if (normalized.includes('session-memory') && (normalized.includes('.md') || normalized.endsWith('*'))) {
    return 'session_memory'
  }
  if (normalized.includes('.jsonl')) return 'session_transcript'
  if (normalized.includes('projects') && normalized.includes('*.jsonl')) return 'session_transcript'
  return null
}

// ---------------------------------------------------------------------------
// Automatic and agent memory
// ---------------------------------------------------------------------------

export function isAutoMemFile(filePath: string): boolean {
  if (!isAutoMemoryEnabled()) return false
  return isAutoMemPath(filePath)
}

export type MemoryScope = 'personal' | 'team'

/** The team scope (a subdirectory of the automatic-memory directory, so it must be checked FIRST) is not wired in this build. */
export function memoryScopeForPath(filePath: string): MemoryScope | null {
  return isAutoMemFile(filePath) ? 'personal' : null
}

function isAgentMemFile(filePath: string): boolean {
  if (!isAutoMemoryEnabled()) return false
  return isAgentMemoryPath(filePath)
}

/** The union: automatic memory, a session file of either kind, or agent memory. */
export function isAutoManagedMemoryFile(filePath: string): boolean {
  return isAutoMemFile(filePath) || detectSessionFileType(filePath) !== null || isAgentMemFile(filePath)
}

/** For tools that take a directory. Traversal is normalised first (a security requirement). */
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

// ---------------------------------------------------------------------------
// Shell commands and patterns
// ---------------------------------------------------------------------------

/** `/c/Users/…` — the POSIX-emulation shell's encoding of a Windows path. */
function toMingw(path: string): string {
  const posix = windowsPathToPosixPath(path) as string
  return comparable(posix)
}

/** Absolute path-like tokens: a drive letter + colon + separator, or a leading slash, up to whitespace or a quote. A leading bare backslash never starts a token. */
const PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`]*/g

/**
 * Cheap pre-filter on the memory roots (MinGW forms only on Windows — on a
 * Unix host a single-letter first component is an ordinary directory), then
 * extract path-like tokens, strip trailing shell metacharacters, convert
 * MinGW forms to native on Windows only, and classify each.
 */
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

/** Instruction files and rule directories are deliberately excluded. */
export function isAutoManagedMemoryPattern(pattern: string): boolean {
  if (detectSessionPatternType(pattern) !== null) return true
  if (!isAutoMemoryEnabled()) return false
  const normalized = pattern.replace(/\\/g, '/')
  return normalized.includes('agent-memory/') || normalized.includes('agent-memory-local/')
}
