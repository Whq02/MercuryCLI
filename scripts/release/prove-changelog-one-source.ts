#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as changelog from '../../src/commands/update-notes/changelog.js'
import { getAllReleaseNotes, getStoredChangelog } from '../../src/boot/releaseNotes.js'

const { releaseNotesFor } = (await import('./notesFromChangelog.mjs')) as {
  releaseNotesFor: (version: string, rootDir: string) => string | undefined
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const buildChangelog = (changelog as { buildMercuryChangelog?: (rootDir?: string) => string }).buildMercuryChangelog
check('src/commands/update-notes/changelog.ts exports buildMercuryChangelog(rootDir)', typeof buildChangelog === 'function')

const stored = await getStoredChangelog()
const all = getAllReleaseNotes(stored)
const byVersion = new Map(all)
const post42 = all.map(([v]) => v).filter(v => {
  const idx = all.findIndex(([ver]) => ver === '1.0.0-beta.43')
  return idx >= 0 && all.findIndex(([ver]) => ver === v) >= idx
})
let post42Matches = 0
for (const v of post42) {
  const appBullets = byVersion.get(v) ?? []
  const expected = `# Mercury ${v}\n\n${appBullets.map(note => `- ${note}`).join('\n')}\n`
  if (releaseNotesFor(v, ROOT) === expected) post42Matches++
}
check(`every release from 1.0.0-beta.43 onward agrees between in-app changelog and notesFromChangelog.mjs (${post42Matches}/${post42.length})`, post42.length > 0 && post42Matches === post42.length)

const fixture = mkdtempSync(join(tmpdir(), 'changelog-one-source-'))
try {
  const releasesDir = join(fixture, 'docs', 'releases')
  mkdirSync(releasesDir, { recursive: true })
  const docPath = join(releasesDir, '9.9.9.md')
  writeFileSync(docPath, '# 9.9.9 — ready for the tag\n\n**State:** ready.\n\n## What changed\n\n- First wrapped\n  bullet\n- Second bullet\n')

  const built = typeof buildChangelog === 'function' ? buildChangelog(fixture) : ''
  const parsed = getAllReleaseNotes(built)
  check('synthetic checkout with only docs/releases/9.9.9.md feeds the in-app changelog', JSON.stringify(parsed) === JSON.stringify([['9.9.9', ['First wrapped bullet', 'Second bullet']]]), JSON.stringify(parsed))
  check('notesFromChangelog.mjs reads the same synthetic docs/releases/9.9.9.md', releaseNotesFor('9.9.9', fixture) === '# Mercury 9.9.9\n\n- First wrapped bullet\n- Second bullet\n', String(releaseNotesFor('9.9.9', fixture)))

  writeFileSync(docPath, '# 9.9.9 — published 2026-12-01\n\n## What changed\n\n- First wrapped\n  bullet\n- Second bullet\n- Third bullet\n')
  const updatedParsed = typeof buildChangelog === 'function' ? getAllReleaseNotes(buildChangelog(fixture)) : []
  const updatedScript = releaseNotesFor('9.9.9', fixture)
  check('editing docs/releases/9.9.9.md updates both the in-app list and notesFromChangelog.mjs together', JSON.stringify(updatedParsed) === JSON.stringify([['9.9.9', ['First wrapped bullet', 'Second bullet', 'Third bullet']]]) && updatedScript === '# Mercury 9.9.9\n\n- First wrapped bullet\n- Second bullet\n- Third bullet\n')

  const releaseScriptsDir = join(fixture, 'scripts', 'release')
  mkdirSync(releaseScriptsDir, { recursive: true })
  for (const name of readdirSync(join(ROOT, 'scripts', 'release'))) {
    if (name.endsWith('.mjs') || name.endsWith('.json')) {
      copyFileSync(join(ROOT, 'scripts', 'release', name), join(releaseScriptsDir, name))
    }
  }
  const cliOk = spawnSync('node', [join(releaseScriptsDir, 'notesFromChangelog.mjs'), 'v9.9.9'], { encoding: 'utf8', timeout: 15_000 })
  check('notesFromChangelog.mjs CLI reads docs/releases/9.9.9.md with no node_modules', cliOk.status === 0 && cliOk.stdout === '# Mercury 9.9.9\n\n- First wrapped bullet\n- Second bullet\n- Third bullet\n', cliOk.stderr)

  const cliMiss = spawnSync('node', [join(releaseScriptsDir, 'notesFromChangelog.mjs'), 'v9.9.8'], { encoding: 'utf8', timeout: 15_000 })
  check('notesFromChangelog.mjs CLI fails naming docs/releases/9.9.8.md when absent', cliMiss.status !== 0 && cliMiss.stderr.includes('docs/releases/9.9.8.md'), cliMiss.stderr.trim())

  writeFileSync(docPath, '# 9.9.9 — queued\n\n## What changed\n\n- Still queued\n')
  const queuedParsed = typeof buildChangelog === 'function' ? getAllReleaseNotes(buildChangelog(fixture)) : [['queued-untested', []]]
  check('a queued release doc is omitted from the in-app changelog while still readable by notesFromChangelog.mjs', queuedParsed.length === 0 && releaseNotesFor('9.9.9', fixture) === '# Mercury 9.9.9\n\n- Still queued\n')

  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'mercury', version: '9.9.8', engines: { node: '>=24.20.0 <25' } }))
  mkdirSync(join(fixture, 'dist', 'vendor', 'ripgrep', 'x64-win32'), { recursive: true })
  writeFileSync(join(fixture, 'dist', 'verify-artifact.mjs'), 'export const archiveBaseNameFor = (v, t) => `mercury-v${v}-${t}`\n')
  for (const name of ['mercury.mjs', 'crew-board.mjs', 'shell-parent-guard.mjs', 'tensorfold-adapter.mjs']) {
    writeFileSync(join(fixture, 'dist', name), 'export {}\n')
  }
  writeFileSync(join(fixture, 'dist', 'manifest.json'), JSON.stringify({ degraded: [], buildTree: null }))
  mkdirSync(join(fixture, 'assets', 'splash'), { recursive: true })
  writeFileSync(join(fixture, 'assets', 'splash', 'mercury-splash.mjs'), 'export {}\n')
  writeFileSync(join(fixture, 'assets', 'splash', 'splash-core.mjs'), 'export {}\n')
  mkdirSync(join(fixture, 'vendor'), { recursive: true })
  for (const name of readdirSync(join(ROOT, 'vendor'))) {
    if (name.endsWith('.lock.json')) copyFileSync(join(ROOT, 'vendor', name), join(fixture, 'vendor', name))
  }
  mkdirSync(join(fixture, 'src', 'main'), { recursive: true })
  mkdirSync(join(fixture, 'src', 'entrypoints'), { recursive: true })
  writeFileSync(join(fixture, 'src', 'main.tsx'), "program.command('health')\n")
  writeFileSync(join(fixture, 'src', 'main', 'sessionDoors.ts'), '')
  writeFileSync(join(fixture, 'src', 'main', 'subcommands.ts'), '')
  writeFileSync(join(fixture, 'src', 'entrypoints', 'cli.tsx'), "if (args[0] === 'health') {}\n")
  mkdirSync(join(fixture, 'src', 'constants'), { recursive: true })
  writeFileSync(join(fixture, 'src', 'constants', 'changelog.ts'), 'export const MERCURY_CHANGELOG = `## 9.9.8\n- Duplicate only\n`\n')

  const pkgArgs = [join(releaseScriptsDir, 'package.mjs'), '--target', 'windows-x64', '--allow-degraded', '--allow-stale-verify-receipts', ...(process.platform === 'win32' ? [] : ['--assemble-only'])]
  const pkgMissingDoc = spawnSync('node', pkgArgs, { encoding: 'utf8', timeout: 30_000 })
  check('package.mjs ignores a duplicate src/commands/update-notes/changelog.ts and fails naming docs/releases/9.9.8.md', pkgMissingDoc.status !== 0 && pkgMissingDoc.stderr.includes('docs/releases/9.9.8.md'), pkgMissingDoc.stderr.trim().slice(0, 200))

  rmSync(join(fixture, 'src', 'constants'), { recursive: true, force: true })
  writeFileSync(join(releasesDir, '9.9.8.md'), '# 9.9.8 — ready for the tag\n\n## What changed\n\n- Packaged from docs\n')
  const pkgWithDoc = spawnSync('node', pkgArgs, { encoding: 'utf8', timeout: 30_000 })
  check('package.mjs accepts docs/releases/9.9.8.md without src/commands/update-notes/changelog.ts and advances to THIRD_PARTY_NOTICES.md', pkgWithDoc.status !== 0 && pkgWithDoc.stderr.includes('THIRD_PARTY_NOTICES.md'), pkgWithDoc.stderr.trim().slice(0, 200))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log('PASS prove-changelog-one-source')
  process.exit(0)
}
console.log(`FAIL prove-changelog-one-source (${failures})`)
process.exit(1)
