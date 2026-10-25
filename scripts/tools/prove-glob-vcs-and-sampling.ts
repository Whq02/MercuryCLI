import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const rg = await import('../../src/utils/ripgrep.ts')
const ripGrepAnswer = rg.ripGrepAnswer
const calls: string[][] = []
mock.module('../../src/utils/ripgrep.ts', () => ({ ...rg, ripGrepAnswer: (...args: Parameters<typeof ripGrepAnswer>) => { calls.push([...args[0]]); return ripGrepAnswer(...args) } }))
const { glob } = await import('../../src/utils/glob.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'glob-spread-')))
let failures = 0
const check = (label: string, ok: boolean): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++ }
const stamp = (path: string, age: number): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, path)
  utimesSync(file, 1_800_000_000 - age, 1_800_000_000 - age)
}
const search = (limit: number, offset = 0, pattern = '**/*.ts') => glob(pattern, root, { limit, offset }, new AbortController().signal, getEmptyToolPermissionContext())
try {
  for (let i = 0; i < 120; i++) stamp(`src/${i}.ts`, i)
  stamp('docs/guide.ts', 200)
  stamp('tests/case.ts', 300)
  const vcs = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
  for (const dir of vcs) stamp(`${dir}/objects/object.ts`, 0)
  const result = await search(100)
  check('over-cap page reaches src, docs and tests', ['src', 'docs', 'tests'].every(dir => result.files.some(file => relative(root, file).startsWith(`${dir}/`))))
  check('the existing cap and truncation remain', result.files.length === 100 && result.truncated)
  check('metadata never appears in the answer', result.files.every(file => !vcs.some(dir => relative(root, file).startsWith(`${dir}/`))))
  for (const dir of vcs) check(`both ripgrep walks prune ${dir} before descending`, calls.length === 2 && calls.every(args => args.some((arg, i) => arg === '--glob' && args[i + 1] === `!**/${dir}`) && args.some((arg, i) => arg === '--glob' && args[i + 1] === `!**/${dir}/**`)))
  const second = await search(100, 100)
  check('pages do not overlap and cover all non-metadata matches', second.files.every(file => !result.files.includes(file)) && new Set([...result.files, ...second.files]).size === 122 && !second.truncated)
  const small = await search(200)
  check('uncapped results stay in modification order', relative(root, small.files[0]!) === 'src/0.ts' && relative(root, small.files.at(-1)!) === 'tests/case.ts')
  const flat = await search(100, 0, 'src/*.ts')
  check('a single top-level directory retains newest-first selection', flat.files.length === 100 && relative(root, flat.files[0]!) === 'src/0.ts' && relative(root, flat.files.at(-1)!) === 'src/99.ts')
} finally {
  mock.restore()
  rmSync(root, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
