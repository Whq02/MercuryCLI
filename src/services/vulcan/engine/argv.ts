import type { EngineManifestDefaults, EngineSuite } from './manifest.js'
import { suiteScenePath, suiteScriptRes } from './manifest.js'

export const NATIVE_RESOLUTION = '1280x720'
export const NATIVE_AUDIO_DRIVER = 'Dummy'
export const CAPTURE_USER_ARG = '--capture'

export function engineImportArgv(root: string): string[] {
  return ['--headless', '--path', root, '--import']
}

export interface SuiteArgvOptions {
  native: boolean
  capture: boolean
}

export function engineSuiteArgv(root: string, suite: EngineSuite, defaults: EngineManifestDefaults, opts: SuiteArgvOptions): string[] {
  const argv: string[] = []
  if (!opts.native) argv.push('--headless')
  argv.push('--path', root)
  if (opts.native) argv.push('--resolution', NATIVE_RESOLUTION, '--audio-driver', NATIVE_AUDIO_DRIVER)
  argv.push('--quit-after', String(suite.quitAfter))
  if (suite.script) argv.push('--script', suiteScriptRes(suite, defaults))
  else argv.push(suiteScenePath(suite, defaults))
  const userArgs = [...suite.userArgs]
  if (opts.capture && !userArgs.includes(CAPTURE_USER_ARG)) userArgs.push(CAPTURE_USER_ARG)
  if (userArgs.length > 0) argv.push('--', ...userArgs)
  return argv
}

export interface MediaArgvOptions {
  headless: boolean
  fixedFps: number | null
  debuggerPort: number | null
  script: string
  config: string
}

export function engineMediaArgv(root: string, opts: MediaArgvOptions): string[] {
  const argv = ['--path', root, '--audio-driver', NATIVE_AUDIO_DRIVER, '--single-window']
  if (opts.headless) argv.push('--headless')
  else argv.push('--resolution', NATIVE_RESOLUTION, '--disable-vsync')
  if (opts.fixedFps !== null) argv.push('--fixed-fps', String(opts.fixedFps))
  if (opts.debuggerPort !== null) argv.push('--remote-debug', `tcp://127.0.0.1:${opts.debuggerPort}`)
  argv.push('--script', opts.script, '--', opts.config)
  return argv
}

export function engineCheckOnlyArgv(root: string, resScript: string): string[] {
  return ['--headless', '--path', root, '--check-only', '--script', resScript]
}

export function engineScriptArgv(root: string, resScript: string): string[] {
  return ['--headless', '--path', root, '--script', resScript]
}

export function engineConsoleSibling(executable: string, platform: NodeJS.Platform, exists: (p: string) => boolean): string {
  if (platform !== 'win32') return executable
  const m = /^(.*?)(_win(?:32|64|arm64))(\.exe)$/i.exec(executable)
  if (!m || /_console$/i.test(m[1])) return executable
  const sibling = `${m[1]}${m[2]}_console${m[3]}`
  return exists(sibling) ? sibling : executable
}
