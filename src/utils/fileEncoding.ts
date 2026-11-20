import { logForDebugging } from './debug.js'
import { isFsInaccessible, getErrnoCode } from './errors.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { detectEncodingForResolvedPath } from './fileRead.js'
import { logError } from './log.js'

export function needsPowerShellBom(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  return /\.(ps1|psm1|psd1)$/i.test(filePath)
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
    return detectEncodingForResolvedPath(resolvedPath)
  } catch (err) {
    if (isFsInaccessible(err)) {
      logForDebugging(`detectFileEncoding: inaccessible (${getErrnoCode(err) ?? 'unknown'}): ${filePath}`)
    } else {
      logError(err)
    }
    return 'utf8'
  }
}
