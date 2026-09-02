import { execFileNoThrow } from './execFileNoThrow.js'

/**
 * Open URLs and filesystem paths with the platform handler.
 *
 * URLs handed to a handler are always passed as bare argv elements, never
 * wrapped in quote characters: the process helper passes argv through with
 * no shell, so added quotes would become part of the argument — and a
 * browser handed a quoted URL opens a web search for it instead of
 * navigating, which broke the sign-in flow on Windows for anyone with
 * BROWSER set.
 */

/**
 * Open a filesystem path with the platform file handler. Success is a zero
 * exit code — applied uniformly, including to the Windows handler, which is
 * not reliably zero-exiting; callers treat a false here as advisory.
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    const opener =
      process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const result = await execFileNoThrow(opener, [path])
    return result.code === 0
  } catch {
    return false
  }
}

function assertValidBrowserUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL format: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open URL with protocol '${parsed.protocol}' — only http: and https: are supported`)
  }
}

/**
 * Open a URL in the default (or BROWSER-designated) browser. The URL must be
 * http: or https:; anything else yields false without executing anything.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    assertValidBrowserUrl(url)
    if (process.platform === 'win32') {
      const browserEnv = process.env.BROWSER
      if (browserEnv) {
        const result = await execFileNoThrow(browserEnv, [url])
        return result.code === 0
      }
      // The explicitly empty options object makes the helper run in the
      // process's own working directory rather than the tracked one —
      // inconsequential for rundll32, but the shipped call shape.
      const result = await execFileNoThrow('rundll32', ['url,OpenURL', url], {})
      return result.code === 0
    }
    const handler = process.env.BROWSER ?? (process.platform === 'darwin' ? 'open' : 'xdg-open')
    const result = await execFileNoThrow(handler, [url])
    return result.code === 0
  } catch {
    return false
  }
}
