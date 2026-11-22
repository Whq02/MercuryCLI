import React, { Suspense, use } from 'react'
import { Ansi } from '../../ink.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../../utils/cliHighlight.js'
import { logForDebugging } from '../../utils/debug.js'
import { hashPair } from '../../utils/hash.js'
import { linkifyCodeUrls } from '../../utils/hyperlink.js'
import { notBuilt } from '../../pi/holes.js'

const highlightCache = new Map<string, string>()
const HIGHLIGHT_CACHE_LIMIT = 500

function detabbed(code: string): string {
  return code.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

function languageOf(filePath: string): string {
  const at = filePath.lastIndexOf('.')
  return at === -1 ? '' : filePath.slice(at + 1)
}

export function HighlightedCodeFallback(arg0: {
  code: string
  filePath: string
  dim?: boolean
  skipColoring?: boolean
}): React.ReactNode {
  return notBuilt('src/components/HighlightedCode/Fallback.tsx:79')
}

export default HighlightedCodeFallback
