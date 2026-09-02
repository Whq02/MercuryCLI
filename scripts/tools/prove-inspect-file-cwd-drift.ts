#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-inspect-file-cwd-drift.ts — Inspect's file kind must
//  find project-local artifacts after the session cwd drifts.
//
//  The incident: the frame's Inspect row
//  answered ABSENT for .mercury/apollo/product-spec.md although Apollo had
//  written it earlier. Apollo writes spec files under the ORIGINAL project
//  root (<root>/.mercury/apollo/ — utils/projectConfig.apolloSpecDirectory);
//  the file adapter resolved relative refs against the LIVE cwd only, so
//  any cd into a subdirectory turned every root-relative ref ABSENT — a
//  phantom loss of a file that sat exactly where it was written.
//
//    C1  a root-relative ref resolves from a DRIFTED cwd (the incident)
//    C2  a ref that exists relative to the live cwd keeps winning (the
//        live resolution stays first)
//    C3  a genuinely missing ref answers absent and NAMES every path tried
//    C4  absolute refs are untouched by the fallback
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-inspect-file-cwd-drift.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'inspect-drift-home-'))
delete process.env.MERCURY_REFS
delete process.env.NODE_ENV

const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The project estate: a root with the Apollo spec, and a drifted subdir.
const root = mkdtempSync(join(tmpdir(), 'inspect-drift-root-'))
const specDir = join(root, '.mercury', 'apollo')
mkdirSync(specDir, { recursive: true })
const SPEC_BODY = '# product spec\nthe apollo interview wrote this.\n'
writeFileSync(join(specDir, 'product-spec.md'), SPEC_BODY)
const subdir = join(root, 'packages', 'web')
mkdirSync(subdir, { recursive: true })
writeFileSync(join(subdir, 'local.txt'), 'the live-cwd file\n')

setOriginalCwd(root)
const ctx = { owner: undefined as never, cwd: subdir, getAppState: undefined }

console.log('============================================================')
console.log(' Inspect file kind — cwd-drift resolution')
console.log('============================================================')

section('C1 — the incident: a root-relative ref from a drifted cwd')
{
  const r = await resolveResource('mercury://file/.mercury/apollo/product-spec.md', ctx as never)
  check('the spec resolves OK (never ABSENT for a file Apollo wrote)', r.state === 'ok', `state=${r.state} note=${(r as { note?: string }).note ?? ''}`)
  const text = r.state === 'ok' ? (r.resource.text ?? '') : ''
  check('the served text is the spec body', text.includes('the apollo interview wrote this'))
}

section('C2 — the live cwd stays the FIRST resolution root')
{
  const r = await resolveResource('mercury://file/local.txt', ctx as never)
  check('a live-cwd-relative ref still resolves', r.state === 'ok', `state=${r.state}`)
  const text = r.state === 'ok' ? (r.resource.text ?? '') : ''
  check('and serves the live-cwd file', text.includes('the live-cwd file'))
}

section('C3 — a genuinely missing ref names every path tried')
{
  const r = await resolveResource('mercury://file/never/was/here.md', ctx as never)
  check('absent for a missing file', r.state === 'absent', `state=${r.state}`)
  const note = (r as { note?: string }).note ?? ''
  check(
    'the note names BOTH resolution roots (live cwd and the original root)',
    note.includes(join(subdir, 'never/was/here.md')) && note.includes(join(root, 'never/was/here.md')),
    note,
  )
}

section('C4 — absolute refs are untouched')
{
  const abs = join(specDir, 'product-spec.md')
  const ok = await resolveResource(`mercury://file/${abs}`, ctx as never)
  check('an absolute ref resolves directly', ok.state === 'ok', `state=${ok.state}`)
  const missing = await resolveResource('mercury://file//no/such/abs/path.md', ctx as never)
  check('a missing absolute ref answers absent with its ONE path', missing.state === 'absent' && ((missing as { note?: string }).note ?? '').includes('/no/such/abs/path.md'))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
