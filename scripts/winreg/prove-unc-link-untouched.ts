#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'unc-link-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'unc-link-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const fsOps = await import('../../src/utils/fsOperations.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const REMOTE_LINK = join(PROJ, 'docs')
const LOCAL_LINK = join(PROJ, 'notes')
const UNC = '\\\\attacker.example\\share\\docs'
const touched: string[] = []
const isUnc = (p: unknown): boolean => typeof p === 'string' && /^(\\\\|\/\/)/.test(p)
const linkStats = {
  isSymbolicLink: () => true,
  isFIFO: () => false,
  isSocket: () => false,
  isCharacterDevice: () => false,
  isBlockDevice: () => false,
  isDirectory: () => false,
  isFile: () => false,
}
const links = new Map<string, string>([
  [REMOTE_LINK, UNC],
  [LOCAL_LINK, PROJ],
])
const real = fsOps.getFsImplementation()
const fake = new Proxy(real, {
  get(target, prop, receiver) {
    const original = Reflect.get(target, prop, receiver)
    if (typeof original !== 'function') return original
    return (...args: unknown[]) => {
      const path = args[0]
      if (isUnc(path)) {
        touched.push(`${String(prop)}(${path})`)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      if (typeof path === 'string' && links.has(path)) {
        if (prop === 'existsSync') return true
        if (prop === 'lstatSync') return linkStats
        if (prop === 'readlinkSync') return links.get(path)
        if (prop === 'realpathSync') {
          if (isUnc(links.get(path))) touched.push(`realpathSync(${path}) followed the link to the share`)
          return links.get(path)
        }
      }
      return original.apply(target, args)
    }
  },
})

console.log('============================================================')
console.log(' a symlink to a UNC share and the permission resolution set')
console.log('============================================================')

fsOps.setFsImplementation(fake as never)
const remote = fsOps.getPathsForPermissionCheck(REMOTE_LINK)
const remoteTouched = [...touched]
const local = fsOps.getPathsForPermissionCheck(LOCAL_LINK)
fsOps.setOriginalFsImplementation()

check('the UNC target is in the resolution set, so the UNC ask still sees it', remote.includes(UNC), JSON.stringify(remote))
check('nothing on the share is touched while the set is built', remoteTouched.length === 0, JSON.stringify(remoteTouched))
check('a link to a local folder still resolves to its target', local.includes(LOCAL_LINK) && local.includes(PROJ), JSON.stringify(local))

for (const dir of [PROJ, HOME]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? '\nALL UNC LINK CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
