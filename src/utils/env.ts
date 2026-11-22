import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { whichSync } from './which.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { normalizedOsPlatform } from './platform/programs.js'

export function globalConfigFileIn(home: string): string {
  const preSuffixPath = join(home, '.config.json')
  if (existsSync(preSuffixPath)) return preSuffixPath
  return join(home, '.mercury.json')
}

export const getGlobalMercuryFile = memoize((): string => globalConfigFileIn(getMercuryHome()))

const JETBRAINS_IDES: string[] = [
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
  return normalizedOsPlatform()
}

function isSshSession(): boolean {
  return Boolean(hostEnv().SSH_CONNECTION || hostEnv().SSH_CLIENT || hostEnv().SSH_TTY)
}

function terminalName(): string | null {
  if (hostEnv().CURSOR_TRACE_ID) return 'cursor'
  const askpass = hostEnv().VSCODE_GIT_ASKPASS_MAIN
  if (askpass) {
    const editor = ['cursor', 'windsurf', 'antigravity'].find(word => askpass.includes(word))
    if (editor) return editor
  }
  const bundle = hostEnv().__CFBundleIdentifier?.toLowerCase()
  if (bundle) {
    if (bundle.includes('vscodium')) return 'codium'
    if (bundle.includes('windsurf')) return 'windsurf'
    if (bundle.includes('com.google.android.studio')) return 'androidstudio'
    const ide = JETBRAINS_IDES.find(word => bundle.includes(word))
    if (ide) return ide
  }
  if (hostEnv().VisualStudioVersion) return 'visualstudio'
  if (hostEnv().TERMINAL_EMULATOR === 'JetBrains-JediTerm') return JETBRAINS_IDES[0]
  const term = hostEnv().TERM
  if (term === 'xterm-ghostty') return 'ghostty'
  if (term?.includes('kitty')) return 'kitty'
  const program = hostEnv().TERM_PROGRAM
  if (program) return program
  if (hostEnv().TMUX) return 'tmux'
  if (hostEnv().STY) return 'screen'
  if (hostEnv().KONSOLE_VERSION) return 'konsole'
  if (hostEnv().GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (hostEnv().XTERM_VERSION) return 'xterm'
  if (hostEnv().VTE_VERSION) return 'vte-based'
  if (hostEnv().TERMINATOR_UUID) return 'terminator'
  if (hostEnv().KITTY_WINDOW_ID) return 'kitty'
  if (hostEnv().ALACRITTY_LOG) return 'alacritty'
  if (hostEnv().TILIX_ID) return 'tilix'
  if (hostEnv().WT_SESSION) return 'windows-terminal'
  if (hostEnv().SESSIONNAME && term === 'cygwin') return 'cygwin'
  const msystem = hostEnv().MSYSTEM
  if (msystem) return msystem.toLowerCase()
  if (hostEnv().ConEmuANSI || hostEnv().ConEmuPID || hostEnv().ConEmuTask) return 'conemu'
  const distro = hostEnv().WSL_DISTRO_NAME
  if (distro) return `wsl-${distro}`
  if (isSshSession()) return 'ssh-session'
  if (term) return ['alacritty', 'rxvt', 'termite'].find(word => term.includes(word)) ?? term
  if (!process.stdout.isTTY) return 'non-interactive'
  return null
}

const WSL_INTEROP_MARKER = '/proc/sys/fs/binfmt_misc/WSLInterop'
const DOCKER_MARKER = '/.dockerenv'
const HYPERVISOR_UUID_FILE = '/sys/hypervisor/uuid'
const DIGITALOCEAN_APP_DOMAIN = 'ondigitalocean.app'

export const detectDeploymentEnvironment = memoize((): string => {
  if (isEnvTruthy(hostEnv().CODESPACES)) return 'codespaces'
  if (hostEnv().GITPOD_WORKSPACE_ID) return 'gitpod'
  if (hostEnv().REPL_ID || hostEnv().REPL_SLUG) return 'replit'
  if (hostEnv().PROJECT_DOMAIN) return 'glitch'
  if (isEnvTruthy(hostEnv().VERCEL)) return 'vercel'
  if (hostEnv().RAILWAY_ENVIRONMENT_NAME || hostEnv().RAILWAY_SERVICE_NAME) return 'railway'
  if (isEnvTruthy(hostEnv().RENDER)) return 'render'
  if (isEnvTruthy(hostEnv().NETLIFY)) return 'netlify'
  if (hostEnv().DYNO) return 'heroku'
  if (hostEnv().FLY_APP_NAME || hostEnv().FLY_MACHINE_ID) return 'fly.io'
  if (isEnvTruthy(hostEnv().CF_PAGES)) return 'cloudflare-pages'
  if (hostEnv().DENO_DEPLOYMENT_ID) return 'deno-deploy'
  if (hostEnv().AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda'
  if (hostEnv().AWS_EXECUTION_ENV === 'AWS_ECS_FARGATE') return 'aws-fargate'
  if (hostEnv().AWS_EXECUTION_ENV === 'AWS_ECS_EC2') return 'aws-ecs'
  try {
    if (readFileSync(HYPERVISOR_UUID_FILE, 'utf8').trim().toLowerCase().startsWith('ec2')) return 'aws-ec2'
  } catch (error) {
    passedOver(error)
  }
  if (hostEnv().K_SERVICE) return 'gcp-cloud-run'
  if (hostEnv().GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (hostEnv().WEBSITE_SITE_NAME || hostEnv().WEBSITE_SKU) return 'azure-app-service'
  if (hostEnv().AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (hostEnv().APP_URL?.includes(DIGITALOCEAN_APP_DOMAIN)) return 'digitalocean-app-platform'
  if (hostEnv().SPACE_CREATOR_USER_ID) return 'huggingface-spaces'
  if (isEnvTruthy(hostEnv().GITHUB_ACTIONS)) return 'github-actions'
  if (isEnvTruthy(hostEnv().GITLAB_CI)) return 'gitlab-ci'
  if (hostEnv().CIRCLECI) return 'circleci'
  if (hostEnv().BUILDKITE) return 'buildkite'
  if (isEnvTruthy(hostEnv().CI)) return 'ci'
  if (hostEnv().KUBERNETES_SERVICE_HOST) return 'kubernetes'
  try {
    if (existsSync(DOCKER_MARKER)) return 'docker'
  } catch (error) {
    passedOver(error)
  }
  return `unknown-${normalizedPlatform()}`
})

const isWslEnvironment = memoize((): boolean => {
  try {
    return existsSync(WSL_INTEROP_MARKER)
  } catch (error) {
    passedOver(error)
    return false
  }
})

export const env = {
  isCI: isEnvTruthy(hostEnv().CI),
  platform: normalizedPlatform(),
  arch: process.arch,
  nodeVersion: process.version,
  terminal: terminalName(),
  isSSH: isSshSession,
  getPackageManagers: memoize(async (): Promise<string[]> =>
    ['npm', 'yarn', 'pnpm'].filter(name => whichSync(name) !== null),
  ),
  getRuntimes: memoize(async (): Promise<string[]> =>
    ['bun', 'deno', 'node'].filter(name => whichSync(name) !== null),
  ),
  isRunningWithBun: memoize((): boolean => process.versions.bun !== undefined),
  isWslEnvironment,
  isNpmFromWindowsPath: memoize((): boolean => {
    if (!isWslEnvironment()) return false
    try {
      return whichSync('npm')?.startsWith('/mnt/c/') === true
    } catch (error) {
      passedOver(error)
      return false
    }
  }),
  detectDeploymentEnvironment,
}
