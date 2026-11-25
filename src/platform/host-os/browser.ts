import { execFileNoThrow } from '../processes/execFileNoThrow.js'
import { passedOver } from '../errors/passedOver.js'
import { desktopOpenPathCommand, desktopOpenUrlCommand } from './desktop.js'


export async function openPath(path: string, onError?: (error: string) => void): Promise<boolean> {
  try {
    const cmd = desktopOpenPathCommand(path)
    const result = await execFileNoThrow(cmd.file, cmd.args)
    if (result.code === 0) return true
    onError?.(result.stderr.trim() || `exit code ${result.code}`)
    return false
  } catch (error) {
    passedOver(error)
    onError?.(error instanceof Error ? error.message : String(error))
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

export async function openBrowser(url: string, onError?: (error: string) => void): Promise<boolean> {
  try {
    assertValidBrowserUrl(url)
    const cmd = desktopOpenUrlCommand(url)
    const result = await execFileNoThrow(cmd.file, cmd.args)
    if (result.code === 0) return true
    onError?.(result.stderr.trim() || `exit code ${result.code}`)
    return false
  } catch (error) {
    passedOver(error)
    onError?.(error instanceof Error ? error.message : String(error))
    return false
  }
}

export function tabsOpenBehindTheOneOnShow(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}
