import { spawn } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'

export function spawnFfmpeg(args: string[], signal: AbortSignal) {
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true, env: subprocessEnv() })
}

export function ffmpegInstallCommand(platform: string = process.platform): string {
  if (platform === 'darwin') return 'brew install ffmpeg'
  if (platform === 'win32') return 'winget install ffmpeg'
  return 'apt install ffmpeg'
}
