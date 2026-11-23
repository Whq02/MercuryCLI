#!/usr/bin/env bun
import * as hostPath from 'node:path'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { realTargetPath } from '../../src/permissions/guards/wardsGuard.js'
import { splitPathFromRoot } from '../../src/platform/host-os/paths.js'

const TARGET_ROOT_FAIL_HINT = 'fix: splitPathFromRoot in src/platform/host-os/paths.ts (root, segments and separator per path grammar) or realTargetPath in src/permissions/guards/wardsGuard.ts (host resolution of the deepest existing ancestor)'
let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  [PASS] ${label}`)
  } else {
    failed++
    console.log(`  [FAIL] ${label} — ${detail}${detail ? ' | ' : ''}${TARGET_ROOT_FAIL_HINT}`)
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

function resolveWithGrammar(
  target: string,
  grammar: typeof hostPath,
  resolveReal: (candidate: string) => string,
): string {
  const { root, segments, sep } = splitPathFromRoot(target, grammar)
  const realAt = (depth: number): string | null => {
    const candidate = depth === 0 ? root : root + segments.slice(0, depth).join(sep)
    try {
      return resolveReal(candidate)
    } catch {
      return null
    }
  }
  let missing = segments.length
  const whole = realAt(missing)
  if (whole !== null) return whole
  let found = 0
  let real: string | null = null
  for (let step = 1; missing - step > 0; step *= 2) {
    const probe = missing - step
    const seen = realAt(probe)
    if (seen !== null) {
      found = probe
      real = seen
      break
    }
    missing = probe
  }
  while (missing - found > 1) {
    const mid = (found + missing) >> 1
    const seen = realAt(mid)
    if (seen === null) missing = mid
    else {
      found = mid
      real = seen
    }
  }
  const base = real ?? realAt(0) ?? root
  const tail = segments.slice(found)
  return tail.length === 0 ? base : grammar.join(base, ...tail)
}

console.log('============================================================')
console.log(' wardsGuard target root — win32 & posix grammars + host realTargetPath')
console.log('============================================================')

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

const winFs1 = makeFakeFs(winTable)
const winResolved1 = resolveWithGrammar('C:\\src\\proj\\src\\components\\Foo.tsx', pathWin32, winFs1.realpath)
check(
  'win32 grammar resolves deepest existing junction without doubling drive',
  winResolved1 === 'D:\\work\\mercury\\src\\components\\Foo.tsx',
  `got ${JSON.stringify(winResolved1)}, probed=${JSON.stringify(winFs1.probed)}`,
)
check(
  'win32 grammar never prepends leading backslash before drive letter',
  winFs1.probed.length > 0 && winFs1.probed.every(p => !p.startsWith('\\C:')),
  `probed=${JSON.stringify(winFs1.probed)}`,
)

const winFs2 = makeFakeFs(winTable)
const winResolved2 = resolveWithGrammar('C:\\src\\proj\\src\\components', pathWin32, winFs2.realpath)
check(
  'win32 grammar resolves existing directory in one probe',
  winResolved2 === 'D:\\work\\mercury\\src\\components' && winFs2.probed.length === 1 && winFs2.probed[0] === 'C:\\src\\proj\\src\\components',
  `got ${JSON.stringify(winResolved2)}, probed=${JSON.stringify(winFs2.probed)}`,
)

const winFs3 = makeFakeFs(winTable)
const winResolved3 = resolveWithGrammar('c:\\', pathWin32, winFs3.realpath)
check(
  'win32 grammar resolves bare drive root directly',
  winResolved3 === 'C:\\' && winFs3.probed.includes('c:\\'),
  `got ${JSON.stringify(winResolved3)}, probed=${JSON.stringify(winFs3.probed)}`,
)

const winFs4 = makeFakeFs(winTable)
const winResolved4 = resolveWithGrammar('\\\\server\\share\\dir\\new.ts', pathWin32, winFs4.realpath)
check(
  'win32 grammar resolves UNC share root and appends missing tail',
  winResolved4 === '\\\\server\\share\\real-dir\\new.ts',
  `got ${JSON.stringify(winResolved4)}, probed=${JSON.stringify(winFs4.probed)}`,
)

const winFs5 = makeFakeFs(winTable)
const winResolved5 = resolveWithGrammar('Z:\\missing\\nested\\file.ts', pathWin32, winFs5.realpath)
check(
  'win32 grammar nonexistent drive falls back to its own root without doubling',
  winResolved5 === 'Z:\\missing\\nested\\file.ts' && winFs5.probed.includes('Z:\\'),
  `got ${JSON.stringify(winResolved5)}, probed=${JSON.stringify(winFs5.probed)}`,
)

const winSlash = splitPathFromRoot('C:/a/b', pathWin32)
check(
  'win32 grammar splits forward-slash drive paths on both separators',
  winSlash.root === 'C:/' && JSON.stringify(winSlash.segments) === '["a","b"]' && winSlash.sep === '\\',
  JSON.stringify(winSlash),
)

const posixInputs = ['/a/b', '/', 'rel/path', '', 'C:\\a\\b']
for (const input of posixInputs) {
  const got = splitPathFromRoot(input, pathPosix)
  const oldSegments = input.split('/').filter(Boolean)
  const ok = got.root === '/' && got.sep === '/' && JSON.stringify(got.segments) === JSON.stringify(oldSegments)
  check(`posix grammar byte-equal to base split for ${JSON.stringify(input)}`, ok, JSON.stringify({ got, oldSegments }))
}

if (hostPath.sep === '\\') {
  const hostFs = makeFakeFs(winTable)
  const hostResolved = realTargetPath('C:\\src\\proj\\src\\components\\Foo.tsx', hostFs.realpath)
  check(
    'host realTargetPath on win32 resolves drive junction without doubling drive',
    hostResolved === 'D:\\work\\mercury\\src\\components\\Foo.tsx' && hostFs.probed.every(p => !p.startsWith('\\C:')),
    `got ${JSON.stringify(hostResolved)}, probed=${JSON.stringify(hostFs.probed)}`,
  )
  const hostUncFs = makeFakeFs(winTable)
  const hostUncResolved = realTargetPath('\\\\server\\share\\dir\\new.ts', hostUncFs.realpath)
  check(
    'host realTargetPath on win32 resolves UNC path cleanly',
    hostUncResolved === '\\\\server\\share\\real-dir\\new.ts',
    `got ${JSON.stringify(hostUncResolved)}, probed=${JSON.stringify(hostUncFs.probed)}`,
  )
} else {
  const posixTable: Record<string, string> = {
    '/': '/',
    '/tmp': '/private/tmp',
    '/tmp/proj': '/private/tmp/proj',
  }
  const hostFs1 = makeFakeFs(posixTable)
  const hostResolved1 = realTargetPath('/tmp/proj/src/new.ts', hostFs1.realpath)
  check(
    'host realTargetPath on posix resolves deepest existing ancestor and appends tail',
    hostResolved1 === '/private/tmp/proj/src/new.ts',
    `got ${JSON.stringify(hostResolved1)}, probed=${JSON.stringify(hostFs1.probed)}`,
  )
  const hostFs2 = makeFakeFs(posixTable)
  const hostResolved2 = realTargetPath('/', hostFs2.realpath)
  check(
    'host realTargetPath on posix resolves root directly to /',
    hostResolved2 === '/' && hostFs2.probed.length === 1 && hostFs2.probed[0] === '/',
    `got ${JSON.stringify(hostResolved2)}, probed=${JSON.stringify(hostFs2.probed)}`,
  )
}

console.log(failed === 0 ? `\nALL ${passed} TARGET-ROOT CHECKS PASS` : `\n${failed} CHECK(S) FAILED (${passed} passed)`)
process.exit(failed === 0 ? 0 : 1)
