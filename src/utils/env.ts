import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { whichSync } from './which.js'


export function globalConfigFileIn(home: string): string {
  const preSuffixPath = join(home, '.config.json')
  if (existsSync(preSuffixPath)) return preSuffixPath
  return join(home, `.mercury${fileSuffixForOauthConfig()}.json`)
}

export const getGlobalMercuryFile = memoize((): string => globalConfigFileIn(getMercuryHome()))

export const JETBRAINS_IDES: string[] = [
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'aqua',
  'gateway',
  'fleet',
  'jetbrains',
  'androidstudio',
]

type NormalizedPlatform = 'win32' | 'darwin' | 'linux'

function normalizedPlatform(): NormalizedPlatform {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

function isSshSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
}

function detectTerminal(): string | null {
  const envVars = process.env
  if (envVars.CURSOR_TRACE_ID) return 'cursor'
  const askpass = envVars.VSCODE_GIT_ASKPASS_MAIN
  if (askpass) {
    if (askpass.includes('cursor')) return 'cursor'
    if (askpass.includes('windsurf')) return 'windsurf'
    if (askpass.includes('antigravity')) return 'antigravity'
  }
  const bundleId = envVars.__CFBundleIdentifier?.toLowerCase()
  if (bundleId) {
    if (bundleId.includes('vscodium')) return 'codium'
    if (bundleId.includes('windsurf')) return 'windsurf'
    if (bundleId.includes('com.google.android.studio')) return 'androidstudio'
    for (const ide of JETBRAINS_IDES) {
      if (bundleId.includes(ide)) return ide
    }
  }
  if (envVars.VisualStudioVersion) return 'visualstudio'
  if (envVars.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    return JETBRAINS_IDES[0] as string
  }
  if (envVars.TERM === 'xterm-ghostty') return 'ghostty'
  if (envVars.TERM?.includes('kitty')) return 'kitty'
  if (envVars.TERM_PROGRAM) return envVars.TERM_PROGRAM
  if (envVars.TMUX) return 'tmux'
  if (envVars.STY) return 'screen'
  if (envVars.KONSOLE_VERSION) return 'konsole'
  if (envVars.GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (envVars.XTERM_VERSION) return 'xterm'
  if (envVars.VTE_VERSION) return 'vte-based'
  if (envVars.TERMINATOR_UUID) return 'terminator'
  if (envVars.KITTY_WINDOW_ID) return 'kitty'
  if (envVars.ALACRITTY_LOG) return 'alacritty'
  if (envVars.TILIX_ID) return 'tilix'
  if (envVars.WT_SESSION) return 'windows-terminal'
  if (envVars.SESSIONNAME && envVars.TERM === 'cygwin') return 'cygwin'
  if (envVars.MSYSTEM) return envVars.MSYSTEM.toLowerCase()
  if (envVars.ConEmuANSI || envVars.ConEmuPID || envVars.ConEmuTask) return 'conemu'
  if (envVars.WSL_DISTRO_NAME) return `wsl-${envVars.WSL_DISTRO_NAME}`
  if (isSshSession()) return 'ssh-session'
  if (envVars.TERM) {
    const term = envVars.TERM
    if (term.includes('alacritty')) return 'alacritty'
    if (term.includes('rxvt')) return 'rxvt'
    if (term.includes('termite')) return 'termite'
    return term
  }
  if (!process.stdout.isTTY) return 'non-interactive'
  return null
}

const WSL_INTEROP_MARKER = '/proc/sys/fs/binfmt_misc/WSLInterop'
const DOCKER_MARKER = '/.dockerenv'
const HYPERVISOR_UUID_FILE = '/sys/hypervisor/uuid'
const DIGITALOCEAN_APP_DOMAIN = 'ondigitalocean.app'
const CONDUCTOR_BUNDLE_ID = 'com.conductor.app'

export const detectDeploymentEnvironment = memoize((): string => {
  const envVars = process.env
  if (isEnvTruthy(envVars.CODESPACES)) return 'codespaces'
  if (envVars.GITPOD_WORKSPACE_ID) return 'gitpod'
  if (envVars.REPL_ID || envVars.REPL_SLUG) return 'replit'
  if (envVars.PROJECT_DOMAIN) return 'glitch'
  if (isEnvTruthy(envVars.VERCEL)) return 'vercel'
  if (envVars.RAILWAY_ENVIRONMENT_NAME || envVars.RAILWAY_SERVICE_NAME) return 'railway'
  if (isEnvTruthy(envVars.RENDER)) return 'render'
  if (isEnvTruthy(envVars.NETLIFY)) return 'netlify'
  if (envVars.DYNO) return 'heroku'
  if (envVars.FLY_APP_NAME || envVars.FLY_MACHINE_ID) return 'fly.io'
  if (isEnvTruthy(envVars.CF_PAGES)) return 'cloudflare-pages'
  if (envVars.DENO_DEPLOYMENT_ID) return 'deno-deploy'
  if (envVars.AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda'
  if (envVars.AWS_EXECUTION_ENV === 'AWS_ECS_FARGATE') return 'aws-fargate'
  if (envVars.AWS_EXECUTION_ENV === 'AWS_ECS_EC2') return 'aws-ecs'
  try {
    const uuid = readFileSync(HYPERVISOR_UUID_FILE, 'utf8').trim().toLowerCase()
    if (uuid.startsWith('ec2')) return 'aws-ec2'
  } catch {
  }
  if (envVars.K_SERVICE) return 'gcp-cloud-run'
  if (envVars.GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (envVars.WEBSITE_SITE_NAME || envVars.WEBSITE_SKU) return 'azure-app-service'
  if (envVars.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (envVars.APP_URL?.includes(DIGITALOCEAN_APP_DOMAIN)) return 'digitalocean-app-platform'
  if (envVars.SPACE_CREATOR_USER_ID) return 'huggingface-spaces'
  if (isEnvTruthy(envVars.GITHUB_ACTIONS)) return 'github-actions'
  if (isEnvTruthy(envVars.GITLAB_CI)) return 'gitlab-ci'
  if (envVars.CIRCLECI) return 'circleci'
  if (envVars.BUILDKITE) return 'buildkite'
  if (isEnvTruthy(envVars.CI)) return 'ci'
  if (envVars.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  try {
    if (existsSync(DOCKER_MARKER)) return 'docker'
  } catch {
  }
  switch (normalizedPlatform()) {
    case 'darwin':
      return 'unknown-darwin'
    case 'linux':
      return 'unknown-linux'
    case 'win32':
      return 'unknown-win32'
    default:
      return 'unknown'
  }
})

const isWslEnvironment = memoize((): boolean => {
  try {
    return existsSync(WSL_INTEROP_MARKER)
  } catch {
    return false
  }
})

export const env = {
  isCI: isEnvTruthy(process.env.CI),
  platform: normalizedPlatform(),
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSSH: isSshSession,
  getPackageManagers: memoize(async (): Promise<string[]> => {
    const managers: string[] = []
    for (const candidate of ['npm', 'yarn', 'pnpm']) {
      if (whichSync(candidate) !== null) managers.push(candidate)
    }
    return managers
  }),
  getRuntimes: memoize(async (): Promise<string[]> => {
    const runtimes: string[] = []
    for (const candidate of ['bun', 'deno', 'node']) {
      if (whichSync(candidate) !== null) runtimes.push(candidate)
    }
    return runtimes
  }),
  isRunningWithBun: memoize((): boolean => Boolean(process.versions?.bun)),
  isWslEnvironment,
  isNpmFromWindowsPath: memoize((): boolean => {
    if (!isWslEnvironment()) return false
    try {
      const npmPath = whichSync('npm')
      return npmPath !== null && npmPath.startsWith('/mnt/c/')
    } catch {
      return false
    }
  }),
  isConductor: (): boolean => process.env.__CFBundleIdentifier === CONDUCTOR_BUNDLE_ID,
  detectDeploymentEnvironment,
}

export function getHostPlatformForAnalytics(): 'win32' | 'darwin' | 'linux' {
  return normalizedPlatform()
}
