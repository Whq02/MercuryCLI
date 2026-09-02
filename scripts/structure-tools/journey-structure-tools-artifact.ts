#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/journey-structure-tools-artifact.ts — the BILLED built-artifact
//  mission receipt (journey posture: operator/solo-run, NEVER a gate
//  member). One real `-p` turn through dist/mercury.mjs, OUTSIDE the repo,
//  proves the polyglot lane end to end: the model loads the Structure
//  tool via ToolSearch, runs a Python metavariable pattern query over a
//  mixed-language fixture, and reports the matched call.
//
//  Run:  ~/.bun/bin/bun scripts/structure-tools/journey-structure-tools-artifact.ts
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
const dist = join(repoRoot, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'lathe-journey-'))
writeFileSync(join(dir, 'app.py'), 'def greet(name):\n    legacy_log(name)\n')
writeFileSync(join(dir, 'main.go'), 'package main\n\nfunc main() {}\n')
writeFileSync(join(dir, 'util.ts'), 'export const x = 1\n')

const prompt = `Use ToolSearch to load the Structure tool, then call Structure exactly once with op:"query" and pattern:"legacy_log($X)". Reply with ONLY the matched file path and the captured $X value, nothing else.`

console.log('journey: one -p turn through the built artifact (billed)')
const out = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, '-p', prompt, '--allowedTools', 'ToolSearch,Structure'], {
  cwd: dir,
  encoding: 'utf8',
  timeout: 240_000,
  env: { ...process.env },
})

const ok = out.includes('app.py') && out.includes('name')
console.log(`stdout tail: ${out.trim().split('\n').slice(-3).join(' | ')}`)
if (!ok) {
  console.error('journey-structure-tools-artifact: RED — the pattern match did not come back through the built binary')
  process.exit(1)
}
console.log('journey-structure-tools-artifact: GREEN — pattern query answered through dist/mercury.mjs from a disposable cwd')
