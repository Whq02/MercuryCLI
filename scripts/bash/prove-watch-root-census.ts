#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Watcher-root census — ratchet')
console.log('============================================================')

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) yield* tsFiles(p)
    else if (/\.tsx?$/.test(e)) yield p
  }
}

const offenders: string[] = []
let sites = 0
let pollingSites = 0
for (const file of tsFiles(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file)
  if (rel.endsWith('watchRoot.ts')) continue
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  lines.forEach((text, i) => {
    if (/^\s*(\/\/|\*)/.test(text)) return
    if (/unwatchFile\(/.test(text)) return
    if (/\bwatchFile\(/.test(text)) {
      sites++
      pollingSites++
      return
    }
    if (!/chokidar\.watch\(|=\s*watch\(/.test(text)) return
    sites++
    if (rel.endsWith('skillChangeDetector.ts') && raw.includes('watcherFactory([...targets].map(resolveWatchRoot)')) return
    const window = lines.slice(Math.max(0, i - 24), i + 4).join('\n')
    if (!/resolveWatchRoot/.test(window)) {
      offenders.push(`${rel}:${i + 1}: ${text.trim().slice(0, 90)}`)
    }
  })
}
check(`every fs-event watcher root routes through resolveWatchRoot (${sites} sites, ${pollingSites} polling-exempt)`, offenders.length === 0, offenders.join(' · '))
check('census saw a realistic population (anti-rot: the grep still matches)', sites >= 10, `sites=${sites}`)

{
  const { resolveWatchRoot } = await import('../../src/utils/watchRoot.ts')
  const posixIn = '/tmp/some/root'
  check('POSIX identity is untouched (symlink contract preserved)', resolveWatchRoot(posixIn) === posixIn)
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    for (const p of ['\\\\server\\share\\proj\\sub', '\\\\?\\UNC\\server\\share\\x', 'Z:\\no\\such\\root']) {
      let threw = false
      try {
        resolveWatchRoot(p)
      } catch {
        threw = true
      }
      check(`win32 arm never throws for ${JSON.stringify(p)}`, !threw)
    }
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

console.log(failures === 0 ? '\n ✅ WATCH-ROOT CENSUS GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
