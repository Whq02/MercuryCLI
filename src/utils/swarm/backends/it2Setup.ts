import { homedir } from 'node:os'

import { getGlobalConfig, saveGlobalConfig } from '../../config/globalConfig.js'
import { logForDebugging } from '../../debug.js'
import { execFileNoThrowWithCwd } from '../../execFileNoThrow.js'
import { logError } from '../../log.js'
import { which } from '../../which.js'
import { IT2_COMMAND } from './detection.js'


export type PythonPackageManager = 'uvx' | 'pipx' | 'pip'

export type It2InstallResult = {
  success: boolean
  error?: string
  packageManager?: PythonPackageManager
}

export type It2VerifyResult = {
  success: boolean
  error?: string
  needsPythonApiEnabled?: boolean
}

export async function detectPythonPackageManager(): Promise<PythonPackageManager | null> {
  if ((await which('uv')) !== null) {
    logForDebugging('it2 setup: found uv')
    return 'uvx'
  }
  logForDebugging('it2 setup: uv not found')
  if ((await which('pipx')) !== null) {
    logForDebugging('it2 setup: found pipx')
    return 'pipx'
  }
  logForDebugging('it2 setup: pipx not found')
  if ((await which('pip')) !== null) {
    logForDebugging('it2 setup: found pip')
    return 'pip'
  }
  logForDebugging('it2 setup: pip not found')
  if ((await which('pip3')) !== null) {
    logForDebugging('it2 setup: found pip3')
    return 'pip'
  }
  logForDebugging('it2 setup: no python package manager found')
  return null
}

export async function isIt2CliAvailable(): Promise<boolean> {
  return (await which(IT2_COMMAND)) !== null
}

export async function installIt2(packageManager: PythonPackageManager): Promise<It2InstallResult> {
  const home = homedir()
  let outcome
  if (packageManager === 'uvx') {
    outcome = await execFileNoThrowWithCwd('uv', ['tool', 'install', 'it2'], { cwd: home })
  } else if (packageManager === 'pipx') {
    outcome = await execFileNoThrowWithCwd('pipx', ['install', 'it2'], { cwd: home })
  } else {
    outcome = await execFileNoThrowWithCwd('pip', ['install', '--user', 'it2'], { cwd: home })
    if (outcome.code !== 0) {
      outcome = await execFileNoThrowWithCwd('pip3', ['install', '--user', 'it2'], { cwd: home })
    }
  }
  if (outcome.code !== 0) {
    const error = outcome.stderr || 'unknown installation error'
    logError(new Error(`it2 installation failed: ${error}`))
    return { success: false, error, packageManager }
  }
  return { success: true, packageManager }
}

export async function verifyIt2Setup(): Promise<It2VerifyResult> {
  if (!(await isIt2CliAvailable())) {
    return { success: false, error: 'The it2 CLI is not installed on PATH' }
  }
  const outcome = await execFileNoThrowWithCwd(IT2_COMMAND, ['session', 'list'], {})
  if (outcome.code === 0) return { success: true }
  const stderr = outcome.stderr.toLowerCase()
  if (
    stderr.includes('api') ||
    stderr.includes('python') ||
    stderr.includes('connection refused') ||
    stderr.includes('not enabled')
  ) {
    return {
      success: false,
      error: 'The iTerm2 Python API is not enabled',
      needsPythonApiEnabled: true,
    }
  }
  return { success: false, error: outcome.stderr || 'Failed to communicate with iTerm2' }
}

export function getPythonApiInstructions(): string[] {
  return [
    'Enable the iTerm2 Python API to let Mercury manage split panes:',
    '',
    '  iTerm2 → Settings → General → Magic → Enable Python API',
    '',
    'You may need to restart iTerm2 after enabling it.',
  ]
}

export function markIt2SetupComplete(): void {
  const current = getGlobalConfig()
  if (current.iterm2It2SetupComplete !== true) {
    saveGlobalConfig(config => ({ ...config, iterm2It2SetupComplete: true }))
  }
  logForDebugging('it2 setup: marked complete')
}

export function setPreferTmuxOverIterm2(prefer: boolean): void {
  const current = getGlobalConfig()
  if (current.preferTmuxOverIterm2 !== prefer) {
    saveGlobalConfig(config => ({ ...config, preferTmuxOverIterm2: prefer }))
  }
  logForDebugging(`it2 setup: prefer tmux over iTerm2 = ${prefer}`)
}

export function getPreferTmuxOverIterm2(): boolean {
  return getGlobalConfig().preferTmuxOverIterm2 === true
}
