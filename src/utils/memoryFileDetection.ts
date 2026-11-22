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
  return notBuilt('src/utils/memoryFileDetection.ts:58')
}

export function isMemoryDirectory(dirPath: string): boolean {
  return notBuilt('src/utils/memoryFileDetection.ts:62')
}

export function isShellCommandTargetingMemory(command: string): boolean {
  return notBuilt('src/utils/memoryFileDetection.ts:84')
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  return notBuilt('src/utils/memoryFileDetection.ts:99')
}
