/**
 * Spawner credential injection: an out-of-process spawner can hand this
 * process the OAuth token or the API key as an open file descriptor, named
 * by the environment variables registered below.
 *
 * Both credentials are read through one shared routine that differs only in
 * its environment-variable name, its label, and which process-wide cache
 * slot it uses. A resolved value — INCLUDING null — short-circuits every
 * later call, so each credential resolves at most once per process and a
 * negative result is never retried.
 */
import { readFileSync } from 'node:fs'

import { logForDebugging } from './debug.js'

/** Tri-state cache: undefined = unresolved, string, or null = resolved-nothing. */
type Slot = string | null | undefined

let oauthTokenSlot: Slot = undefined
let apiKeySlot: Slot = undefined

/** The platform file-descriptor path form. */
function fdPath(fd: number): string {
  return process.platform === 'darwin' || process.platform === 'freebsd'
    ? `/dev/fd/${fd}`
    : `/proc/self/fd/${fd}`
}

/** The shared resolution routine: the named env var, holding an open fd number. */
function resolveCredential(config: {
  slot: Slot
  setSlot: (value: Slot) => void
  envVar: string
  tokenName: string
}): string | null {
  if (config.slot !== undefined) return config.slot

  const fdRaw = process.env[config.envVar]
  if (fdRaw === undefined) {
    // Every process without a spawner-injected credential.
    config.setSlot(null)
    return null
  }

  const fd = Number(fdRaw)
  if (!Number.isInteger(fd)) {
    logForDebugging(`${config.tokenName}: ${config.envVar} is not an integer: ${fdRaw}`)
    config.setSlot(null)
    return null
  }

  try {
    const content = readFileSync(fdPath(fd), 'utf-8').trim()
    if (content === '') {
      logForDebugging(`${config.tokenName}: file descriptor produced empty content`)
      config.setSlot(null)
      return null
    }
    config.setSlot(content)
    return content
  } catch (error) {
    // The common subprocess case: the variable was inherited but the pipe
    // was not.
    logForDebugging(`${config.tokenName}: fd read failed (${String(error)})`)
    config.setSlot(null)
    return null
  }
}

export function getOAuthTokenFromFileDescriptor(): string | null {
  return resolveCredential({
    slot: oauthTokenSlot,
    setSlot: value => {
      oauthTokenSlot = value
    },
    envVar: 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
    tokenName: 'oauth token',
  })
}

export function getApiKeyFromFileDescriptor(): string | null {
  return resolveCredential({
    slot: apiKeySlot,
    setSlot: value => {
      apiKeySlot = value
    },
    envVar: 'MERCURY_API_KEY_FILE_DESCRIPTOR',
    tokenName: 'api key',
  })
}
