import { hostEnv } from '../environment/hostEnv.js'

export function desktopOpenPathCommand(filePath: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const file = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open'
  return { file, args: [filePath] }
}

export function desktopOpenUrlCommand(
  url: string,
  browserEnv: string | undefined = hostEnv().BROWSER,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (browserEnv) return { file: browserEnv, args: [url] }
  if (platform === 'win32') return { file: 'rundll32', args: ['url,OpenURL', url] }
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}
