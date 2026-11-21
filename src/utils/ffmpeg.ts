import { spawn } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { ffmpegInstallCommandWords } from './platform/words.js'

export function spawnFfmpeg(args: string[], signal: AbortSignal) {
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true, env: subprocessEnv() })
}

export function ffmpegInstallCommand(platform: string = process.platform): string {
  return ffmpegInstallCommandWords(platform)
}
