#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneWholeFolders, volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_WORKTREE_CLONE
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const cloneModule = (await import('../../src/utils/worktreeClone.ts')) as unknown as {
  cloneIntoWorktree: (pairs: ReadonlyArray<{ source: string; target: string }>, checkout: string, worktree: string) => Promise<string[]>
  planCloneCalls?: (source: string) => Promise<{ folders: string[]; clones: string[] }>
}
const BOUND = 4096
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-renames-')))
const removeBig = (dir: string): void => {
  try {
    execFileSync('sh', ['-c', 'chmod -R u+rwx "$1" 2> /dev/null; find "$1" -mindepth 2 -maxdepth 2 -print0 | xargs -0 -P 8 -n 64 rm -rf; rm -rf "$1"', 'sh', dir])
  } catch {
  }
}
const entriesOf = (root: string): Map<string, string> => {
  const rows = new Map<string, string>()
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = `${rel}/${entry.name}`
      if (entry.isSymbolicLink()) rows.set(at, `link ${readlinkSync(join(dir, entry.name))}`)
      else if (entry.isDirectory()) {
        rows.set(at, `folder ${(lstatSync(join(dir, entry.name)).mode & 0o7777).toString(8)}`)
        walk(join(dir, entry.name), at)
      } else rows.set(at, `file ${lstatSync(join(dir, entry.name)).size}`)
    }
  }
  walk(root, '')
  return rows
}
const fillPackages = (root: string, packages: number): void => {
  for (let pkg = 0; pkg < packages; pkg++) {
    const folders = ['', 'lib', 'lib/a', 'dist']
    for (const folder of folders) mkdirSync(join(root, `pkg-${pkg}`, folder), { recursive: true })
    for (let index = 0; index < 100; index++) writeFileSync(join(root, `pkg-${pkg}`, folders[index % folders.length] as string, `f${index}.js`), `module.exports = ${pkg * 100 + index}\n`)
  }
}
const renamesWhile = async <T>(work: () => Promise<T>): Promise<{ answer: T; worst: number; done: number; took: number }> => {
  const dir = join(scratch, 'elsewhere')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a'), 'x')
  let stop = false
  let worst = 0
  let done = 0
  let flip = false
  const loop = (async (): Promise<void> => {
    while (!stop) {
      const began = performance.now()
      await rename(join(dir, flip ? 'b' : 'a'), join(dir, flip ? 'a' : 'b'))
      worst = Math.max(worst, performance.now() - began)
      flip = !flip
      done++
      await wait(1)
    }
  })()
  await wait(60)
  worst = 0
  done = 0
  const began = performance.now()
  const answer = await work()
  const took = performance.now() - began
  stop = true
  await loop
  return { answer, worst, done, took }
}

try {
  const cloning = process.platform === 'darwin' && volumeClones(scratch)
  const seed = join(scratch, 'seed')
  const checkout = join(scratch, 'checkout')
  const source = join(checkout, 'node_modules')
  mkdirSync(source, { recursive: true })
  fillPackages(seed, 100)
  const groups = cloning ? 8 : 1
  if (cloning) {
    const made = await cloneWholeFolders(Array.from({ length: groups }, (_, index) => [seed, join(source, `g${index + 1}`)] as const))
    if (made === null) throw new Error('the fixture could not be cloned from its seed')
  } else renameSync(seed, join(source, 'g1'))
  for (let folder = 0; folder < 12; folder++) {
    mkdirSync(join(source, 'giant', `part-${folder}`), { recursive: true })
    for (let index = 0; index < 400; index++) writeFileSync(join(source, 'giant', `part-${folder}`, `m${index}.js`), 'x\n')
  }
  writeFileSync(join(source, 'giant', 'direct-1.js'), 'direct\n')
  writeFileSync(join(source, 'giant', 'direct-2.js'), 'direct\n')
  for (let folder = 0; folder < 10; folder++) {
    mkdirSync(join(source, 'full', `part-${folder}`), { recursive: true })
    for (let index = 0; index < 399; index++) writeFileSync(join(source, 'full', `part-${folder}`, `m${index}.js`), 'x\n')
  }
  writeFileSync(join(source, 'top.txt'), 'top\n')
  symlinkSync('g1/pkg-0/lib', join(source, 'toplink'))
  mkdirSync(join(source, '.bin'))
  symlinkSync('../g1/pkg-0/lib/f1.js', join(source, '.bin', 'tool'))
  chmodSync(join(source, 'giant'), 0o750)
  if (process.platform === 'darwin') for (const dir of [source, join(source, 'giant'), join(source, 'full')]) execFileSync('xattr', ['-w', 'com.example.proof', dir === source ? 'root' : 'kept', dir])
  const flat = join(scratch, 'flat-tree')
  mkdirSync(join(flat, 'flat'), { recursive: true })
  for (let index = 0; index < 4500; index++) writeFileSync(join(flat, 'flat', `f${index}`), 'y\n')
  mkdirSync(join(flat, 'small', 'lib'), { recursive: true })
  writeFileSync(join(flat, 'small', 'lib', 'one.js'), '1\n')
  const sourceEntries = entriesOf(source)
  const sizeUnder = (rel: string): number => {
    let count = rel === '' || sourceEntries.has(rel) ? 1 : 0
    for (const at of sourceEntries.keys()) if (at.startsWith(rel + '/')) count++
    return count
  }
  console.log(`  the folder: ${sourceEntries.size + 1} entries (${groups} groups of 100 packages of 100 files, a folder of 4,815 entries in twelve parts, one of 4,001 in ten, a file, two links)`)

  section('§1 the plan: a call for each subtree of at most 4,096 entries, the folders above them made one by one')
  const plan = cloneModule.planCloneCalls
  const calls = plan === undefined ? null : await plan(source)
  check('the clone road plans its calls', calls !== null, 'worktreeClone.ts exports no planCloneCalls: the folder is cloned in one call')
  if (calls !== null) {
    const clones = new Set(calls.clones)
    const cut = new Set(calls.folders)
    const largest = Math.max(...calls.clones.map(sizeUnder))
    check(`no call clones more than 4,096 entries (the largest of ${calls.clones.length}: ${largest})`, largest <= BOUND, String(largest))
    check('the folders cut into their entries are the folder itself, each group and the folder of 4,815 entries', JSON.stringify([...cut].sort()) === JSON.stringify(['', '/giant', ...Array.from({ length: groups }, (_, index) => `/g${index + 1}`)].sort()), JSON.stringify([...cut].sort()))
    check('…each named after the folder above it', calls.folders.every((rel, at) => rel === '' || calls.folders.indexOf(dirname(rel) === '/' ? '' : dirname(rel)) < at && calls.folders.includes(dirname(rel) === '/' ? '' : dirname(rel))))
    let uncovered = 0
    let twice = 0
    for (const at of sourceEntries.keys()) {
      let covering = 0
      for (let up = at; up !== ''; up = up.slice(0, up.lastIndexOf('/'))) if (clones.has(up)) covering++
      if (cut.has(at) ? covering !== 0 : covering !== 1) covering === 0 ? uncovered++ : twice++
    }
    check('every entry of the folder is in exactly one call, or is a folder that was cut', uncovered === 0 && twice === 0, `${uncovered} in no call, ${twice} in more than one`)
    check('a folder of 4,001 entries is one call', clones.has('/full') && sizeUnder('/full') === 4001, String(sizeUnder('/full')))
    check('a file and a link that lie directly in a cut folder are calls of their own', clones.has('/top.txt') && clones.has('/toplink') && clones.has('/giant/direct-1.js') && clones.has('/giant/direct-2.js'))
    const flatCalls = await (plan as NonNullable<typeof plan>)(join(flat, 'flat'))
    check('a folder whose 4,500 files all lie directly in it stays one call: cutting it would make 4,500', JSON.stringify(flatCalls) === JSON.stringify({ folders: [], clones: [''] }), JSON.stringify(flatCalls).slice(0, 200))
    const smallCalls = await (plan as NonNullable<typeof plan>)(join(flat, 'small'))
    check('a small folder is one call, as before', JSON.stringify(smallCalls) === JSON.stringify({ folders: [], clones: [''] }), JSON.stringify(smallCalls))
  }

  if (!cloning) {
    section('§2 to §4 need the one-call road of APFS')
    skip('this volume or platform does not clone a folder by clonefile: there is no call to hold a rename')
  } else {
    section('§2 a rename elsewhere on the volume while the folder is cloned')
    const control = await renamesWhile(() => cloneWholeFolders([[source, join(scratch, 'control')]]))
    const oneCall = control.answer === null ? 0 : (control.answer[0] as number)
    removeBig(join(scratch, 'control'))
    const worktree = join(checkout, '.mercury', 'worktrees', 'agent-ab000001')
    mkdirSync(worktree, { recursive: true })
    const product = await renamesWhile(() => cloneModule.cloneIntoWorktree([{ source, target: join(worktree, 'node_modules') }], checkout, worktree))
    const bound = Math.max(250, oneCall / 4)
    console.log(`  ONE clonefile call for the folder: ${oneCall} ms, and the longest a rename elsewhere waited meanwhile: ${control.worst.toFixed(0)} ms (${control.done} renames came back)`)
    console.log(`  the product's clone of the same folder: ${product.took.toFixed(0)} ms in all, and the longest a rename elsewhere waited meanwhile: ${product.worst.toFixed(0)} ms (${product.done} renames came back)`)
    check('the folder is cloned', product.answer[0] === 'cloned', JSON.stringify(product.answer))
    check(`no rename elsewhere on the volume waited a quarter of a second (a quarter of the one call, were the machine so loaded that the call takes over a second): ${product.worst.toFixed(0)} ms against a bound of ${bound.toFixed(0)} ms`, control.answer !== null && product.worst < bound, `${product.worst.toFixed(0)} ms; one call holds it ${control.worst.toFixed(0)} ms`)

    section('§3 the copy is the folder, entry for entry, the cut folders with what they carried')
    const copy = entriesOf(join(worktree, 'node_modules'))
    const differing = [...sourceEntries].filter(([at, row]) => copy.get(at) !== row).map(([at, row]) => `${at}: ${row} against ${copy.get(at) ?? 'nothing'}`)
    check('every entry is there with its kind, its size or target, and each folder its mode', copy.size === sourceEntries.size && differing.length === 0, `${copy.size} against ${sourceEntries.size}; ${differing.slice(0, 3).join('; ')}`)
    check('a cut folder keeps its mode', (lstatSync(join(worktree, 'node_modules', 'giant')).mode & 0o7777) === 0o750, (lstatSync(join(worktree, 'node_modules', 'giant')).mode & 0o7777).toString(8))
    const noteOf = (path: string): string => {
      try {
        return execFileSync('xattr', ['-p', 'com.example.proof', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {
        return '<none>'
      }
    }
    check('a cut folder keeps its extended attribute, as a folder cloned whole does', noteOf(join(worktree, 'node_modules', 'giant')) === 'kept' && noteOf(join(worktree, 'node_modules', 'full')) === 'kept', `${noteOf(join(worktree, 'node_modules', 'giant'))} and ${noteOf(join(worktree, 'node_modules', 'full'))}`)
    check('a file in the copy is its own: a write there does not reach the checkout', (() => {
      writeFileSync(join(worktree, 'node_modules', 'g1', 'pkg-0', 'lib', 'f1.js'), 'changed in the copy\n')
      return readFileSync(join(source, 'g1', 'pkg-0', 'lib', 'f1.js'), 'utf8') === 'module.exports = 1\n'
    })())
    check('nothing is left beside the copy', readdirSync(dirname(worktree)).every(name => !name.startsWith('.cloning-')))

    section('§4 two copies asked for at once take their turns: one helper at a time')
    const small = join(source, 'g1')
    const first = join(checkout, '.mercury', 'worktrees', 'agent-ab000002')
    const second = join(checkout, '.mercury', 'worktrees', 'agent-ab000003')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const helpers = (): number => {
      try {
        return execFileSync('pgrep', ['-P', String(process.pid), 'osascript'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }
    let most = 0
    let pending = 2
    const ask = (worktreeRoot: string): Promise<string[]> =>
      cloneModule.cloneIntoWorktree([{ source: small, target: join(worktreeRoot, 'node_modules') }], checkout, worktreeRoot).finally(() => {
        pending--
      })
    const both = Promise.all([ask(first), ask(second)])
    while (pending > 0) {
      most = Math.max(most, helpers())
      await wait(5)
    }
    const outcomes = await both
    const smallEntries = [...sourceEntries.keys()].filter(at => at.startsWith('/g1/')).length
    check('both folders are cloned whole', outcomes[0]?.[0] === 'cloned' && outcomes[1]?.[0] === 'cloned' && entriesOf(join(first, 'node_modules')).size === smallEntries && entriesOf(join(second, 'node_modules')).size === smallEntries, JSON.stringify(outcomes))
    check('never more than one helper at a time', most === 1, `${most} at once`)
  }
} finally {
  removeBig(scratch)
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
