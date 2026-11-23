import * as path from 'node:path'
import { normalizedOsPlatform } from '../../../platform/host-os/programs.js'

type EngineUserPlatform = 'win32' | 'darwin' | 'linux'

function engineUserPlatform(platform: NodeJS.Platform = process.platform): EngineUserPlatform {
  return normalizedOsPlatform(platform)
}

export function engineUserEnv(dir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  switch (engineUserPlatform(platform)) {
    case 'win32':
      return { APPDATA: dir }
    case 'darwin':
      return { HOME: dir }
    case 'linux':
      return { XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir }
  }
}

export function engineUserDataPath(dir: string, projectName: string, platform: NodeJS.Platform = process.platform): string {
  switch (engineUserPlatform(platform)) {
    case 'win32':
      return path.join(dir, 'Godot', 'app_userdata', projectName)
    case 'darwin':
      return path.join(dir, 'Library', 'Application Support', 'Godot', 'app_userdata', projectName)
    case 'linux':
      return path.join(dir, 'godot', 'app_userdata', projectName)
  }
}
