import { homedir } from 'node:os'

import { getGlobalConfig, saveGlobalConfig } from '../../config/globalConfig.js'
import { logForDebugging } from '../../debug.js'
import { execFileNoThrowWithCwd } from '../../execFileNoThrow.js'
import { logError } from '../../log.js'
import { which } from '../../which.js'
import { IT2_COMMAND } from './detection.js'

/**
 * `it2` installation, verification, and the two persisted preferences.
 */

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

/**
 * Probe `which` in a fixed preference order and return on the first hit:
 * uv (the type name stays `uvx` even though the install command is
 * `uv tool install`), then pipx, then pip, then pip3 (also mapped to pip).
 */
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

/**
 * Binary presence on PATH. This is a DIFFERENT question from the detection
 * module's same-named reachability probe (which lists sessions, so a
 * disabled Python API reads as unavailable) and the two must stay separate —
 * unifying them would make the registry accept an it2 with a dead API and
 * make the setup flow loop (risk R1).
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  return (await which(IT2_COMMAND)) !== null
}

/**
 * Install `it2`, running from the user's home directory so a project-local
 * pip.conf / uv.toml cannot redirect the download to an attacker-chosen
 * index. The pip arm retries with pip3 when the pip attempt exits non-zero.
 */
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

/**
 * Verify the installed CLI can actually talk to iTerm2: presence first, then
 * a session listing. A failure whose stderr mentions the API/Python/
 * connection marks the needs-Python-API case.
 */
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

/** Display lines; the settings path is contract data. */
export function getPythonApiInstructions(): string[] {
  return [
    'Enable the iTerm2 Python API to let Mercury manage split panes:',
    '',
    '  iTerm2 → Settings → General → Magic → Enable Python API',
    '',
    'You may need to restart iTerm2 after enabling it.',
  ]
}

/** Each setter writes the global config only when the value would change. */
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
