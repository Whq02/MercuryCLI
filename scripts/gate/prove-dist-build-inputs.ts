#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { distBuildInputs } from '../lib/distProvenance.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'dist-build-inputs-')))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
function write(rel: string, body: string): void {
  const full = join(SCRATCH, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}
function g(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd: SCRATCH, encoding: 'utf8', env }).trim()
}
function commitAll(message: string): void {
  g(['add', '-A'])
  g(['-c', 'user.email=keel@proof', '-c', 'user.name=keel', 'commit', '-q', '-m', message])
}
function contentTree(): string {
  const index = mkdtempSync(join(realpathSync(tmpdir()), 'dist-build-inputs-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(index, 'index') }
  try {
    g(['read-tree', 'HEAD'], env)
    g(['add', '-A'], env)
    return g(['write-tree'], env)
  } finally {
    rmSync(index, { recursive: true, force: true })
  }
}
function build(): string {
  const tree = contentTree()
  write('dist/mercury.mjs', 'export {}\n')
  write('dist/manifest.json', JSON.stringify({ buildTree: tree }))
  return tree
}
function restore(): void {
  g(['checkout', '-q', '--', '.'])
  g(['clean', '-qfd', '--', 'src', 'scripts', 'docs', 'design-system'])
}

try {
  g(['init', '-q', '-b', 'main'])
  write('.gitignore', 'dist/\n')
  write('src/a.ts', 'export const a = 1\n')
  write('build.ts', 'export {}\n')
  write('docs/GUIDE.md', 'guide\n')
  write('README.md', 'readme\n')
  write('scripts/ui/prove-screen.ts', 'export {}\n')
  write('scripts/ui/fixtures/screen/frame.txt', 'frame\n')
  write('scripts/vendor/pdfjs.ts', 'export {}\n')
  write('design-system/live/grids/frame.grid.json', '{}\n')
  commitAll('base')

  section('§1 a bundle built from the checkout as it stands is its own')
  const built = build()
  const own = distBuildInputs(SCRATCH)
  check('not stale, and the line names the tree', !own.stale && own.line.includes(built.slice(0, 12)) && own.line.includes("this checkout's build"), own.line)

  section('§2 a proof, a stored frame, a doc and a root note changed after the build move no build input')
  write('scripts/ui/prove-screen.ts', 'export const moved = 1\n')
  write('scripts/ui/fixtures/screen/frame.txt', 'frame re-recorded\n')
  write('design-system/live/grids/frame.grid.json', '{"moved":1}\n')
  write('docs/GUIDE.md', 'guide, corrected\n')
  write('README.md', 'readme, corrected\n')
  const outside = distBuildInputs(SCRATCH)
  check('not stale: the bundle still paints this tree', !outside.stale, outside.line)
  check('the line counts the five changed paths and says they are no inputs', outside.line.includes('the 5 changed paths') && outside.line.includes("none of the build's inputs"), outside.line)
  restore()

  section('§2b the tree\'s ignore rules changed after the build move no build input: the build reads none of them')
  write('.gitignore', 'dist/\nnode_modules\n')
  write('src/.gitignore', 'scratch/\n')
  const ignores = distBuildInputs(SCRATCH)
  check('not stale: neither ignore file is an input of the bundle', !ignores.stale && ignores.line.includes('the 2 changed paths') && ignores.line.includes("none of the build's inputs"), ignores.line)
  write('src/a.ts', 'export const a = 3\n')
  const withSource = distBuildInputs(SCRATCH)
  check('stale again when a source file moves beside them, and only the source is named', withSource.stale && withSource.line.includes('1 build input changed since: src/a.ts') && !withSource.line.includes('.gitignore'), withSource.line)
  g(['checkout', '-q', '--', '.'])
  rmSync(join(SCRATCH, 'src/.gitignore'), { force: true })

  section('§3 a source file edited after the build makes the bundle another build')
  write('src/a.ts', 'export const a = 2\n')
  const edited = distBuildInputs(SCRATCH)
  check('stale, and the line names the file', edited.stale && edited.line.includes('1 build input changed since: src/a.ts'), edited.line)
  restore()

  section('§4 a new source file nobody added yet counts too')
  write('src/b.ts', 'export const b = 1\n')
  const untracked = distBuildInputs(SCRATCH)
  check('stale on an untracked source file', untracked.stale && untracked.line.includes('src/b.ts'), untracked.line)
  restore()

  section('§5 the build script and the vendor steps it imports are inputs')
  write('build.ts', 'export const moved = 1\n')
  const builder = distBuildInputs(SCRATCH)
  check('stale on build.ts', builder.stale && builder.line.includes('build.ts'), builder.line)
  restore()
  write('scripts/vendor/pdfjs.ts', 'export const moved = 1\n')
  const vendor = distBuildInputs(SCRATCH)
  check('stale on scripts/vendor (build.ts imports it)', vendor.stale && vendor.line.includes('scripts/vendor/pdfjs.ts'), vendor.line)
  restore()

  section('§6 a commit after the build is judged like an edit')
  write('src/a.ts', 'export const a = 3\n')
  write('docs/GUIDE.md', 'guide, again\n')
  commitAll('a source change and a doc')
  const committed = distBuildInputs(SCRATCH)
  check('stale: one input among the two changed paths', committed.stale && committed.line.includes('1 build input changed since: src/a.ts') && !committed.line.includes('uncommitted'), committed.line)

  section('§7 a bundle whose tree this repository does not hold cannot be called fresh')
  write('dist/manifest.json', JSON.stringify({ buildTree: 'a'.repeat(40) }))
  const foreign = distBuildInputs(SCRATCH)
  check('stale, with the reason', foreign.stale && foreign.line.includes('cannot compare'), foreign.line)

  section('§8 what cannot be judged is said, not failed')
  write('dist/manifest.json', '{}')
  const unstamped = distBuildInputs(SCRATCH)
  check('no buildTree: not stale, named', !unstamped.stale && unstamped.line.includes('no buildTree'), unstamped.line)
  rmSync(join(SCRATCH, 'dist', 'manifest.json'))
  const bare = distBuildInputs(SCRATCH)
  check('no manifest: not stale, named', !bare.stale && bare.line.includes('missing or unreadable'), bare.line)
  rmSync(join(SCRATCH, 'dist'), { recursive: true })
  const absent = distBuildInputs(SCRATCH)
  check('no bundle: not stale, named', !absent.stale && absent.line.includes('not built'), absent.line)

  section('§9 the frame identity proof asks before any writer runs')
  const identity = readFileSync(join(REPO, 'scripts/engine-pass/prove-frames-identical.ts'), 'utf8')
  const asked = identity.indexOf('distBuildInputs(ROOT)')
  const refused = identity.indexOf('if (bundle.stale)')
  const firstWriter = identity.indexOf('spawnSync(process.execPath')
  check('the reading, its refusal and the first writer stand in that order', asked >= 0 && refused >= 0 && firstWriter >= 0 && asked < refused && refused < firstWriter, `${asked} ${refused} ${firstWriter}`)
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-dist-build-inputs — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
