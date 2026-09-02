import { extname } from 'node:path'

/**
 * Lazy shared loader for the syntax-highlighting libraries, plus the
 * extension→language-name lookup used for telemetry.
 *
 * One shared promise loads `cli-highlight` and, immediately after, the
 * underlying `highlight.js` — the second load is free in practice, since
 * the first library depends on the second and it is already in the module
 * cache by then. A load failure resolves to null (never throws) and the
 * null is cached like any other result: no retry.
 */
export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

type LanguageLookup = (name: string) => { name?: string } | undefined

type LoadedBundle = {
  api: CliHighlight | null
  getLanguage: LanguageLookup | null
}

/**
 * The pathological-input guard (sweep #2, A1.3): tokenizing a
 * minified bundle or a multi-kilobyte single line costs whole seconds on the
 * render path and paints nothing a reader can use. Past either bound the
 * text is returned unpainted — the same bytes, no colour, no stall. One
 * guard for every consumer, applied inside the shared bundle (law 6).
 */
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
        // highlight.js is CommonJS; the registry lookup is exposed as a named
        // export of the imported namespace at runtime through the ESM/CJS
        // bridge, even though the type declarations place it on the default
        // export.
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

/**
 * The ONE shared promise for the highlighter API. Identity is load-bearing:
 * React consumers hand this promise to `use()`, which treats a different
 * thenable on every render as an uncached suspension and re-renders the
 * tree on its ~300ms fallback throttle for as long as the surface is
 * mounted — a full-frame render storm that also resets child state (a
 * dialog's cursor) on every retry. Deriving a fresh `.then` per call is
 * exactly that bug; the promise is created once and returned as-is.
 */
export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  if (!sharedApiPromise) {
    sharedApiPromise = loadBundle().then(bundle => bundle.api)
  }
  return sharedApiPromise
}

/**
 * The registry's language name for a file's extension, or the literal
 * `unknown` (an analytics attribute value) for an extensionless path, an
 * unrecognised extension, or a failed library load. Never rejects — every
 * caller uses the answer for telemetry, and none awaits it on a
 * user-visible path.
 */
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
