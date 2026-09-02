import { execFileNoThrow } from './execFileNoThrow.js'


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

export async function openBrowser(url: string): Promise<boolean> {
  try {
    assertValidBrowserUrl(url)
    if (process.platform === 'win32') {
      const browserEnv = process.env.BROWSER
      if (browserEnv) {
        const result = await execFileNoThrow(browserEnv, [url])
        return result.code === 0
      }
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
