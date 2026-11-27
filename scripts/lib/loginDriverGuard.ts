import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { accountHome } from './proofGuard.cjs'

export function defaultConfigHome(): string {
  return resolve(join(homedir(), '.mercury'))
}

export function configHomeIsReal(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): boolean {
  const pinned = env.MERCURY_CONFIG_DIR?.trim()
  if (pinned === undefined || pinned === '') return true
  const named = resolve(cwd, pinned)
  const target = canonicalPath(named)
  const root = canonicalPath(defaultConfigHome())
  const inside = relative(root, target)
  if (inside === '' || inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return true
  return [named, target].some(operatorsOwnStore)
}

function operatorsOwnStore(path: string): boolean {
  let folder = parse(path).root
  for (const name of path.slice(folder.length).split(sep)) {
    if (name.toLowerCase().startsWith('.mercury') && sameFolder(folder, systemAccountHome())) return true
    folder = join(folder, name)
  }
  return false
}

function systemAccountHome(): string {
  try {
    return accountHome()
  } catch {
    return homedir()
  }
}

function sameFolder(one: string, other: string): boolean {
  try {
    const a = statSync(one, { bigint: true })
    const b = statSync(other, { bigint: true })
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    try {
      if (lstatSync(resolved).isSymbolicLink()) return canonicalPath(resolve(dirname(resolved), readlinkSync(resolved)))
    } catch {}
    const parent = dirname(resolved)
    return parent === resolved ? resolved : join(canonicalPath(parent), basename(resolved))
  }
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
