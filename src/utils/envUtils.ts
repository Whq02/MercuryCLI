import { AsyncLocalStorage } from 'node:async_hooks'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

import { memoize } from 'lodash-es'

import { flagEnv } from '../substrate/flagRegistry.js'
import { readSessionOption } from './sessionArgs.js'
import { hostEnv } from './hostEnv.js'
import { canonicalHomePathSpelling, posixFileModesApply } from './platform/files.js'


export function defaultMercuryHome(): string {
  return join(homedir(), '.mercury')
}

export const getMercuryHome = memoize((): string => {
  const resolved =
    flagEnv('MERCURY_CONFIG_DIR') || flagEnv('MERCURY_HOME') || defaultMercuryHome()
  return canonicalHomeSpelling(resolved)
}, () =>
  JSON.stringify([
    flagEnv('MERCURY_CONFIG_DIR') ?? null,
    flagEnv('MERCURY_HOME') ?? null,
  ]))

export function canonicalHomeSpelling(raw: string, platform: string = process.platform): string {
  return canonicalHomePathSpelling(raw, platform)
}

export function rawConfigHomePinSpelling(): string | null {
  const raw = flagEnv('MERCURY_CONFIG_DIR') || flagEnv('MERCURY_HOME')
  return raw ? raw.normalize('NFC') : null
}


let authScope: string | undefined
const scopedAuthHome = new AsyncLocalStorage<string>()
export function withAuthScope<T>(dir: string, work: () => T): T { return scopedAuthHome.run(dir, work) }

export function setAuthScope(dir: string): void {
  authScope = dir
}

export function clearAuthScope(): void {
  authScope = undefined
}

export function getAuthScope(): string | undefined {
  return authScope
}

export function getAuthConfigHomeDir(): string {
  return scopedAuthHome.getStore() ?? authScope ?? getMercuryHome()
}

export function ensurePrivateConfigHome(): void {
  if (!posixFileModesApply()) return
  const home = getMercuryHome()
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    return
  }
  const permissionBits = statSync(home).mode & 0o777
  if ((permissionBits & 0o077) === 0) return
  try {
    chmodSync(home, permissionBits & 0o700)
  } catch (failure) {
    const err = failure as NodeJS.ErrnoException
    const shown = displayConfigHome()
    throw new Error(`the config home ${shown} could not be made private to you (${err.code ?? err.message}), so other users of this machine can read it — make it yours and run: chmod 700 ${shown}`)
  }
}

export function displayConfigHome(): string {
  const home = getMercuryHome()
  const userHome = homedir()
  return home === userHome || home.startsWith(userHome + sep) ? `~${home.slice(userHome.length)}` : home
}

export function hasNodeOption(flag: string): boolean {
  const nodeOptions = hostEnv().NODE_OPTIONS
  if (!nodeOptions) return false
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(v: string | boolean | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === 'boolean') return v
  const normalized = v.toLowerCase().trim()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export function isEnvDefinedFalsy(v: string | boolean | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === 'boolean') return !v
  if (v === '') return false
  const normalized = v.toLowerCase().trim()
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

export function isBareMode(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_BARE')) || readSessionOption(process.argv.slice(2), '--lean').present
}

