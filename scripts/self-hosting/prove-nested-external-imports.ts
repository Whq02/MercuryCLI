#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'nested-ext-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_SIMPLE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const project = mkdtempSync(join(tmpdir(), 'nested-ext-project-'))
const outside = mkdtempSync(join(tmpdir(), 'nested-ext-outside-'))
const guide = join(outside, 'team-guide.md')
writeFileSync(guide, '# Team guide\n\nOUTSIDE-GUIDE-MARKER: land every change behind a prover.\n')
const nested = join(project, 'packages', 'core')
mkdirSync(nested, { recursive: true })
writeFileSync(join(nested, 'MERCURY.md'), `# Core package rules\n\nNESTED-MARKER: this package has its own rules.\n\n@${guide}\n`)
process.chdir(project)

const globalConfig = await import('../../src/utils/config/globalConfig.js')
globalConfig.enableConfigs()
const projectConfig = await import('../../src/utils/config/projectConfig.js')
const engine = await import('../../src/services/instructions/engine.js')
type Diagnostic = { kind: string; path?: string }

console.log('a nested instruction file honours the external-includes approval')

section('§1 no approval: the outside guide is dropped and the diagnostic says so')
{
  const diagnostics: Diagnostic[] = []
  const entries = await engine.getInstructionFilesForNestedDirectory(nested, join(nested, 'index.ts'), new Set(), diagnostics as never)
  const composed = entries.map(e => e.content).join('\n')
  check('the nested file itself composes (the fixture is meaningful)', composed.includes('NESTED-MARKER'), composed.slice(0, 120))
  check('the outside guide is NOT composed without approval', !composed.includes('OUTSIDE-GUIDE-MARKER'))
  check('THE DROP IS RECORDED: an external-import-blocked diagnostic names the guide (the base recorded nothing)', diagnostics.some(d => d.kind === 'external-import-blocked' && (d.path ?? '').endsWith('team-guide.md')), JSON.stringify(diagnostics))
}

section('§2 approved: the outside guide composes through the nested road')
{
  projectConfig.saveCurrentProjectConfig(current => ({ ...current, hasClaudeMdExternalIncludesApproved: true }))
  const diagnostics: Diagnostic[] = []
  const entries = await engine.getInstructionFilesForNestedDirectory(nested, join(nested, 'index.ts'), new Set(), diagnostics as never)
  const composed = entries.map(e => e.content).join('\n')
  check('THE APPROVED EXTERNAL IMPORT COMPOSES from a nested file (the base never could)', composed.includes('OUTSIDE-GUIDE-MARKER'), composed.slice(0, 200))
  check('…and no blocked-import diagnostic is minted for it', !diagnostics.some(d => d.kind === 'external-import-blocked'), JSON.stringify(diagnostics))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-nested-external-imports${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
