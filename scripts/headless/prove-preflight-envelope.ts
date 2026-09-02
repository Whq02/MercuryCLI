#!/usr/bin/env bun
// ============================================================================
//  scripts/headless/prove-preflight-envelope.ts — preflight refusals ride the
//  stream-json envelope (FC-079). Under `-p --output-format stream-json
//  --verbose` a refusal used to arrive EITHER as an NDJSON result frame OR
//  as bare prose on stderr beside a zero-byte stdout, depending on which
//  validator fired: the product-composed refusals (failCli) and the option
//  table's own errors both bypassed emitLoadError — the function whose only
//  job is to render load refusals as JSON under this format.
//
//  Live on the built artifact, credential-free (all preflight):
//    §1 a product-composed refusal (bad --settings path) → one parseable
//       error_during_execution result frame, nonzero exit.
//    §2 an option-table refusal (--zzz-not-an-option) → same envelope.
//    §3 an argParser refusal (--max-turns 0) → same envelope.
//    §4 the text format keeps its prose (control — stderr, empty stdout).
//
//  Run: ~/.bun/bin/bun run scripts/headless/prove-preflight-envelope.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'preflight-env-home-')))
  const run = (args: string[]): { status: number | null; out: string; err: string } => {
    const result = spawnSync('node', [DIST, ...args], {
      env: { ...process.env, MERCURY_CONFIG_DIR: home, NODE_ENV: undefined } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60000,
    })
    return { status: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
  }
  const envelopeOf = (
    out: string,
  ): { type?: string; subtype?: string; is_error?: boolean; errors?: string[] } | null => {
    const lines = out.split('\n').filter(l => l.trim() !== '')
    if (lines.length !== 1) return null
    try {
      return JSON.parse(lines[0]!) as { type?: string; subtype?: string; is_error?: boolean; errors?: string[] }
    } catch {
      return null
    }
  }
  const SJ = ['-p', '--output-format', 'stream-json', '--verbose']

  const settingsRefusal = run([...SJ, '--settings', '/no/such/settings-file.json', 'hi'])
  const settingsEnvelope = envelopeOf(settingsRefusal.out)
  check(
    'a product-composed refusal (missing --settings) rides ONE result envelope',
    settingsRefusal.status !== 0 &&
      settingsEnvelope !== null &&
      settingsEnvelope.type === 'result' &&
      settingsEnvelope.subtype === 'error_during_execution' &&
      settingsEnvelope.is_error === true &&
      (settingsEnvelope.errors ?? []).some(e => e.includes('Settings file not found')),
    `rc=${settingsRefusal.status} out=${settingsRefusal.out.slice(0, 100).replace(/\s+/g, ' ')} err=${settingsRefusal.err.slice(0, 60).replace(/\s+/g, ' ')}`,
  )

  const unknownOption = run([...SJ, '--zzz-not-an-option', 'hi'])
  const unknownEnvelope = envelopeOf(unknownOption.out)
  check(
    "the option table's own refusal (unknown option) rides the envelope too",
    unknownOption.status !== 0 &&
      unknownEnvelope !== null &&
      unknownEnvelope.is_error === true &&
      (unknownEnvelope.errors ?? []).some(e => e.includes('zzz-not-an-option')),
    `rc=${unknownOption.status} out=${unknownOption.out.slice(0, 100).replace(/\s+/g, ' ')}`,
  )

  const argParserRefusal = run([...SJ, '--max-turns', '0', 'hi'])
  const argParserEnvelope = envelopeOf(argParserRefusal.out)
  check(
    'an argParser refusal (--max-turns 0) rides the envelope',
    argParserRefusal.status !== 0 &&
      argParserEnvelope !== null &&
      argParserEnvelope.is_error === true &&
      (argParserEnvelope.errors ?? []).some(e => e.includes('positive integer')),
    `rc=${argParserRefusal.status} out=${argParserRefusal.out.slice(0, 100).replace(/\s+/g, ' ')}`,
  )

  const textControl = run(['-p', '--settings', '/no/such/settings-file.json', 'hi'])
  check(
    'the text format keeps its prose refusal (control: stderr, no stdout envelope)',
    textControl.status !== 0 &&
      textControl.err.includes('Settings file not found') &&
      envelopeOf(textControl.out) === null,
    `rc=${textControl.status} err=${textControl.err.slice(0, 80).replace(/\s+/g, ' ')}`,
  )

  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-preflight-envelope: all green' : `\nprove-preflight-envelope: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
