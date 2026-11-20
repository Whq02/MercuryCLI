#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
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

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'floors-file-url-')))
process.chdir(SCRATCH)
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
const HOLDER = 'C:\\src\\fl110\\holder'
const STORE = `${HOLDER}\\.mercury`
const PROJECT = 'C:\\src\\fl110\\project'
process.env.HOME = process.env.USERPROFILE = 'C:\\Users\\operator'
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_DAEMON_DIR = `${STORE}\\daemon`
for (const key of ['MERCURY_HOME', 'MERCURY_WARDS', 'MERCURY_SPAWNED_BY', 'MERCURY_SKIP_PERMISSIONS']) delete process.env[key]

const { getPlatform } = await import(join(SRC, 'utils/platform.ts'))
getPlatform.cache.set(undefined, 'windows')
const floors = await import(join(SRC, 'utils/permissions/shellProtectedPaths.ts'))

const readRefusal = (command: string): Promise<string | null> => floors.shellMercurySecretPath(command, false, PROJECT)

console.log('============================================================')
console.log(' on Windows the credential read floor reads a file: URL that names a drive path')
console.log('============================================================')

const SLASHED = 'C:/src/fl110/holder/.mercury/.credentials.json'
const BACKSLASHED = 'C:\\src\\fl110\\holder\\.mercury\\.credentials.json'
const ENCODED = 'C:/src/fl110/holder/%2Emercury/%2Ecredentials.json'
const FORMS = [
  ['file://', 'two slashes, the drive where a host stands'],
  ['file:///', 'three slashes'],
  ['file://localhost/', 'the host localhost'],
] as const

section('§1 the store read out through a file: URL, the drive path with forward slashes')
for (const [head, why] of FORMS) {
  const command = `curl ${head}${SLASHED}`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§2 the same with backslashes, quoted')
for (const [head, why] of FORMS) {
  const command = `curl '${head}${BACKSLASHED}'`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§3 the same with %2E for a dot')
for (const [head, why] of FORMS) {
  const command = `curl ${head}${ENCODED}`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§4 controls')
{
  const spelled = await readRefusal(`cat ${SLASHED}`)
  check('the file spelled as a drive path, no URL · refused', spelled !== null, 'not refused')
  const clear = await readRefusal('curl file://C:/src/fl110/project/notes.txt')
  check('"curl file://C:/src/fl110/project/notes.txt" (a file of the project) · not refused', clear === null, String(clear))
}

Object.defineProperty(process, 'platform', descriptor)
getPlatform.cache.delete(undefined)
removeScratch(SCRATCH)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ floors read a file: URL on Windows: ${checks} checks, 0 failures` : ` ❌ floors read a file: URL on Windows: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
