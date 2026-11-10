import { join, resolve, sep } from 'node:path'
import { configHomeIsReal } from './loginDriverGuard.ts'
import { resolveProofHome } from './proofHome.ts'
import { installProofScratch, singleRunRootMadeHere, SINGLE_RUN_OWNER } from './proofScratch.cjs'

const root = resolve(import.meta.dir, '..', '..')
const scripts = join(root, 'scripts')
const vendor = join(scripts, 'vendor')
const bunMain = (globalThis as { Bun?: { main?: unknown } }).Bun?.main
const entry = typeof bunMain === 'string' ? bunMain : process.argv[1] ?? ''

function entryTakesProofHome(path: string): boolean {
  if (path !== scripts && !path.startsWith(scripts + sep)) return false
  return path !== vendor && !path.startsWith(vendor + sep)
}

function startAgainOnThisEnvironment(): void {
  if (process.platform === 'win32' || typeof bunMain !== 'string') return
  const owner = process.env[SINGLE_RUN_OWNER]
  if (owner === 'held' || owner === String(process.pid) || process.execArgv.some(flag => flag.startsWith('--inspect'))) return
  process.env[SINGLE_RUN_OWNER] = String(process.pid)
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const terminated = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf8')
    const table = (items: string[]): { held: Buffer[]; pointers: BigUint64Array } => {
      const held = items.map(terminated)
      const pointers = new BigUint64Array(items.length + 1)
      held.forEach((item, at) => { pointers[at] = BigInt(ptr(item)) })
      return { held, pointers }
    }
    const program = terminated(process.execPath)
    const words = table([process.execPath, ...process.execArgv, bunMain, ...process.argv.slice(2)])
    const variables = table(Object.entries(process.env).flatMap(([name, value]) => value === undefined ? [] : [`${name}=${value}`]))
    const libc = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', { execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } })
    libc.symbols.execve(ptr(program), ptr(words.pointers), ptr(variables.pointers))
  } catch {
  }
}

if (entryTakesProofHome(entry)) {
  installProofScratch()
  process.env.MERCURY_LOCAL_PROBE_TARGETS ??= 'none'
  delete process.env.NO_COLOR
  delete process.env.FORCE_COLOR
}

if (entryTakesProofHome(entry) && configHomeIsReal()) {
  delete process.env.MERCURY_CONFIG_DIR
  resolveProofHome([root])
}

if (entryTakesProofHome(entry) && singleRunRootMadeHere() !== '') startAgainOnThisEnvironment()

if (import.meta.main) console.log(`${process.env.MERCURY_CONFIG_DIR ?? ''}\n${process.env.MERCURY_LOCAL_PROBE_TARGETS ?? ''}\n${process.env.NO_COLOR ?? ''}${process.env.FORCE_COLOR ?? ''}`)
