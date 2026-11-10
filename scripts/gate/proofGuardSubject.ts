import { spawnSync } from 'node:child_process'
import fsDefault, { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, promises, readdirSync, readFileSync, realpathSync, renameSync, rm, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fsNamespace from 'node:fs'
import { rename as renamePromised, rm as rmPromised } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const [receipt, mode, world, token] = process.argv.slice(2) as [string, string, string, string]
const root = join(world, 'account', 'root')
const missing = join(world, 'account', 'missing')
const foreign = join(world, 'swap-foreign')
const spare = join(world, 'spare')
const whole = { recursive: true, force: true }
const inside = (path: string): boolean => {
  try {
    return realpathSync(path).startsWith(realpathSync(world) + sep)
  } catch {
    return false
  }
}
const madeByThisRun = (): boolean => {
  try {
    return readFileSync(join(world, 'made-here'), 'utf8') === token
  } catch {
    return false
  }
}
if (!madeByThisRun() || !inside(root) || !inside(foreign) || !inside(spare)) process.exit(64)

const born = lstatSync(root, { bigint: true }).ino
const stands = (): boolean => {
  const now = lstatSync(root, { bigint: true, throwIfNoEntry: false })
  return now !== undefined && now.isDirectory() && now.ino === born && lstatSync(missing, { throwIfNoEntry: false }) === undefined
}
type Tried = { shape: string; outcome: string; stands: boolean; error?: { code: unknown; syscall: unknown; path: unknown } }
const attempt = async (into: Tried[], shape: string, call: () => unknown, intact: () => boolean): Promise<void> => {
  let outcome = 'went through'
  let error: Tried['error']
  try {
    await call()
  } catch (thrown) {
    const failure = thrown as NodeJS.ErrnoException
    outcome = failure.code === 'EPROOFGUARD' ? 'refused' : `failed ${failure.code ?? String(thrown)}`
    error = { code: failure.code, syscall: failure.syscall, path: failure.path }
  }
  into.push({ shape, outcome, stands: intact(), error })
}
const guarded = (globalThis as Record<symbol, unknown>)[Symbol.for('mercury.proof.guard')] ?? null
const facts: Record<string, unknown> = { guarded }

if (mode === 'shapes') {
  const refused: Tried[] = []
  const kept = (): boolean => stands() && existsSync(join(root, 'kept')) && existsSync(join(root, 'session', 'file'))
  const required = createRequire(import.meta.url)
  const refuse = (shape: string, call: () => unknown): Promise<void> => attempt(refused, shape, call, kept)
  await refuse('rmSync, a named import', () => rmSync(root, whole))
  await refuse('rmSync, the root spelled with a trailing separator', () => rmSync(root + sep, whole))
  await refuse('rmSync, the default import', () => fsDefault.rmSync(root, whole))
  await refuse('rmSync, the namespace import', () => fsNamespace.rmSync(root, whole))
  await refuse('rmSync, require', () => required('node:fs').rmSync(root, whole))
  await refuse('rmSync, a dynamic import', async () => (await import('node:fs')).rmSync(root, whole))
  await refuse('rmSync, a Buffer path', () => rmSync(Buffer.from(root), whole))
  await refuse('rmSync, a file URL', () => rmSync(pathToFileURL(root), whole))
  await refuse('rm with a callback', () => new Promise<void>((done, failed) => rm(root, whole, error => (error ? failed(error) : done()))))
  await refuse('promises.rm', () => promises.rm(root, whole))
  await refuse('rm from node:fs/promises', () => rmPromised(root, whole))
  await refuse('rmdirSync', () => rmdirSync(root))
  await refuse('unlinkSync', () => unlinkSync(root))
  await refuse('renameSync, the root moved away', () => renameSync(root, join(world, 'moved')))
  await refuse('rename from node:fs/promises, the root moved away', () => renamePromised(root, join(world, 'moved')))
  await refuse('renameSync, a folder moved onto the root', () => renameSync(spare, root))
  await refuse('symlinkSync over the root', () => symlinkSync(foreign, root))
  await refuse('linkSync over the root', () => linkSync(join(foreign, 'file'), root))
  await refuse('rmSync, the folder that holds the root', () => rmSync(dirname(root), whole))
  await refuse('renameSync, the folder that holds the root', () => renameSync(dirname(root), join(world, 'moved')))
  await refuse('rmSync, the root through a linked folder', () => rmSync(join(world, 'alias', 'root'), whole))
  await refuse('rmSync, a link to the root spelled with a trailing separator', () => rmSync(join(world, 'to-root') + sep, whole))
  await refuse('rmSync, the root spelled through one of its own folders', () => rmSync(join(root, 'session', '..'), whole))
  if (existsSync(join(dirname(root), 'ROOT'))) await refuse('rmSync, the root in another letter case', () => rmSync(join(dirname(root), 'ROOT'), whole))
  await refuse('symlinkSync where a root would stand', () => symlinkSync(foreign, missing))
  await refuse('symlinkSync there, spelled with a trailing separator', () => symlinkSync(foreign, missing + sep))
  await refuse('linkSync there', () => linkSync(join(foreign, 'file'), missing))
  await refuse('renameSync, a folder moved there', () => renameSync(spare, missing))
  facts.refused = refused

  const allowed: Tried[] = []
  const allow = (shape: string, call: () => unknown): Promise<void> => attempt(allowed, shape, call, stands)
  await allow('a file inside the root removed', () => unlinkSync(join(root, 'session', 'file')))
  await allow('a folder inside the root removed whole', () => rmSync(join(root, 'session'), whole))
  await allow('a rename inside the root', () => renameSync(join(root, 'kept'), join(root, 'kept-moved')))
  await allow('a link made inside the root', () => symlinkSync(foreign, join(root, 'link')))
  await allow('every entry of the root removed, the root left standing empty', () => {
    for (const name of readdirSync(root)) rmSync(join(root, name), whole)
    if (readdirSync(root).length !== 0) throw new Error('entries left')
  })
  await allow('a folder beside the root removed', () => rmSync(join(dirname(root), 'sibling'), whole))
  await allow('a link to the root removed', () => unlinkSync(join(world, 'to-root')))
  await allow("the proof's own scratch folder removed", () => rmSync(mkdtempSync(join(tmpdir(), 'own-')), whole))
  facts.allowed = allowed
}

if (mode === 'incident') {
  const hostile = join(tmpdir(), 'hostile.mjs')
  writeFileSync(hostile, `import { realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, sep } from 'node:path'
const [root, foreign, world, careless] = process.argv.slice(2)
if (!realpathSync(dirname(root)).startsWith(realpathSync(world) + sep)) process.exit(64)
if (careless) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
} else {
  rmSync(root, { recursive: true, force: true })
}
symlinkSync(foreign, root)
`)
  const elsewhere = join(tmpdir(), 'elsewhere')
  mkdirSync(elsewhere)
  const node = Bun.which('node') ?? 'node'
  const runs: Array<{ name: string; status: number | null; refusals: string[]; stands: boolean }> = []
  const run = (name: string, runtime: string, target: string, careless = false): void => {
    const child = spawnSync(runtime, [hostile, target, foreign, world, ...(careless ? ['careless'] : [])], { cwd: elsewhere, encoding: 'utf8' })
    runs.push({ name, status: child.status, refusals: child.stderr.split('\n').filter(line => line.startsWith('proof guard:')), stands: stands() && existsSync(join(root, 'kept')) })
  }
  run('bun, the two calls as written, the root spelled as the product spells it', process.execPath, root + sep)
  run("bun, the first call's error swallowed", process.execPath, root + sep, true)
  run('bun, nothing standing where the root would be', process.execPath, missing + sep)
  run('node, the two calls as written', node, root + sep)
  facts.runs = runs
}

if (mode === 'roots') {
  const home = join(world, 'stand-in-home')
  const cache = join(world, 'stand-in-cache')
  const tempRoot = join(world, 'tmp', `mercury-${process.getuid!()}`)
  mkdirSync(join(home, '.mercury', 'sessions'), { recursive: true })
  mkdirSync(join(cache, 'mercury-nodejs', `mercury-${process.getuid!()}`), { recursive: true })
  if (!inside(home) || !inside(cache) || !inside(join(world, 'tmp'))) process.exit(64)
  const allowed: Tried[] = []
  const allow = (shape: string, call: () => unknown): Promise<void> => attempt(allowed, shape, call, stands)
  await allow("a stand-in home's config folder removed", () => rmSync(join(home, '.mercury'), whole))
  await allow("a stand-in cache home's folder removed", () => rmSync(join(cache, 'mercury-nodejs'), whole))
  await allow('the stand-in home moved away', () => renameSync(home, join(world, 'stand-in-home-moved')))
  await allow("a link made under the temp root's own name in another folder", () => symlinkSync(foreign, tempRoot))
  await allow('that link removed', () => unlinkSync(tempRoot))
  facts.allowed = allowed
  facts.environment = { home: process.env.HOME === home, cache: process.env.XDG_CACHE_HOME === cache }
}

writeFileSync(receipt, JSON.stringify(facts))
