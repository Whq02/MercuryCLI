import { fileURLToPath } from 'node:url'
import { openBrowser, openPath } from '../../utils/browser.js'

export async function openSampleUrl(url: string): Promise<boolean> {
  if (url.startsWith('file:')) {
    try {
      return await openPath(fileURLToPath(url))
    } catch {
      return false
    }
  }
  return openBrowser(url)
}
