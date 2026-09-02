import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { createAxiosInstance } from './proxy.js'
import { whichSync } from './which.js'

/**
 * Static environment facts: platform, terminal, deployment environment,
 * package managers, and the global-config file path.
 */

/**
 * The single global-config JSON file, memoized: a legacy `.config.json`
 * directly in the home wins outright (Mercury's own pre-suffix layout,
 * honored in place); otherwise the canonical `.mercury<suffix>.json`.
 * (The one-time `.claude<suffix>.json` adoption retired with the compat
 * era — adopting another tool's config is an agent recipe now.)
 */
export const getGlobalMercuryFile = memoize((): string => {
  const home = getMercuryHome()
  const legacyPath = join(home, '.config.json')
  if (existsSync(legacyPath)) return legacyPath
  const suffix = fileSuffixForOauthConfig()
  return join(home, `.mercury${suffix}.json`)
})

/**
 * The JetBrains family list, shared with the dynamic ancestor walk. Order is
 * contract: it decides which family a multi-match bundle id or command line
 * resolves to, and the first entry is the fixed JediTerm answer.
 */
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

// Everything that is neither Windows nor macOS collapses to Linux.
function normalizedPlatform(): NormalizedPlatform {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

function isSshSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
}

/**
 * Terminal detection. Ordering is load-bearing: the askpass-path rows must
 * precede the bundle-identifier block (several editor forks report the
 * generic editor value in TERM_PROGRAM under WSL), and the TERM rows must
 * precede TERM_PROGRAM because the two are frequently inconsistent. The
 * returned identifiers are analytics dimensions.
 */
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
    // The fixed generic answer on every platform; the finer-grained answer
    // needs the async ancestor walk in envDynamic.
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

// Contract data for the filesystem probes.
const WSL_INTEROP_MARKER = '/proc/sys/fs/binfmt_misc/WSLInterop'
const DOCKER_MARKER = '/.dockerenv'
const HYPERVISOR_UUID_FILE = '/sys/hypervisor/uuid'
const DIGITALOCEAN_APP_DOMAIN = 'ondigitalocean.app'
const CONDUCTOR_BUNDLE_ID = 'com.conductor.app'

/**
 * Deployment-environment detection: the first match from an ordered probe
 * list. Note the mixed predicate style — some rows test env truthiness and
 * some mere presence — which must be reproduced. Values are analytics
 * dimensions.
 */
export const detectDeploymentEnvironment = memoize((): string => {
  const envVars = process.env
  // Cloud dev environments.
  if (isEnvTruthy(envVars.CODESPACES)) return 'codespaces'
  if (envVars.GITPOD_WORKSPACE_ID) return 'gitpod'
  if (envVars.REPL_ID || envVars.REPL_SLUG) return 'replit'
  if (envVars.PROJECT_DOMAIN) return 'glitch'
  // Cloud platforms.
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
    // Fall through to the next row.
  }
  if (envVars.K_SERVICE) return 'gcp-cloud-run'
  if (envVars.GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (envVars.WEBSITE_SITE_NAME || envVars.WEBSITE_SKU) return 'azure-app-service'
  if (envVars.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (envVars.APP_URL?.includes(DIGITALOCEAN_APP_DOMAIN)) return 'digitalocean-app-platform'
  if (envVars.SPACE_CREATOR_USER_ID) return 'huggingface-spaces'
  // CI.
  if (isEnvTruthy(envVars.GITHUB_ACTIONS)) return 'github-actions'
  if (isEnvTruthy(envVars.GITLAB_CI)) return 'gitlab-ci'
  if (envVars.CIRCLECI) return 'circleci'
  if (envVars.BUILDKITE) return 'buildkite'
  if (isEnvTruthy(envVars.CI)) return 'ci'
  // Containers.
  if (envVars.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  try {
    if (existsSync(DOCKER_MARKER)) return 'docker'
  } catch {
    // Fall through to the platform fallback.
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

/** Static environment facts, built once at module load. */
export const env = {
  isCI: isEnvTruthy(process.env.CI),
  platform: normalizedPlatform(),
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSSH: isSshSession,
  // Both keep the async (Promise-returning) exported shape.
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
  /**
   * A HEAD request over plain HTTP to the well-known public resolver with a
   * one-second abort; any failure means no internet. Routed through the
   * shared proxy-aware axios instance so proxy environment variables are
   * honoured. Memoized.
   */
  hasInternetAccess: memoize(async (): Promise<boolean> => {
    try {
      await createAxiosInstance().head('http://1.1.1.1', { timeout: 1000 })
      return true
    } catch {
      return false
    }
  }),
}

/**
 * Reported platform for analytics: the env override wins only when it is
 * exactly one of the three legal strings.
 */
export function getHostPlatformForAnalytics(): 'win32' | 'darwin' | 'linux' {
  return normalizedPlatform()
}
