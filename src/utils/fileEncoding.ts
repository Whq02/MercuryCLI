import { logForDebugging } from './debug.js'
import { getErrnoCode, isFsInaccessible } from './errors.js'
import { detectEncodingForResolvedPath } from './fileRead.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { logError } from './log.js'

export function needsPowerShellBom(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:ps1|psm1|psd1)$/i.test(filePath)
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    return detectEncodingForResolvedPath(safeResolvePath(getFsImplementation(), filePath).resolvedPath)
  } catch (error) {
    if (isFsInaccessible(error)) logForDebugging(`detectFileEncoding: inaccessible (${getErrnoCode(error) ?? 'unknown'}): ${filePath}`)
    else logError(error)
    return 'utf8'
  }
}
