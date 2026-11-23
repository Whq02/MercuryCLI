import { colorStripped } from '../ink/colorize.js'
import { passedOverAs } from './passedOver.js'

export type CliHighlight = Pick<typeof import('cli-highlight'), 'highlight' | 'supportsLanguage'>

type LoadedBundle = {
  api: CliHighlight | null
}

export const MAX_HIGHLIGHT_LINE_CHARS = 2_000
const MAX_HIGHLIGHT_TOTAL_CHARS = 200_000
export function shouldSkipHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_TOTAL_CHARS) return true
  let lineStart = 0
  for (let i = 0; i <= code.length; i++) {
    if (i === code.length || code.charCodeAt(i) === 10) {
      if (i - lineStart > MAX_HIGHLIGHT_LINE_CHARS) return true
      lineStart = i + 1
    }
  }
  return false
}

let sharedLoadPromise: Promise<LoadedBundle> | null = null

function loadBundle(): Promise<LoadedBundle> {
  return sharedLoadPromise ??= import('cli-highlight').then(({ highlight, supportsLanguage }): LoadedBundle => ({
    api: {
      highlight: (code, options) => shouldSkipHighlight(code) || colorStripped() ? code : highlight(code, options),
      supportsLanguage,
    },
  })).catch(passedOverAs({ api: null }))
}

let sharedApiPromise: Promise<CliHighlight | null> | null = null

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  if (!sharedApiPromise) {
    sharedApiPromise = loadBundle().then(bundle => bundle.api)
  }
  return sharedApiPromise
}

