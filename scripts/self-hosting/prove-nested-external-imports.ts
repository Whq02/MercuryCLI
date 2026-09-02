#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-nested-external-imports.ts — a nested
//  instruction file composes its APPROVED external import, and records a
//  diagnostic when it drops one (FN-017 rank 13).
//
//  The boot walk derives its external-includes flag from the project's
//  approval and hands every file a diagnostics array. The lazy nested
//  loader — the ONLY road for directories below the boot cwd, since the
//  walk ascends and never descends — passed a literal `false` and no
//  diagnostics: an approved import from a nested MERCURY.md never reached
//  the model, and the external-import-blocked finding never reached the
//  bundle or /health, so the omission read as an instruction being
//  ignored. One owner of the decision now: the project's recorded
//  approval, read by both roads.
//
//   §1 DRIVEN, no approval: the outside guide is dropped AND the
//      diagnostic names it (the base recorded nothing)
//   §2 DRIVEN, approved: the outside guide composes (the base never did)
//
//  Run:  ~/.bun/bin/bun run scripts/self-hosting/prove-nested-external-imports.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE any src import; real config reads.
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

// The scratch project IS the boot ground (chdir BEFORE the first src import).
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

// ── §1 no approval ──────────────────────────────────────────────────────────
section('§1 no approval: the outside guide is dropped and the diagnostic says so')
{
  const diagnostics: Diagnostic[] = []
  const entries = await engine.getInstructionFilesForNestedDirectory(nested, join(nested, 'index.ts'), new Set(), diagnostics as never)
  const composed = entries.map(e => e.content).join('\n')
  check('the nested file itself composes (the fixture is meaningful)', composed.includes('NESTED-MARKER'), composed.slice(0, 120))
  check('the outside guide is NOT composed without approval', !composed.includes('OUTSIDE-GUIDE-MARKER'))
  check('THE DROP IS RECORDED: an external-import-blocked diagnostic names the guide (the base recorded nothing)', diagnostics.some(d => d.kind === 'external-import-blocked' && (d.path ?? '').endsWith('team-guide.md')), JSON.stringify(diagnostics))
}

// ── §2 approved ─────────────────────────────────────────────────────────────
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
