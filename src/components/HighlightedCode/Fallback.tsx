import React, { Suspense, use } from 'react'
import { LRUCache } from 'lru-cache'
import { Ansi } from '../../ink.js'
import {
  getCliHighlightPromise,
  type CliHighlight,
} from '../../utils/cliHighlight.js'
import { logForDebugging } from '../../utils/debug.js'
import { hashPair } from '../../utils/hash.js'
import { linkifyCodeUrls } from '../../utils/hyperlink.js'
import { passedOver } from '../../utils/passedOver.js'

const HIGHLIGHT_CACHE_LIMIT = 500
const highlightCache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_LIMIT })

function detabbed(code: string): string {
  return code.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))
}

function languageOf(filePath: string): string {
  const at = filePath.lastIndexOf('.')
  return at === -1 ? '' : filePath.slice(at + 1)
}

function highlightText(
  api: CliHighlight,
  language: string,
  prepared: string,
): string {
  const key = hashPair(language, prepared)
  const cached = highlightCache.get(key)
  if (cached !== undefined) return cached

  let chosen = language
  if (!api.supportsLanguage(language)) {
    logForDebugging(
      `syntax highlight: unsupported language '${language}', falling back to markdown`,
    )
    chosen = 'markdown'
  }

  let result: string
  try {
    result = api.highlight(prepared, { language: chosen })
  } catch (error) {
    passedOver(error)
    const message = error instanceof Error ? error.message : String(error)
    if (/unknown language/i.test(message)) {
      try {
        result = api.highlight(prepared, { language: 'markdown' })
      } catch (retryError) {
        passedOver(retryError)
        result = prepared
      }
    } else {
      result = prepared
    }
  }

  highlightCache.set(key, result)
  return result
}

function HighlightedInner({
  prepared,
  language,
  dim,
}: {
  prepared: string
  language: string
  dim: boolean
}): React.ReactNode {
  const api = use(getCliHighlightPromise())
  const text = api ? highlightText(api, language, prepared) : prepared
  return <Ansi dimColor={dim}>{linkifyCodeUrls(text)}</Ansi>
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
  const prepared = detabbed(code)
  const plain = <Ansi dimColor={dim}>{linkifyCodeUrls(prepared)}</Ansi>
  if (skipColoring) return plain
  const language = languageOf(filePath)
  return (
    <Suspense fallback={plain}>
      <HighlightedInner prepared={prepared} language={language} dim={dim} />
    </Suspense>
  )
}
