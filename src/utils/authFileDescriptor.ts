import { readFileSync } from 'node:fs'

import { logForDebugging } from './debug.js'

type Slot = string | null | undefined

let oauthTokenSlot: Slot = undefined
let apiKeySlot: Slot = undefined

function fdPath(fd: number): string {
  return process.platform === 'darwin' || process.platform === 'freebsd'
    ? `/dev/fd/${fd}`
    : `/proc/self/fd/${fd}`
}

function resolveCredential(config: {
  slot: Slot
  setSlot: (value: Slot) => void
  envVar: string
  tokenName: string
}): string | null {
  if (config.slot !== undefined) return config.slot

  const fdRaw = process.env[config.envVar]
  if (fdRaw === undefined) {
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
