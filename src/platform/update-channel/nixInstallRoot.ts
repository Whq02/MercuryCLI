import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { passedOver } from '../errors/passedOver.js'

export function nixInstallRoot(invokedPath: string = process.argv[1] ?? '', isWindows = process.platform === 'win32'): string | null {
  if (isWindows || !invokedPath.endsWith('/libexec/mercury/mercury.mjs')) return null
  try {
    const real = realpathSync(invokedPath)
    if (!real.endsWith('/libexec/mercury/mercury.mjs')) return null
    const root = dirname(dirname(dirname(real)))
    return readFileSync(join(root, 'nix-support', 'mercury'), 'utf8') === 'libexec/mercury\n' ? root : null
  } catch (error) {
    passedOver(error)
    return null
  }
}
