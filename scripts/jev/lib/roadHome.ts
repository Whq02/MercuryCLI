import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const PROOF_HOME_PREFIX = 'mercury-proof-home-'

export function roadHome(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const pinned = env.MERCURY_CONFIG_DIR?.trim()
  if (pinned && !basename(pinned).startsWith(PROOF_HOME_PREFIX)) return pinned
  return join(homedir(), '.mercury')
}
