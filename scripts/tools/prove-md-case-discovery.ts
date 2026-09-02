#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-md-case-discovery.ts — config discovery finds .MD as
//  well as .md (FC-112). The discovery glob was case-sensitive
//  (ripgrep's globset default), so an agent, command or skill file named
//  Upper.MD was invisible — no diagnostic — on the very filesystems that
//  treat Upper.MD and upper.md as the same file. The native fallback walk
//  and the agents live-watch gates carried the same case-sensitive test.
//
//  §1 the driven road: loadMarkdownFilesForSubdir over a project carrying
//     lower.md and Upper.MD returns BOTH.
//  §2 the roads not drivable in-process (the native fallback fires only
//     when the search engine is absent; the watcher needs chokidar):
//     call-shaped pins on the case-folded gates.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-md-case-discovery.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mdcase-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'mdcase-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

const agentsDir = join(PROJ, '.mercury', 'agents')
mkdirSync(agentsDir, { recursive: true })
const agentBody = (name: string): string =>
  `---\nname: ${name}\ndescription: fixture\n---\nDo the ${name} thing.\n`
writeFileSync(join(agentsDir, 'lower.md'), agentBody('lower'))
writeFileSync(join(agentsDir, 'Upper.MD'), agentBody('upper'))

section('§1 BOTH SPELLINGS DISCOVERED')
{
  const { loadMarkdownFilesForSubdir } = await import('../../src/utils/markdownConfigLoader.js')
  const files = await loadMarkdownFilesForSubdir('agents', PROJ)
  const names = files.map(f => f.filePath.split('/').pop())
  check('lower.md is discovered', names.includes('lower.md'), names.join(', '))
  check('Upper.MD is discovered too', names.includes('Upper.MD'), names.join(', '))
}

section('§2 THE UNDRIVABLE ROADS CARRY THE SAME FOLD (call-shaped)')
{
  const loader = readFileSync(join(ROOT, 'src', 'utils', 'markdownConfigLoader.ts'), 'utf-8')
  check(
    'the discovery glob is case-insensitive (--iglob)',
    loader.includes("'--iglob', '*.md'") && !loader.includes("'--glob', '*.md'"),
  )
  check(
    'the native fallback folds case at both its gates',
    (loader.match(/toLowerCase\(\)\.endsWith\('\.md'\)/g) ?? []).length === 2,
  )
  const watch = readFileSync(join(ROOT, 'src', 'services', 'agents', 'watch.ts'), 'utf-8')
  check(
    'the agents live-watch gates fold case too',
    (watch.match(/toLowerCase\(\)\.endsWith\('\.md'\)/g) ?? []).length === 2,
  )
}

console.log(failures === 0 ? '\nprove-md-case-discovery: all green' : `\nprove-md-case-discovery: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
