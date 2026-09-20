import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function defaultConfigHome(): string {
  return resolve(join(homedir(), '.mercury'))
}

export function configHomeIsReal(env: NodeJS.ProcessEnv = process.env): boolean {
  const pinned = env.MERCURY_CONFIG_DIR?.trim()
  if (pinned === undefined || pinned === '') return true
  return resolve(pinned) === defaultConfigHome()
}

export function guardLoginDriverWrite(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (configHomeIsReal(env)) {
    const pinned = env.MERCURY_CONFIG_DIR?.trim()
    const home = pinned === undefined || pinned === '' ? (env.MERCURY_HOME?.trim() || defaultConfigHome()) : resolve(pinned)
    throw new Error(
      `refusing ${what}: the config home is the operator's real store (${home}). A login driver writes a credential into whatever config home resolves, so a proof must pin MERCURY_CONFIG_DIR to a scratch home of its own first.`,
    )
  }
}
