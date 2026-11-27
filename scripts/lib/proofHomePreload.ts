import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { configHomeIsReal } from './loginDriverGuard.ts'
import { carryProofGuard, openSystemLibrary, proofEntry } from './proofGuard.cjs'
import { resolveProofHome } from './proofHome.ts'
import { installProofScratch, singleRunRootMadeHere, SINGLE_RUN_OWNER } from './proofScratch.cjs'

const root = resolve(import.meta.dir, '..', '..')
const bunMain = (globalThis as { Bun?: { main?: unknown } }).Bun?.main
const entryTakesProofHome = proofEntry()
const CALLER_REPOSITORY = ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_INTERNAL_SUPER_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR']

function startAgainOnThisEnvironment(): void {
  if (process.platform === 'win32' || typeof bunMain !== 'string') return
  const owner = process.env[SINGLE_RUN_OWNER]
  if (owner === 'held' || owner === String(process.pid) || process.execArgv.some(flag => flag.startsWith('--inspect'))) return
  process.env[SINGLE_RUN_OWNER] = String(process.pid)
  let refusal = 'execve returned'
  try {
    const { FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
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
    const libc = openSystemLibrary({ execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } }) as { symbols: { execve: (path: unknown, argv: unknown, envp: unknown) => number } }
    libc.symbols.execve(ptr(program), ptr(words.pointers), ptr(variables.pointers))
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  process.stderr.write(`proof run: this process could not be started again on its scratch environment (${refusal}); a process it starts with no env option reads the caller's temp dir and config home — put MERCURY_TMPDIR and MERCURY_CONFIG_DIR in front of the run\n`)
}

if (entryTakesProofHome) {
  for (const name of CALLER_REPOSITORY) delete process.env[name]
  installProofScratch({ ownHome: configHomeIsReal() })
  process.env.MERCURY_LOCAL_PROBE_TARGETS ??= 'none'
  process.env.MERCURY_CREDENTIAL_STORE ||= 'file'
  process.env.BROWSER ||= '/usr/bin/true'
  delete process.env.NO_COLOR
  delete process.env.FORCE_COLOR
}

if (entryTakesProofHome && configHomeIsReal()) {
  delete process.env.MERCURY_CONFIG_DIR
  resolveProofHome([root])
}

if (entryTakesProofHome && singleRunRootMadeHere() !== '') {
  carryProofGuard(process.env)
  startAgainOnThisEnvironment()
}

const isBuildEntry = typeof bunMain === 'string' && bunMain.endsWith('/build.ts')
const isProductEntry = typeof bunMain === 'string' && (bunMain.includes('/src/entrypoints/') || bunMain.includes('/dist/'))
if (!import.meta.main && !isBuildEntry && !isProductEntry) {
  const preloadFlag = `"--preload=${resolve(import.meta.dir, 'proofHomePreload.ts').replaceAll('\\', '/')}"`
  if (!(process.env.BUN_OPTIONS || '').includes(preloadFlag)) {
    process.env.BUN_OPTIONS = process.env.BUN_OPTIONS ? `${process.env.BUN_OPTIONS} ${preloadFlag}` : preloadFlag
  }
  const bootDoors = resolve(root, 'src', 'boot', 'doors', 'registerDoors.ts')
  if (existsSync(bootDoors)) {
    const { registerBootDoors } = await import('../../src/boot/doors/registerDoors.ts')
    registerBootDoors()
  }
}

if (import.meta.main) console.log(`${process.env.MERCURY_CONFIG_DIR ?? ''}\n${process.env.MERCURY_LOCAL_PROBE_TARGETS ?? ''}\n${process.env.NO_COLOR ?? ''}${process.env.FORCE_COLOR ?? ''}\n${Object.keys(process.env).filter(name => name.startsWith('GIT_')).sort().join(' ')}\n${process.env.MERCURY_CREDENTIAL_STORE ?? ''}\n${process.env.BROWSER ?? ''}`)
