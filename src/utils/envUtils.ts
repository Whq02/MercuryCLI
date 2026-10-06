import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { flagEnv } from '../substrate/flagRegistry.js'
import { readSessionOption } from '../cli/sessionArgs.js'


export const getMercuryHome = memoize((): string => {
  const resolved =
    process.env.MERCURY_CONFIG_DIR || flagEnv('MERCURY_HOME') || join(homedir(), '.mercury')
  return canonicalHomeSpelling(resolved)
}, () =>
  JSON.stringify([
    process.env.MERCURY_CONFIG_DIR ?? null,
    process.env.MERCURY_HOME ?? null,
  ]))

export function canonicalHomeSpelling(raw: string, platform: string = process.platform): string {
  let s = raw.normalize('NFC')
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\').replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`)
  }
  const bareRoot = platform === 'win32' ? /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)$/ : /^\/$/
  if (bareRoot.test(s)) return s
  s = s.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
  return s.length === 0 ? raw.normalize('NFC') : s
}

export function rawConfigHomePinSpelling(): string | null {
  const raw = process.env.MERCURY_CONFIG_DIR || flagEnv('MERCURY_HOME')
  return raw ? raw.normalize('NFC') : null
}


let authScope: string | undefined

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
  return authScope ?? getMercuryHome()
}

export function ensurePrivateConfigHome(): void {
  if (process.platform === 'win32') return
  try {
    const home = getMercuryHome()
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true, mode: 0o700 })
      return
    }
    const permissionBits = statSync(home).mode & 0o777
    if ((permissionBits & 0o077) !== 0) {
      chmodSync(home, permissionBits & 0o700)
    }
  } catch {
  }
}

export function displayConfigHome(): string {
  const home = getMercuryHome()
  const userHome = homedir()
  return home.startsWith(userHome) ? `~${home.slice(userHome.length)}` : home
}

export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
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
  return isEnvTruthy(process.env.MERCURY_BARE) || readSessionOption(process.argv.slice(2), '--lean').present
}
