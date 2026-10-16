#!/usr/bin/env bun
// gate-watch: src/services/structure/query* src/services/structure/polyglotQuery* src/services/structure/scanPaths* src/tools/StructureTool/* src/utils/globPattern*
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'files-filter-win32-home-'))
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_HOME

const query = await import('../../src/services/structure/query.ts')
const polyglot = await import('../../src/services/structure/polyglotQuery.ts')
const scanPaths = (await import('../../src/services/structure/scanPaths.ts').catch(() => null)) as null | { posixRelative: (root: string, full: string, platform?: NodeJS.Platform) => string; normalizeFileGlobs: (globs: readonly string[] | undefined, platform?: NodeJS.Platform) => string[] | undefined }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const WIN_ROOT = 'C:\\src\\m37-r7\\7b2-ts'
const winScanned = [
  ['C:\\src\\m37-r7\\7b2-ts\\src\\util.ts', 'src/util.ts'],
  ['C:\\src\\m37-r7\\7b2-ts\\src\\main.ts', 'src/main.ts'],
  ['C:\\src\\m37-r7\\7b2-ts\\index.ts', 'index.ts'],
] as const
const admitsTs = (query as { admitsScannedFile?: (rel: string, globs: readonly string[] | undefined) => boolean }).admitsScannedFile
const admitsPoly = (polyglot as { admitsPolyglotFile?: (rel: string, globs: readonly string[] | undefined) => boolean }).admitsPolyglotFile
const rel = (full: string): string | null => (scanPaths ? scanPaths.posixRelative(WIN_ROOT, full, 'win32') : null)
const globs = (g: string[]): string[] | undefined => (scanPaths ? scanPaths.normalizeFileGlobs(g, 'win32') : g)
const admitted = (admits: typeof admitsTs, g: string[]): string[] =>
  admits && scanPaths ? winScanned.filter(([full]) => admits(rel(full)!, globs(g))).map(([, posix]) => posix) : []

section('A. the seam: a win32 walk\'s root-relative path reads with forward slashes on any host, and a win32 glob spelling flips the same way (RED on the base: the seam does not exist)')
{
  check('A1 posixRelative flips the win32 separators', rel('C:\\src\\m37-r7\\7b2-ts\\src\\util.ts') === 'src/util.ts', String(rel('C:\\src\\m37-r7\\7b2-ts\\src\\util.ts')))
  check('A1 a root-level file has no separator to flip', rel('C:\\src\\m37-r7\\7b2-ts\\index.ts') === 'index.ts', String(rel('C:\\src\\m37-r7\\7b2-ts\\index.ts')))
  check('A1 a posix host is untouched', scanPaths !== null && scanPaths.posixRelative('/work/project', '/work/project/src/util.ts', 'linux') === 'src/util.ts' && scanPaths.posixRelative('/work/p', '/work/p/a\\b.ts', 'darwin') === 'a\\b.ts')
  check('A2 the globs: a ./ head drops on every platform, a backslash spelling flips on win32 only', JSON.stringify(globs(['./src/util.ts', 'src\\util.ts', '**\\*.ts'])) === JSON.stringify(['src/util.ts', 'src/util.ts', '**/*.ts']) && scanPaths !== null && JSON.stringify(scanPaths.normalizeFileGlobs(['a\\[1\\].ts'], 'linux')) === JSON.stringify(['a\\[1\\].ts']), JSON.stringify(globs(['./src/util.ts', 'src\\util.ts', '**\\*.ts'])))
}

section('B. the Structure files filter over the box\'s three scanned paths (F37W-7B-25): the plain file, the two globs the model retried, and the win32 spelling all admit src/util.ts (RED on the base: 0 of 3 for every filter)')
{
  check('B1 files: ["src/util.ts"] admits exactly src/util.ts', JSON.stringify(admitted(admitsTs, ['src/util.ts'])) === JSON.stringify(['src/util.ts']), JSON.stringify(admitted(admitsTs, ['src/util.ts'])))
  check('B2 files: ["**/util.ts"] admits src/util.ts', JSON.stringify(admitted(admitsTs, ['**/util.ts'])) === JSON.stringify(['src/util.ts']), JSON.stringify(admitted(admitsTs, ['**/util.ts'])))
  check('B3 files: ["**/*.ts"] admits the two files under src/', JSON.stringify(admitted(admitsTs, ['**/*.ts'])) === JSON.stringify(['src/util.ts', 'src/main.ts']), JSON.stringify(admitted(admitsTs, ['**/*.ts'])))
  check('B4 the model\'s backslash spelling files: ["src\\\\util.ts"] admits it on win32', JSON.stringify(admitted(admitsTs, ['src\\util.ts'])) === JSON.stringify(['src/util.ts']), JSON.stringify(admitted(admitsTs, ['src\\util.ts'])))
  check('B5 a filter naming another file admits nothing', admitted(admitsTs, ['src/other.ts']).length === 0, JSON.stringify(admitted(admitsTs, ['src/other.ts'])))
  check('B6 no filter admits everything', admitsTs !== undefined && winScanned.every(([full]) => admitsTs(rel(full)!, undefined)))
  check('B7 the base\'s comparison is what the box saw: a raw win32 path never matches a posix glob', admitsTs !== undefined && !admitsTs('src\\util.ts', ['src/util.ts']) && !admitsTs('src\\util.ts', ['**/util.ts']))
}

section('C. the polyglot walk (Structure patterns, AstSearch globs) reads the same seam')
{
  check('C1 files: ["src/util.ts"] admits it', JSON.stringify(admitted(admitsPoly, ['src/util.ts'])) === JSON.stringify(['src/util.ts']), JSON.stringify(admitted(admitsPoly, ['src/util.ts'])))
  check('C2 files: ["**/*.ts"] admits all three (the polyglot glob reaches the root level too)', JSON.stringify(admitted(admitsPoly, ['**/*.ts'])) === JSON.stringify(['src/util.ts', 'src/main.ts', 'index.ts']), JSON.stringify(admitted(admitsPoly, ['**/*.ts'])))
  check('C3 a folder filter files: ["src"] admits the folder\'s files', JSON.stringify(admitted(admitsPoly, ['src'])) === JSON.stringify(['src/util.ts', 'src/main.ts']), JSON.stringify(admitted(admitsPoly, ['src'])))
  check('C4 the win32 spelling files: ["src\\\\**\\\\*.ts"] admits the folder\'s files', JSON.stringify(admitted(admitsPoly, ['src\\**\\*.ts'])) === JSON.stringify(['src/util.ts', 'src/main.ts']), JSON.stringify(admitted(admitsPoly, ['src\\**\\*.ts'])))
}

section('D. the real walk on this host: a project of three files, the filtered query parses the one file and finds its two functions (the control that holds on every host)')
{
  const root = mkdtempSync(path.join(tmpdir(), 'files-filter-7b2-ts-'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', 'util.ts'), 'export function formatGreeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport function sumPair(a: number, b: number): number {\n  return a + b;\n}\n')
  writeFileSync(path.join(root, 'src', 'main.ts'), 'import { formatGreeting } from "./util";\nconsole.log(formatGreeting("x"));\n')
  writeFileSync(path.join(root, 'index.ts'), 'export const version = 1;\n')
  const { files, scanned } = query.discoverSourceFiles(root, ['src/util.ts'])
  check('D1 discoverSourceFiles admits the one file of three scanned, with forward slashes', scanned === 3 && JSON.stringify(files) === JSON.stringify(['src/util.ts']), JSON.stringify({ files, scanned }))
  const dotted = query.discoverSourceFiles(root, ['./src/util.ts'])
  check('D1 a ./ head reads the same', JSON.stringify(dotted.files) === JSON.stringify(['src/util.ts']), JSON.stringify(dotted.files))
  const result = query.runStructureQuery(root, { select: 'function', files: ['src/util.ts'] })
  const names = (r: typeof result): string => ('state' in r ? r.note : r.matches.map(m => m.context.split(' — ')[0]).join(','))
  check('D2 the filtered query parses 1 of 3 and finds both functions, each on src/util.ts', !('state' in result) && result.parsed === 1 && result.scanned === 3 && names(result) === 'formatGreeting,sumPair' && result.matches.every(m => m.file === 'src/util.ts'), JSON.stringify('state' in result ? result : { parsed: result.parsed, scanned: result.scanned, names: names(result), files: result.matches.map(m => m.file) }))
  const starred = query.runStructureQuery(root, { select: 'function', files: ['**/util.ts'] })
  check('D3 the glob form finds the same two', !('state' in starred) && starred.matches.length === 2, JSON.stringify('state' in starred ? starred : starred.matches.length))
  const poly = polyglot.discoverPolyglotFiles(root, ['src/**/*.ts'], null)
  check('D4 the polyglot walk admits the two files under src/', JSON.stringify(poly.files.map(f => f.rel)) === JSON.stringify(['src/main.ts', 'src/util.ts']), JSON.stringify(poly.files.map(f => f.rel)))
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'files-filter-win32: ALL LAWS HOLD' : `files-filter-win32: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
