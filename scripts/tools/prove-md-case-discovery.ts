#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
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

const { setSessionTrustAccepted: trustTheProofFolder } = await import('../../src/boot/process-state/processState.js')
trustTheProofFolder(true)
const agentsDir = join(PROJ, '.mercury', 'agents')
mkdirSync(agentsDir, { recursive: true })
const agentBody = (name: string): string =>
  `---\nname: ${name}\ndescription: fixture\n---\nDo the ${name} thing.\n`
writeFileSync(join(agentsDir, 'lower.md'), agentBody('lower'))
writeFileSync(join(agentsDir, 'Upper.MD'), agentBody('upper'))

section('§1 BOTH SPELLINGS DISCOVERED')
{
  const { loadMarkdownFilesForSubdir } = await import('../../src/platform/settings/markdownConfigLoader.js')
  const files = await loadMarkdownFilesForSubdir('agents', PROJ)
  const names = files.map(f => f.filePath.split('/').pop())
  check('lower.md is discovered', names.includes('lower.md'), names.join(', ') + (names.includes('lower.md') ? '' : ' | fix: loadMarkdownFilesForSubdir in src/platform/settings/markdownConfigLoader.ts must discover .md files'))
  check('Upper.MD is discovered too', names.includes('Upper.MD'), names.join(', ') + (names.includes('Upper.MD') ? '' : ' | fix: loadMarkdownFilesForSubdir in src/platform/settings/markdownConfigLoader.ts must match the .md extension case-insensitively (its directory walk lowercases the name before endsWith)'))
}


console.log(failures === 0 ? '\nprove-md-case-discovery: all green' : `\nprove-md-case-discovery: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
