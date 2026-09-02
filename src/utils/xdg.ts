import { homedir } from 'node:os'
import { join } from 'node:path'


export type XdgOptions = {
  env?: Record<string, string | undefined>
  homedir?: string
}

function resolveHome(options?: XdgOptions): string {
  return options?.homedir ?? process.env.HOME ?? homedir()
}

export function getXDGStateHome(options?: XdgOptions): string {
  const env = options?.env ?? process.env
  return env.XDG_STATE_HOME ?? join(resolveHome(options), '.local', 'state')
}

export function getXDGDataHome(options?: XdgOptions): string {
  const env = options?.env ?? process.env
  return env.XDG_DATA_HOME ?? join(resolveHome(options), '.local', 'share')
}

export function getUserBinDir(options?: XdgOptions): string {
  return join(resolveHome(options), '.local', 'bin')
}
