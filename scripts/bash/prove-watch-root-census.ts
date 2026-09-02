#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-watch-root-census.ts
//  PROOF: — the watcher-root census ratchet. Every fs-event
//  watcher establishment in src/ routes its root through resolveWatchRoot
//  (the HZ1 win32 8.3-short-segment crash class: libuv ASSERTS the watched
//  root prefixes every delivered filename — an un-normalized config-home
//  root killed the process on first event). watchFile sites are exempt by
//  construction (stat POLLING has no fs-event backend and survives
//  delete/recreate). New un-normalized watchers fail this census.
// ============================================================================

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

// In-process walk (hermetic — no external grep dependency).
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
      // stat polling — no fs-event backend, delete/recreate-safe by construction
      sites++
      pollingSites++
      return
    }
    if (!/chokidar\.watch\(|=\s*watch\(/.test(text)) return
    sites++
    // The LM-9 factory seam: skillChangeDetector's injectable
    // WatcherFactory owns this chokidar.watch body, and its ONE establishment
    // routes every target through the resolver AT THE SEAM
    // (`watcherFactory([...targets].map(resolveWatchRoot), …`) — ~116 lines
    // below the body, beyond any honest window. Recognized only while that
    // establishment spelling holds in the file: drop the map and this site
    // is an offender again.
    if (rel.endsWith('skillChangeDetector.ts') && raw.includes('watcherFactory([...targets].map(resolveWatchRoot)')) return
    // Multi-line calls: the root argument may sit on the following lines —
    // or, when the arm-target list is built first, the routing sits a few
    // lines ABOVE the call (the S13 file-changed watcher resolves every arm
    // target through resolveWatchRoot while building the list, then watches
    // it; the keybindings loader builds the resolved set and
    // declares its onChange handler before the watch call, pushing the
    // resolver ~20 lines up). The window looks 24 lines back and 4 forward;
    // either way the root must visibly route through the resolver near the
    // establishment site.
    const window = lines.slice(Math.max(0, i - 24), i + 4).join('\n')
    if (!/resolveWatchRoot/.test(window)) {
      offenders.push(`${rel}:${i + 1}: ${text.trim().slice(0, 90)}`)
    }
  })
}
check(`every fs-event watcher root routes through resolveWatchRoot (${sites} sites, ${pollingSites} polling-exempt)`, offenders.length === 0, offenders.join(' · '))
check('census saw a realistic population (anti-rot: the grep still matches)', sites >= 10, `sites=${sites}`)

// ── §10.10 UNC/drive-form contract at the owner ─────────────────────────────
// Two arms are assertable in THIS venue; the third is [win] by construction.
//   (a) POSIX identity: resolveWatchRoot must return the input untouched on
//       non-win32 (envUtils' symlink contract — realpath must never move a
//       session's identity). Real production arm on this host.
//   (b) Forced win32 arm never throws on UNC / \\?\ / drive shapes. Identity
//       on an ABSENT win32 root is NOT assertable under a faked platform:
//       node:path's exports keep POSIX semantics, so dirname collapses the
//       whole segment to '.' and the walk cwd-joins — an artifact of the
//       fake, unreachable in production. Under real win32 path semantics the
//       parent === base guard terminates at 'Z:\' / '\\server\share' and
//       bails identity — enforced by the owner's shape, [win] venue.
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
