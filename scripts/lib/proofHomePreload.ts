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

const SYSTEM_LIBRARIES = process.platform === 'darwin' ? ['libSystem.B.dylib'] : ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`]

function startAgainOnThisEnvironment(): void {
  if (process.platform === 'win32' || typeof bunMain !== 'string') return
  const owner = process.env[SINGLE_RUN_OWNER]
  if (owner === 'held' || owner === String(process.pid) || process.execArgv.some(flag => flag.startsWith('--inspect'))) return
  process.env[SINGLE_RUN_OWNER] = String(process.pid)
  const libraries = process.env.MERCURY_SUITE_LIBC ? [process.env.MERCURY_SUITE_LIBC] : SYSTEM_LIBRARIES
  let refusal = 'execve returned'
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
    let opened: { symbols: { execve: (path: unknown, argv: unknown, envp: unknown) => number } } | undefined
    for (const name of libraries) {
      try {
        opened = dlopen(name, { execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } })
        break
      } catch {
      }
    }
    if (opened === undefined) refusal = `${libraries.join(', ')} did not open`
    else opened.symbols.execve(ptr(program), ptr(words.pointers), ptr(variables.pointers))
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  process.stderr.write(`proof run: this process could not be started again on its scratch environment (${refusal}); a process it starts with no env option reads the caller's temp dir and config home — put MERCURY_TMPDIR and MERCURY_CONFIG_DIR in front of the run\n`)
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
