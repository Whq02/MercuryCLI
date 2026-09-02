#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 w32-05 — the sed edit door asks isAbsolute')
{
  check('the mechanism: win32 knows C:/… and C:\\… are absolute; POSIX does not', win32.isAbsolute('C:/src/x.ts') && win32.isAbsolute('C:\\src\\x.ts') && win32.isAbsolute('\\\\server\\share\\f') && !posix.isAbsolute('C:/src/x.ts'))
  check('…and both agree on the POSIX form (the old guard\'s one truth)', win32.isAbsolute('/x') && posix.isAbsolute('/x'))
  const bash = read('src/tools/BashTool/BashTool.tsx')
  check('the resolver reads isAbsolute', bash.includes('return isAbsolute(path) ? path : join(getCwd(), path)') && bash.includes("import { isAbsolute, join } from 'node:path'"))
  check("POISON: the '/'-prefix guard is gone", !bash.includes("return path.startsWith('/') ? path : join(getCwd(), path)"))
  check('the tilde arm stands unchanged above it', bash.includes("if (path.startsWith('~')) {"))
}

process.exit(failures === 0 ? 0 : 1)
