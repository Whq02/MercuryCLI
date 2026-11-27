import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { homeOf } from '../../platform/profiles/profiles.js'

export function proofProcessName(): string | undefined {
  const marked = flagEnv('MERCURY_PROOF')?.trim()
  const script = runningScriptName()
  if (marked !== undefined && marked !== '' && marked !== '0') return marked === '1' ? script ?? 'MERCURY_PROOF=1' : marked
  return script !== undefined && /^prove-[\w.-]+\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(script) ? script : undefined
}

function runningScriptName(): string | undefined {
  const path = process.argv[1]
  return typeof path === 'string' && path !== '' ? basename(path) : undefined
}

export function accountStoreHome(): string {
  return resolve(join(homedir(), '.mercury'))
}

export function homeIsAccountStore(home: string): boolean {
  const store = accountStoreHome()
  const inside = relative(canonicalPath(store), canonicalPath(home))
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) return true
  const profile = (name: string): boolean => {
    const id = Number(name.slice(basename(store).length))
    return Number.isInteger(id) && id >= 2 && name === basename(homeOf(store, id))
  }
  const parent = canonicalPath(dirname(store))
  for (let at = resolve(home); dirname(at) !== at; at = dirname(at)) {
    if (profile(basename(at)) && canonicalPath(dirname(at)) === parent) return true
  }
  return profile(relative(parent, canonicalPath(home)).split(sep)[0] ?? '')
}

function canonicalPath(path: string, seen: Set<string> = new Set()): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch (error) {
    if (!isENOENT(error) && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    try {
      if (lstatSync(resolved).isSymbolicLink()) {
        if (seen.has(resolved)) throw Object.assign(new Error(`too many levels of symbolic links: ${resolved}`), { code: 'ELOOP' })
        seen.add(resolved)
        return canonicalPath(resolve(dirname(resolved), readlinkSync(resolved)), seen)
      }
    } catch (linkError) {
      if (!isENOENT(linkError) && (linkError as NodeJS.ErrnoException).code !== 'ENOTDIR') throw linkError
    }
    const parent = dirname(resolved)
    return parent === resolved ? resolved : join(canonicalPath(parent, seen), basename(resolved))
  }
}

export function refuseProofWriteIntoAccountStore(home: string, what: string): void {
  const proof = proofProcessName()
  if (proof === undefined || !homeIsAccountStore(home)) return
  throw Object.assign(
    new Error(
      `${proof} must not write ${what} into the account's own Mercury home (${home}): a proof writes only under a scratch home of its own — pin MERCURY_CONFIG_DIR to a fresh directory before importing the product.`,
    ),
    { code: 'EPROOFHOME' },
  )
}
