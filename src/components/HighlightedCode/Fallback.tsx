// Async syntax highlighting of a code block with a cached,
// language-tolerant fallback. First paint is never blank (the uncoloured
// text is the Suspense fallback), an unavailable highlighter is never an
// error, and the module-level cache is REQUIRED, not an optimisation: the
// virtual list re-mounts blocks as they scroll back into view, and a
// component memo does not survive unmount → remount.

import React, { Suspense, use } from 'react'
import { Ansi } from '../../ink.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../../utils/cliHighlight.js'
import { logForDebugging } from '../../utils/debug.js'
import { hashPair } from '../../utils/hash.js'

/** Cache keyed by a HASH of (language, code) — never by the source string
 *  itself, which would retain full file bodies. Bounded LRU; a hit is
 *  refreshed to most-recent. */
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
    // Refresh to most-recent.
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

/** Leading tabs misalign against terminal tab stops — convert before
 *  rendering. */
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
  // The highlighter is unavailable in this build/runtime: the uncoloured
  // text is the final render, never an error.
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
