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
  if (line0 < 0 || character0 < 0) return null
  try {
    const resolved = expandPath(filePath)
    const buffer = Buffer.alloc(MAX_SCAN_BYTES)
    let bytesRead = 0
    const fd = openSync(resolved, 'r')
    try {
      bytesRead = readSync(fd, buffer, 0, MAX_SCAN_BYTES, 0)
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf8', 0, bytesRead)
    const lines = text.split('\n')
    if (line0 >= lines.length) return null
    if (bytesRead === MAX_SCAN_BYTES && line0 === lines.length - 1) return null
    const rawLine = lines[line0]!
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (character0 >= line.length) return null
    TOKEN_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOKEN_PATTERN.exec(line)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (character0 >= start && character0 < end) {
        const token = match[0]
        return token.length > MAX_SYMBOL_LENGTH ? token.slice(0, MAX_SYMBOL_LENGTH) : token
      }
      if (start > character0) break
    }
    return null
  } catch (error) {
    logForDebugging(
      `Failed to read symbol context from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return null
  }
}
