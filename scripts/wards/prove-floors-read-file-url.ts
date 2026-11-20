#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the credential read floor reads every file: URL form curl reads')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] not read on Windows: the store stands at a rooted path here; scripts/wards/prove-floors-read-file-url-on-windows.ts reads the drive forms')
  process.exit(0)
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'floors-file-url-')))
const STORE = join(SCRATCH, 'holder', '.mercury')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(STORE, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_DAEMON_DIR = join(STORE, 'daemon')
for (const key of ['MERCURY_HOME', 'MERCURY_WARDS', 'MERCURY_SPAWNED_BY', 'MERCURY_SKIP_PERMISSIONS']) delete process.env[key]

const floors = await import(join(SRC, 'utils/permissions/shellProtectedPaths.ts'))

const readRefusal = (command: string): Promise<string | null> => floors.shellMercurySecretPath(command, false, PROJECT)
const shown = (text: string): string => text.replaceAll(SCRATCH, '<scratch>')

const FILE = `${STORE}/.credentials.json`
const ENCODED = `${STORE}/%2Ecredentials.json`
const NOTES = `${PROJECT}/notes.txt`
const FORMS = [
  ['file://', 'three slashes'],
  ['file://localhost', 'the host localhost'],
  ['file://127.0.0.1', 'the host 127.0.0.1'],
  ['file:', 'one slash after file:'],
] as const

section('§1 the store read out through a file: URL')
for (const [head, why] of FORMS) {
  const command = `curl ${head}${FILE}`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(shown(command))} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§2 the same with %2E for a dot')
for (const [head, why] of FORMS) {
  const command = `curl ${head}${ENCODED}`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(shown(command))} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§3 a file that is no store, by the same forms')
for (const [head, why] of FORMS) {
  const command = `curl ${head}${NOTES}`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(shown(command))} (${why}) · not refused`, refusal === null, String(refusal))
}

removeScratch(SCRATCH)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ floors read a file: URL: ${checks} checks, 0 failures` : ` ❌ floors read a file: URL: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
