#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && hint ? ` — change: ${hint}` : ''}`)
}

const { brushLockKindFor, brushPrepareCommand, BRUSH_PACK_PLATFORMS } = await import('../../src/platform/shell/brushPack.ts')
const LOCK = join(ROOT, 'vendor', 'brush.lock.json')
const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { platforms: Record<string, { kind?: string }> }

console.log('§1 the lock decides the preparing command, per platform')
for (const platform of BRUSH_PACK_PLATFORMS) {
  const kind = brushLockKindFor(LOCK, platform)
  const expected = lock.platforms[platform]?.kind === 'build' ? 'build' : 'fetch'
  check(`${platform}: the lock reads ${expected}`, kind === expected, kind, 'brushLockKindFor in src/platform/shell/brushPack.ts must return the kind that vendor/brush.lock.json records for this platform, build or fetch')
  const words = brushPrepareCommand(kind, platform, false, null)
  if (expected === 'build') {
    check(`${platform}: the words name build-brush.ts (upstream publishes no binary — the crate is compiled)`, /^bun run scripts\/vendor\/build-brush\.ts \(needs cargo\)$/.test(words), words, 'brushPrepareCommand in src/platform/shell/brushPack.ts must return the build-brush.ts command for a platform whose lock kind is build')
  } else {
    check(`${platform}: the words name fetch-brush.ts`, words === 'bun run scripts/vendor/fetch-brush.ts', words, 'brushPrepareCommand in src/platform/shell/brushPack.ts must return the fetch-brush.ts command for a platform whose lock kind is fetch')
  }
}
check('win-x64 is the build entry (the doc and fetch-brush.ts say so)', lock.platforms['win-x64']?.kind === 'build', '', 'set the win-x64 kind to build in vendor/brush.lock.json')
check('a cross build names its target for the build road', brushPrepareCommand('build', 'win-x64', true, 'windows-x64') === 'bun run scripts/vendor/build-brush.ts --target windows-x64 (needs cargo)', '', 'brushPrepareCommand in src/platform/shell/brushPack.ts must add --target for a cross build on the build road')
check('a cross build names its platform for the fetch road', brushPrepareCommand('fetch', 'linux-x64', true, 'linux-x64') === 'bun run scripts/vendor/fetch-brush.ts --platform linux-x64', '', 'brushPrepareCommand in src/platform/shell/brushPack.ts must add --platform for a cross build on the fetch road')
check('an unreadable lock falls back to the fetch road', brushLockKindFor(join(ROOT, 'vendor', 'no-such.lock.json'), 'win-x64') === 'fetch', '', 'brushLockKindFor in src/platform/shell/brushPack.ts must return fetch when the lock file cannot be read')

console.log(failures === 0 ? '\nprove-brush-prepare-words: ALL LAWS HOLD' : `\nprove-brush-prepare-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
