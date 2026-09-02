#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { resolveRelativePatternPrefix } = await import('../../src/utils/globPrefix.ts')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'glob-link-')))
mkdirSync(join(root, 'junc-target'))
writeFileSync(join(root, 'junc-target', 'inside.txt'), 'x')
mkdirSync(join(root, 'junc-target', 'deep'))
symlinkSync(join(root, 'junc-target'), join(root, 'junc-link'))
mkdirSync(join(root, 'plain'))
writeFileSync(join(root, 'plain', 'p.txt'), 'x')

{
  const out = resolveRelativePatternPrefix(root, 'junc-link/*.txt')
  check(
    'a link prefix moves INTO the search directory (realpath) with the pattern trimmed',
    out.searchDir === join(root, 'junc-target') && out.pattern === '*.txt',
    JSON.stringify(out),
  )
}
{
  const out = resolveRelativePatternPrefix(root, 'plain/*.txt')
  check('a plain directory prefix is IDENTITY (nothing changes)', out.searchDir === root && out.pattern === 'plain/*.txt')
}
{
  const out = resolveRelativePatternPrefix(root, '*.txt')
  check('a bare pattern is identity', out.searchDir === root && out.pattern === '*.txt')
}
{
  const out = resolveRelativePatternPrefix(root, 'absent-dir/*.txt')
  check('an absent prefix is identity (the walk answers as before)', out.searchDir === root && out.pattern === 'absent-dir/*.txt')
}
{
  const out = resolveRelativePatternPrefix(root, 'junc-link/deep/**/*.md')
  check(
    'a deeper static prefix resolves THROUGH the link; the glob tail rides whole',
    out.searchDir === join(root, 'junc-target', 'deep') && out.pattern === '**/*.md',
    JSON.stringify(out),
  )
}
{
  const globSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'glob.ts'), 'utf8')
  check('utils/glob.ts rides the leaf (call-shaped)', globSrc.includes('resolveRelativePatternPrefix(searchDir, pattern)'))
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-glob-link-prefix: all green' : `\nprove-glob-link-prefix: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
