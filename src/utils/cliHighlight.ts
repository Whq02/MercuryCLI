import { colorStripped } from '../ink/colorize.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type CliHighlight = Unbuilt

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
  return notBuilt('src/utils/cliHighlight.ts:29')
}

let sharedApiPromise: Promise<CliHighlight | null> | null = null

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  if (!sharedApiPromise) {
    sharedApiPromise = loadBundle().then(bundle => bundle.api)
  }
  return sharedApiPromise
}

