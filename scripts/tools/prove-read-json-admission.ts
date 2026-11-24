import { mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const given = process.env.READ_ADMISSION_PROOF_HOME
if (!given) {
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  const home = realpathSync(mkdtempSync(join(base, 'json-admit-')))
  try {
    const run = spawnSync(process.execPath, [script], { stdio: 'inherit', timeout: 10000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, USERPROFILE: home, READ_ADMISSION_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    process.exitCode = run.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  if (homedir() !== given) throw new Error('The runtime did not take the proof home')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  const source = join(given, 'unknown')
  writeFileSync(source, `${' '.repeat(131072)}{"n":1}`)
  const controller = new AbortController()
  let armed = false, queued = false, started = false
  const cancel = () => { if (armed && !queued) { queued = true; queueMicrotask(() => controller.abort(new Error('admission cancelled'))) } }
  const fs = await import('node:fs')
  const nativeRead = fs.read, nativeReadSync = fs.readSync
  mock.module('node:fs', () => ({ ...fs, readSync: (...args: any[]) => { const value = (nativeReadSync as any)(...args); cancel(); return value }, read: (...args: any[]) => { const callback = args.pop(); return (nativeRead as any)(...args, (...reply: any[]) => { cancel(); callback(...reply) }) } }))
  const processes = await import('node:child_process')
  mock.module('node:child_process', () => ({ ...processes, fork: () => { started = true; throw new Error('engine started before admission yielded') } }))
  const src = process.env.PROVE_SRC ?? resolve(dirname(script), '../../src')
  const { ReadTool } = await import(`${src}/tools/read/ReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/tools/kit/tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/platform/files/fileStateCache.ts`)
  const { setCwdState, setOriginalCwd } = await import(`${src}/boot/process-state/processState.ts`)
  setCwdState(given); setOriginalCwd(given)
  const context = { messages: [], readFileState: createFileStateCacheWithSizeLimit(100), abortController: controller, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
  let result = ''
  armed = true
  try { await ReadTool.call({ file_path: `${source}#read?q=.n` }, context) } catch (error) { result = String(error) }
  let failed = 0
  const check = (name: string, ok: boolean, hint = '') => { if (!ok) failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${result}${hint ? ` | ${hint}` : ''}`}`) }
  check('the fixture schedules cancellation during source admission', queued, 'the mocked node:fs read never ran during admission; check that admitted() in src/tools/read/readJson.ts still reads the unknown file through fs.read or fs.readSync before any engine starts')
  check('extensionless admission yields to cancellation before starting an engine', !started && result.includes('admission cancelled'), 'admitted() in src/tools/read/readJson.ts must call signal.throwIfAborted() after each read so a cancelled admission throws before runJsonQuery in jsonQueryRuntime.ts forks the engine')
  check('cancelled admission grants no source coverage', !context.readFileState.has(source), 'readJson in src/tools/read/readJson.ts must not record the source in readFileState when admission is cancelled')
  console.log(`${3 - failed}/3 checks`)
  process.exitCode = failed ? 1 : 0
}
