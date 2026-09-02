
import React, { Suspense, use } from 'react'
import { Ansi } from '../../ink.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../../utils/cliHighlight.js'
import { logForDebugging } from '../../utils/debug.js'
import { hashPair } from '../../utils/hash.js'

const highlightCache = new Map<string, string>()
const HIGHLIGHT_CACHE_LIMIT = 500

function cachedHighlight(
  api: CliHighlight,
  code: string,
  language: string,
): string {
  const key = hashPair(language, code)
  const hit = highlightCache.get(key)
  if (hit !== undefined) {
    highlightCache.delete(key)
    highlightCache.set(key, hit)
    return hit
  }
  let painted: string
  const supported = api.supportsLanguage(language)
  const effectiveLanguage = supported ? language : 'markdown'
  if (!supported) {
    logForDebugging(
      `syntax highlight: unsupported language '${language}', falling back to markdown`,
    )
  }
  try {
    painted = api.highlight(code, { language: effectiveLanguage })
  } catch (error) {
    if (String(error).toLowerCase().includes('unknown language')) {
      try {
        painted = api.highlight(code, { language: 'markdown' })
      } catch {
        painted = code
      }
    } else {
      painted = code
    }
  }
  if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value
    if (oldest !== undefined) highlightCache.delete(oldest)
  }
  highlightCache.set(key, painted)
  return painted
}

function detabbed(code: string): string {
  return code.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

function languageOf(filePath: string): string {
  const at = filePath.lastIndexOf('.')
  return at === -1 ? '' : filePath.slice(at + 1)
}

function AsyncHighlight({
  code,
  language,
  dim,
}: {
  code: string
  language: string
  dim: boolean
}): React.ReactNode {
  const api = use(getCliHighlightPromise())
  if (!api) return <Ansi dimColor={dim}>{code}</Ansi>
  return <Ansi dimColor={dim}>{cachedHighlight(api, code, language)}</Ansi>
}

export function HighlightedCodeFallback({
  code,
  filePath,
  dim = false,
  skipColoring = false,
}: {
  code: string
  filePath: string
  dim?: boolean
  skipColoring?: boolean
}): React.ReactNode {
  const text = detabbed(code)
  if (skipColoring) return <Ansi dimColor={dim}>{text}</Ansi>
  return (
    <Suspense fallback={<Ansi dimColor={dim}>{text}</Ansi>}>
      <AsyncHighlight code={text} language={languageOf(filePath)} dim={dim} />
    </Suspense>
  )
}

export default HighlightedCodeFallback
