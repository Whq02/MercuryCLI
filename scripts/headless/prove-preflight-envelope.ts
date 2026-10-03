#!/usr/bin/env bun
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
  type Outcome = { type?: string; status?: string; seq?: number; error?: { message?: string; class?: string } }
  const envelopeOf = (out: string): Outcome | null => {
    const lines = out.split('\n').filter(l => l.trim() !== '')
    if (lines.length !== 1) return null
    try {
      return JSON.parse(lines[0]!) as Outcome
    } catch {
      return null
    }
  }
  const refusedWith = (row: Outcome | null, words: string): boolean =>
    row !== null && row.type === 'outcome' && row.status === 'refused' && row.seq === 1 && (row.error?.message ?? '').includes(words)
  const SJ = ['run', '--format', 'rows']

  const settingsRefusal = run([...SJ, '--config', '/no/such/settings-file.json', 'hi'])
  const settingsEnvelope = envelopeOf(settingsRefusal.out)
  check(
    'a product-composed refusal (missing --config) rides ONE refused outcome row (seq 1)',
    settingsRefusal.status !== 0 && refusedWith(settingsEnvelope, 'Settings file not found'),
    `rc=${settingsRefusal.status} out=${settingsRefusal.out.slice(0, 100).replace(/\s+/g, ' ')} err=${settingsRefusal.err.slice(0, 60).replace(/\s+/g, ' ')}`,
  )

  const unknownOption = run([...SJ, '--zzz-not-an-option', 'hi'])
  const unknownEnvelope = envelopeOf(unknownOption.out)
  check(
    "an unknown option stays on the parser's stderr road",
    unknownOption.status !== 0 && unknownOption.out === '' && unknownEnvelope === null && unknownOption.err.includes("unknown option '--zzz-not-an-option'"),
    `rc=${unknownOption.status} out=${unknownOption.out} err=${unknownOption.err}`,
  )

  const argParserRefusal = run([...SJ, '--max-turns', '0', 'hi'])
  const argParserEnvelope = envelopeOf(argParserRefusal.out)
  check(
    'an argParser refusal (--max-turns 0) rides the refused outcome',
    argParserRefusal.status !== 0 && refusedWith(argParserEnvelope, 'positive integer'),
    `rc=${argParserRefusal.status} out=${argParserRefusal.out.slice(0, 100).replace(/\s+/g, ' ')}`,
  )

  const textControl = run(['run', '--config', '/no/such/settings-file.json', 'hi'])
  check(
    'the text format keeps its prose refusal (control: stderr, no stdout row)',
    textControl.status !== 0 &&
      textControl.err.includes('Settings file not found') &&
      envelopeOf(textControl.out) === null,
    `rc=${textControl.status} err=${textControl.err.slice(0, 80).replace(/\s+/g, ' ')}`,
  )

  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-preflight-envelope: all green' : `\nprove-preflight-envelope: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
