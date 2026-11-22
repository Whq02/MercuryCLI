import { closeSync, openSync, readSync } from 'node:fs'

import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'
import { notBuilt } from '../../pi/holes.js'


const MAX_SCAN_BYTES = 64 * 1024
const MAX_SYMBOL_LENGTH = 30

const TOKEN_PATTERN = /[\w$'!]+|[+\-*/%&|^~<>=]+/g

export function getSymbolAtPosition(
  filePath: string,
  line0: number,
  character0: number,
): string | null {
  return notBuilt('src/tools/LSPTool/symbolContext.ts:12')
}
