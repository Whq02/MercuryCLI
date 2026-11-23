import { getPlatform } from '../environment/platform.js'

export function rememberedPlatform(): NodeJS.Platform {
  const platform = getPlatform()
  return platform === 'windows' ? 'win32' : platform === 'macos' ? 'darwin' : platform === 'unknown' ? process.platform : 'linux'
}
