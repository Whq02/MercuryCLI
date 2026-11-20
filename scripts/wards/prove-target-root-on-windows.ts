#!/usr/bin/env bun
import { realTargetPath } from '../../src/guards/wardsGuard.js'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  [PASS] ${label}`)
  } else {
    failed++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, lstat '${path}'`) as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

function makeFakeFs(table: Record<string, string>): {
  probed: string[]
  realpath: (candidate: string) => string
} {
  const probed: string[] = []
  const realpath = (candidate: string): string => {
    probed.push(candidate)
    if (Object.prototype.hasOwnProperty.call(table, candidate)) return table[candidate]!
    throw enoent(candidate)
  }
  return { probed, realpath }
}

console.log('============================================================')
console.log(' wardsGuard realTargetPath — Windows drive & UNC roots')
console.log('============================================================')

withPlatform('win32', () => {
  const winTable: Record<string, string> = {
    'C:\\': 'C:\\',
    'C:\\src': 'C:\\src',
    'C:\\src\\proj': 'D:\\work\\mercury',
    'C:\\src\\proj\\src': 'D:\\work\\mercury\\src',
    'C:\\src\\proj\\src\\components': 'D:\\work\\mercury\\src\\components',
    'c:\\': 'C:\\',
    '\\\\server\\share\\': '\\\\server\\share\\',
    '\\\\server\\share\\dir': '\\\\server\\share\\real-dir',
  }

  const fs1 = makeFakeFs(winTable)
  const resolved1 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    'C:\\src\\proj\\src\\components\\Foo.tsx',
    fs1.realpath,
  )
  check(
    'win32 drive path resolves deepest existing junction without doubling drive',
    resolved1 === 'D:\\work\\mercury\\src\\components\\Foo.tsx',
    `got ${JSON.stringify(resolved1)}, probed=${JSON.stringify(fs1.probed)}`,
  )
  check(
    'win32 probes never prepend leading backslash before drive letter',
    fs1.probed.length > 0 && fs1.probed.every(p => !p.startsWith('\\C:')),
    `probed=${JSON.stringify(fs1.probed)}`,
  )

  const fs2 = makeFakeFs(winTable)
  const resolved2 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    'C:\\src\\proj\\src\\components',
    fs2.realpath,
  )
  check(
    'win32 existing directory resolves in one realpath probe',
    resolved2 === 'D:\\work\\mercury\\src\\components' && fs2.probed.length === 1 && fs2.probed[0] === 'C:\\src\\proj\\src\\components',
    `got ${JSON.stringify(resolved2)}, probed=${JSON.stringify(fs2.probed)}`,
  )

  const fs3 = makeFakeFs(winTable)
  const resolved3 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    'c:\\',
    fs3.realpath,
  )
  check(
    'win32 bare drive root resolves directly to drive root',
    resolved3 === 'C:\\' && fs3.probed.includes('c:\\'),
    `got ${JSON.stringify(resolved3)}, probed=${JSON.stringify(fs3.probed)}`,
  )

  const fs4 = makeFakeFs(winTable)
  const resolved4 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    '\\\\server\\share\\dir\\new.ts',
    fs4.realpath,
  )
  check(
    'win32 UNC path resolves share root and appends missing tail',
    resolved4 === '\\\\server\\share\\real-dir\\new.ts',
    `got ${JSON.stringify(resolved4)}, probed=${JSON.stringify(fs4.probed)}`,
  )

  const fs5 = makeFakeFs(winTable)
  const resolved5 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    'Z:\\missing\\nested\\file.ts',
    fs5.realpath,
  )
  check(
    'win32 nonexistent drive falls back to its own drive root without doubling',
    resolved5 === 'Z:\\missing\\nested\\file.ts' && fs5.probed.includes('Z:\\'),
    `got ${JSON.stringify(resolved5)}, probed=${JSON.stringify(fs5.probed)}`,
  )
})

withPlatform('darwin', () => {
  const posixTable: Record<string, string> = {
    '/': '/',
    '/tmp': '/private/tmp',
    '/tmp/proj': '/private/tmp/proj',
  }
  const fs1 = makeFakeFs(posixTable)
  const resolved1 = (realTargetPath as (p: string, r?: (c: string) => string) => string)(
    '/tmp/proj/src/new.ts',
    fs1.realpath,
  )
  check(
    'posix path resolves deepest existing ancestor and appends missing tail',
    resolved1 === '/private/tmp/proj/src/new.ts',
    `got ${JSON.stringify(resolved1)}, probed=${JSON.stringify(fs1.probed)}`,
  )

  const fs2 = makeFakeFs(posixTable)
  const resolved2 = (realTargetPath as (p: string, r?: (c: string) => string) => string)('/', fs2.realpath)
  check(
    'posix root resolves directly to /',
    resolved2 === '/' && fs2.probed.length === 1 && fs2.probed[0] === '/',
    `got ${JSON.stringify(resolved2)}, probed=${JSON.stringify(fs2.probed)}`,
  )
})

console.log(failed === 0 ? `\nALL ${passed} TARGET-ROOT CHECKS PASS` : `\n${failed} CHECK(S) FAILED (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
