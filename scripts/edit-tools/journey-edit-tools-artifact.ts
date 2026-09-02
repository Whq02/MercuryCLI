#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/journey-edit-tools-artifact.ts — the BILLED built-artifact
//  mission receipt (journey posture: operator/solo-run, NEVER a gate
//  member). One real `-p` turn through dist/mercury.mjs proves the S1 front
//  door end to end: the model calls Read on a DIRECTORY and reports the
//  bounded listing the router produced.
//
//  Run:  ~/.bun/bin/bun scripts/edit-tools/journey-edit-tools-artifact.ts
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
const dist = join(repoRoot, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  console.error('dist/mercury.mjs missing — bun run build.ts first')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'anvil-journey-'))
mkdirSync(join(dir, 'payload'))
for (const name of ['alpha.txt', 'bravo.md', 'charlie.json']) {
  writeFileSync(join(dir, 'payload', name), `${name}\n`)
}

const prompt = `Call the Read tool exactly once with file_path set to the directory ${join(dir, 'payload')} . Then reply with ONLY the entry names it listed, comma-separated, nothing else.`

console.log('journey: one -p turn through the built artifact (billed)')
const out = execFileSync((process.execPath.includes('bun') ? 'node' : process.execPath), [dist, '-p', prompt, '--allowedTools', 'Read'], {
  cwd: dir,
  encoding: 'utf8',
  timeout: 240_000,
  env: { ...process.env },
})

const ok = ['alpha.txt', 'bravo.md', 'charlie.json'].every(n => out.includes(n))
console.log(`stdout tail: ${out.trim().split('\n').slice(-3).join(' | ')}`)
if (!ok) {
  console.error('journey-edit-tools-artifact: RED — the listing entries did not come back through the front door')
  process.exit(1)
}
console.log('journey-edit-tools-artifact: GREEN — S1 served a directory through the built binary, live turn receipt')
