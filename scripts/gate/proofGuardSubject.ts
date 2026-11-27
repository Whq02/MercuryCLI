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
const unheld = join(world, 'account', 'deep')
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
  return now !== undefined && now.isDirectory() && now.ino === born && lstatSync(missing, { throwIfNoEntry: false }) === undefined && lstatSync(unheld, { throwIfNoEntry: false }) === undefined
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
  const throughLink = `${join(world, 'to-root')}${sep}..${sep}missing`
  await refuse('rmSync, the root spelled through one of its own folders and .., as written', () => rmSync(`${root}${sep}session${sep}..`, whole))
  await refuse('symlinkSync where a root would stand, spelled through a link to the root and ..', () => symlinkSync(foreign, throughLink))
  await refuse('linkSync there, spelled the same way', () => linkSync(join(foreign, 'file'), throughLink))
  await refuse('renameSync, a folder moved there, spelled the same way', () => renameSync(spare, throughLink))
  const asBytes = (path: string): Uint8Array => new Uint8Array(Buffer.from(path))
  await refuse('rmSync, a Uint8Array that is no Buffer', () => rmSync(asBytes(root) as never, whole))
  await refuse('promises.rm, a Uint8Array', () => promises.rm(asBytes(root) as never, whole))
  await refuse('renameSync, the root as a Uint8Array, moved away', () => renameSync(asBytes(root) as never, join(world, 'moved')))
  await refuse('symlinkSync where a root would stand, the place a Uint8Array', () => symlinkSync(foreign, asBytes(missing) as never))
  await refuse('rmSync, a DataView', () => rmSync(new DataView(asBytes(root).buffer) as never, whole))
  await refuse('rmSync, an ArrayBuffer', () => rmSync(asBytes(root).buffer as never, whole))
  await refuse('rmSync, a String object', () => rmSync(new String(root) as never, whole))
  await refuse('rmSync, a value that is no path', () => rmSync({ at: root } as never, whole))
  await refuse('rmSync, a name longer than the system reads, which no check can look at', () => rmSync(join(root, 'x'.repeat(300)), whole))
  await refuse('renameSync, a folder moved onto a link to the place a root would stand, spelled with a trailing separator', () => renameSync(spare, join(world, 'to-missing') + sep))
  await refuse('renameSync there through a second link to that link', () => renameSync(spare, join(world, 'to-to-missing') + sep))
  await refuse('renameSync there, the separator written twice', () => renameSync(spare, join(world, 'to-missing') + sep + sep))
  facts.folds = existsSync(join(dirname(root), '\u017fibling'))
  if (facts.folds) {
    await refuse('symlinkSync where a root would stand, under a name the volume folds to its name: the long s', () => symlinkSync(foreign, join(dirname(missing), 'mi\u017f\u017fing')))
    await refuse('symlinkSync there, the long s among capitals', () => symlinkSync(foreign, join(dirname(missing), 'MI\u017fSING')))
  }
  await refuse('symlinkSync where a folder that would hold a root would stand', () => symlinkSync(foreign, unheld))
  await refuse('renameSync, a folder moved where that folder would stand', () => renameSync(spare, unheld))
  await refuse('symlinkSync there, reached through a linked folder', () => symlinkSync(foreign, join(world, 'alias', 'deep')))
  const second = join(world, 'to-to-root')
  await refuse('symlinkSync where a root would stand, spelled through a second link to the link and ..', () => symlinkSync(foreign, `${second}${sep}..${sep}missing`))
  await refuse('linkSync there through the second link', () => linkSync(join(foreign, 'file'), `${second}${sep}..${sep}missing`))
  await refuse('renameSync, a folder moved there through the second link', () => renameSync(spare, `${second}${sep}..${sep}missing`))
  await refuse('symlinkSync there, a . written before the ..', () => symlinkSync(foreign, `${join(world, 'to-root')}${sep}.${sep}..${sep}missing`))
  await refuse('symlinkSync there, the separator written twice after the ..', () => symlinkSync(foreign, `${join(world, 'to-root')}${sep}..${sep}${sep}missing`))
  await refuse('rmSync, the root spelled with a trailing /.', () => rmSync(`${root}${sep}.`, whole))
  await refuse('rmSync, a link to the root spelled with a trailing /.', () => rmSync(`${join(world, 'to-root')}${sep}.`, whole))
  await refuse('rmSync, the second link spelled with a trailing separator', () => rmSync(second + sep, whole))
  await refuse('rmSync, the second link spelled with a trailing /.', () => rmSync(`${second}${sep}.`, whole))
  await refuse('rmdirSync, the root spelled with a trailing /.', () => rmdirSync(`${root}${sep}.`))
  await refuse('renameSync, the root spelled with a trailing /., moved away', () => renameSync(`${root}${sep}.`, join(world, 'moved')))
  await refuse('renameSync, the second link spelled with a trailing separator, moved away', () => renameSync(second + sep, join(world, 'moved')))
  facts.refused = refused

  const shaped = join(tmpdir(), 'shaped.cjs')
  writeFileSync(shaped, `const { existsSync, realpathSync, rmSync } = require('node:fs')
const { dirname, join, sep } = require('node:path')
const [root, world] = process.argv.slice(2)
if (!realpathSync(dirname(root)).startsWith(realpathSync(world) + sep)) process.exit(64)
const tried = []
for (const [shape, value] of [['a Uint8Array that is no Buffer', new Uint8Array(Buffer.from(root))], ['a plain object shaped like a file URL', { href: 'file://' + root, protocol: 'file:', hostname: '', pathname: root, search: '', hash: '' }]]) {
  let outcome = 'went through'
  try { rmSync(value, { recursive: true, force: true }) } catch (error) { outcome = error.code === 'EPROOFGUARD' ? 'refused' : 'failed ' + error.code }
  tried.push({ shape, outcome, stands: existsSync(join(root, 'kept')) })
}
console.log(JSON.stringify(tried))
`)
  const underNode = spawnSync(Bun.which('node') ?? 'node', [shaped, root, world], { cwd: tmpdir(), encoding: 'utf8' })
  try {
    facts.underNode = JSON.parse(underNode.stdout)
  } catch {
    facts.underNode = [{ shape: 'the node child', outcome: `rc=${underNode.status} ${underNode.stderr.slice(-300)}`, stands: kept() }]
  }

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
  const { accountHome, rootAt } = createRequire(import.meta.url)('../lib/proofGuard.cjs') as { accountHome: () => string; rootAt?: (place: string, lands: boolean) => { how: string } | null }
  const account = accountHome()
  const absent = `.mercury-ppg-${token}`
  symlinkSync(join(account, absent), join(world, 'to-a-config-home'))
  const judged = (shape: string, place: string, lands: boolean): { shape: string; said: string | null } => ({ shape, said: rootAt ? rootAt(place, lands)?.how ?? null : 'the guard hands out no reader of its judge' })
  facts.judged = [
    judged('a name that begins .mercury and does not stand, where a call would land', join(account, absent), true),
    judged('the same name in capitals', join(account, absent.toUpperCase()), true),
    judged('spelled through a "." and a separator written twice', `${account}${sep}.${sep}${sep}${absent}`, true),
    judged('through a link in the proof\'s own folder to that name, spelled with a trailing separator', join(world, 'to-a-config-home') + sep, true),
    judged('.mercury2, where a call would land', join(account, '.mercury2'), true),
    judged('.mercury3, where a call would land', join(account, '.mercury3'), true),
  ]
  facts.unjudged = [
    judged('a path inside one', join(account, '.mercury3', 'sessions', 'x'), true),
    judged('the name without its dot', join(account, absent.slice(1)), true),
    judged('such a name under another folder', join(world, absent), true),
    judged('a call that only acts, where nothing stands', join(account, absent), false),
  ]
  facts.standing = ((guarded as string[] | null) ?? []).slice(4, -3).map(place => judged(place, place, false))
  const second = join(account, '.mercury2')
  if (lstatSync(second, { throwIfNoEntry: false }) === undefined) facts.second = null
  else {
    symlinkSync(second, join(world, 'to-the-second-home'))
    facts.second = [
      judged('a call that acts on it', second, false),
      judged("through a link in the proof's own folder, spelled with a trailing separator", join(world, 'to-the-second-home') + sep, false),
      judged('spelled with a trailing "/."', `${second}${sep}.`, false),
    ]
  }
}

writeFileSync(receipt, JSON.stringify(facts))
