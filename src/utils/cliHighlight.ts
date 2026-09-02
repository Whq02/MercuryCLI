import { extname } from 'node:path'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

type LanguageLookup = (name: string) => { name?: string } | undefined

type LoadedBundle = {
  api: CliHighlight | null
  getLanguage: LanguageLookup | null
}

export const MAX_HIGHLIGHT_LINE_CHARS = 2_000
export const MAX_HIGHLIGHT_TOTAL_CHARS = 200_000
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
  if (!sharedLoadPromise) {
    sharedLoadPromise = (async (): Promise<LoadedBundle> => {
      try {
        const cliHighlight = await import('cli-highlight')
        const hljsNamespace = await import('highlight.js')
        const getLanguage =
          (hljsNamespace as unknown as { getLanguage?: LanguageLookup }).getLanguage ?? null
        const guardedHighlight = ((code: string, options?: Parameters<typeof cliHighlight.highlight>[1]) =>
          shouldSkipHighlight(code) ? code : cliHighlight.highlight(code, options)) as CliHighlight['highlight']
        return {
          api: {
            highlight: guardedHighlight,
            supportsLanguage: cliHighlight.supportsLanguage,
          },
          getLanguage,
        }
      } catch {
        return { api: null, getLanguage: null }
      }
    })()
  }
  return sharedLoadPromise
}

let sharedApiPromise: Promise<CliHighlight | null> | null = null

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  if (!sharedApiPromise) {
    sharedApiPromise = loadBundle().then(bundle => bundle.api)
  }
  return sharedApiPromise
}

export async function getLanguageName(file_path: string): Promise<string> {
  try {
    const { getLanguage } = await loadBundle()
    const extension = extname(file_path).slice(1)
    if (!extension) return 'unknown'
    if (!getLanguage) return 'unknown'
    return getLanguage(extension)?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
