import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { whichSync } from './which.js'
import { passedOver } from './passedOver.js'
import { hostEnv } from './hostEnv.js'
import { normalizedOsPlatform } from './platform/programs.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'


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

const WSL_INTEROP_MARKER = '/proc/sys/fs/binfmt_misc/WSLInterop'
const DOCKER_MARKER = '/.dockerenv'
const HYPERVISOR_UUID_FILE = '/sys/hypervisor/uuid'
const DIGITALOCEAN_APP_DOMAIN = 'ondigitalocean.app'

export const detectDeploymentEnvironment: Unbuilt = unbuilt('src/utils/env.ts:107')

export const env: Unbuilt = unbuilt('src/utils/env.ts:168')
