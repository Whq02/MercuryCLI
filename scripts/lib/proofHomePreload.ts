import { join, resolve, sep } from 'node:path'
import { configHomeIsReal } from './loginDriverGuard.ts'
import { resolveProofHome } from './proofHome.ts'

const root = resolve(import.meta.dir, '..', '..')
const scripts = join(root, 'scripts')
const vendor = join(scripts, 'vendor')
const bunMain = (globalThis as { Bun?: { main?: unknown } }).Bun?.main
const entry = typeof bunMain === 'string' ? bunMain : process.argv[1] ?? ''

export function entryTakesProofHome(path: string): boolean {
  if (path !== scripts && !path.startsWith(scripts + sep)) return false
  return path !== vendor && !path.startsWith(vendor + sep)
}

if (entryTakesProofHome(entry) && configHomeIsReal()) {
  delete process.env.MERCURY_CONFIG_DIR
  resolveProofHome([root])
}

if (import.meta.main) console.log(process.env.MERCURY_CONFIG_DIR ?? '')
