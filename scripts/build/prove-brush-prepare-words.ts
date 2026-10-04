#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { brushLockKindFor, brushPrepareCommand, BRUSH_PACK_PLATFORMS } = await import('../../src/utils/shell/brushPack.ts')
const LOCK = join(ROOT, 'vendor', 'brush.lock.json')
const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { platforms: Record<string, { kind?: string }> }

console.log('§1 the lock decides the preparing command, per platform')
for (const platform of BRUSH_PACK_PLATFORMS) {
  const kind = brushLockKindFor(LOCK, platform)
  const expected = lock.platforms[platform]?.kind === 'build' ? 'build' : 'fetch'
  check(`${platform}: the lock reads ${expected}`, kind === expected, kind)
  const words = brushPrepareCommand(kind, platform, false, null)
  if (expected === 'build') {
    check(`${platform}: the words name build-brush.ts (upstream publishes no binary — the crate is compiled)`, /^bun run scripts\/vendor\/build-brush\.ts \(needs cargo\)$/.test(words), words)
  } else {
    check(`${platform}: the words name fetch-brush.ts`, words === 'bun run scripts/vendor/fetch-brush.ts', words)
  }
}
check('win-x64 is the build entry (the doc and fetch-brush.ts say so)', lock.platforms['win-x64']?.kind === 'build')
check('a cross build names its target for the build road', brushPrepareCommand('build', 'win-x64', true, 'windows-x64') === 'bun run scripts/vendor/build-brush.ts --target windows-x64 (needs cargo)')
check('a cross build names its platform for the fetch road', brushPrepareCommand('fetch', 'linux-x64', true, 'linux-x64') === 'bun run scripts/vendor/fetch-brush.ts --platform linux-x64')
check('an unreadable lock falls back to the fetch road', brushLockKindFor(join(ROOT, 'vendor', 'no-such.lock.json'), 'win-x64') === 'fetch')

console.log('§2 the build and the doc hold one truth for a Windows builder')
{
  const build = readFileSync(join(ROOT, 'build.ts'), 'utf8')
  check('build.ts derives the brush remedy from the lock (brushLockKindFor + brushPrepareCommand)', /brushLockKindFor\(/.test(build) && /brushPrepareCommand\(/.test(build))
  check('…and names no fixed fetch-brush remedy of its own', !/Prepare it: bun run scripts\/vendor\/fetch-brush/.test(build) && !/remedy: bun run scripts\/vendor\/fetch-brush/.test(build))
  const doc = readFileSync(join(ROOT, 'docs', 'INSTALL-WINDOWS-FROM-SOURCE.md'), 'utf8')
  check('docs/INSTALL-WINDOWS-FROM-SOURCE.md sends the Windows builder to build-brush.ts', /bun run scripts\/vendor\/build-brush\.ts/.test(doc))
  check('…and never to fetch-brush.ts', !/fetch-brush\.ts/.test(doc))
  const pack = readFileSync(join(ROOT, 'src', 'utils', 'shell', 'brushPack.ts'), 'utf8')
  check('the runtime note draws its words from the same function', /prepare it: \$\{brushPrepareCommand\(/.test(pack))
}

console.log(failures === 0 ? '\nprove-brush-prepare-words: ALL LAWS HOLD' : `\nprove-brush-prepare-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
