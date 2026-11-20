import { fileURLToPath } from 'node:url'
import { openBrowser, openPath } from '../../utils/browser.js'
import { passedOver } from '../../utils/passedOver.js'

export async function openSampleUrl(url: string): Promise<boolean> {
  if (url.startsWith('file:')) {
    try {
      return await openPath(fileURLToPath(url))
    } catch (error) {
      passedOver(error)
      return false
    }
  }
  return openBrowser(url)
}
