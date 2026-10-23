import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'

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
  const inside = relative(canonicalPath(accountStoreHome()), canonicalPath(home))
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
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
