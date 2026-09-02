import { closeSync, openSync, readSync } from 'node:fs'

import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'


const MAX_SCAN_BYTES = 64 * 1024
const MAX_SYMBOL_LENGTH = 30

const TOKEN_PATTERN = /[\w$'!]+|[+\-*/%&|^~<>=]+/g

export function getSymbolAtPosition(
  filePath: string,
  line0: number,
  character0: number,
): string | null {
  try {
    const expanded = expandPath(filePath)
    const buffer = Buffer.alloc(MAX_SCAN_BYTES)
    const fd = openSync(expanded, 'r')
    let bytesRead: number
    try {
      bytesRead = readSync(fd, buffer, 0, MAX_SCAN_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    if (line0 < 0 || line0 >= lines.length) return null
    if (bytesRead === MAX_SCAN_BYTES && line0 === lines.length - 1) {
      return null
    }
    const line = lines[line0] as string
    if (line.length === 0) return null
    if (character0 < 0 || character0 >= line.length) return null
    TOKEN_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOKEN_PATTERN.exec(line)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (character0 >= start && character0 < end) {
        return match[0].slice(0, MAX_SYMBOL_LENGTH)
      }
      if (start > character0) break
    }
    return null
  } catch (err) {
    logForDebugging(
      `getSymbolAtPosition failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}
