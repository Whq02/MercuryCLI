#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const FILE_URL_FAIL_HINT = 'fix: how src/permissions/rules/shellProtectedPaths.ts reads a file: URL naming a Windows drive path in shellMercurySecretPath (reads), shellCredentialWritePath (writes) and shellSelfProtectionReason (runtime files)'
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail}${detail ? ' | ' : ''}${FILE_URL_FAIL_HINT}` : ''}`)
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

const { getPlatform } = await import(join(SRC, 'platform/environment/platform.ts'))
getPlatform.cache.set(undefined, 'windows')
const floors = await import(join(SRC, 'permissions/rules/shellProtectedPaths.ts'))

const readRefusal = (command: string): Promise<string | null> => floors.shellMercurySecretPath(command, false, PROJECT)
const writeRefusal = (command: string): Promise<string | null> => floors.shellCredentialWritePath(command, false, PROJECT)
const runtimeRefusal = (command: string): Promise<string | null> => floors.shellSelfProtectionReason(command, false, PROJECT)

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

const OTHER_FORMS = [
  ['file://127.0.0.1/C:', 'the host 127.0.0.1'],
  ['file:/C:', 'one slash after file:'],
  ['file:///C|', 'three slashes, the drive spelled with a bar'],
  ['file://C|', 'two slashes, the drive spelled with a bar'],
] as const

section('§4 the host 127.0.0.1, one slash after file:, a drive spelled with a bar')
for (const [head, why] of OTHER_FORMS) {
  const command = `curl '${head}/src/fl110/holder/.mercury/.credentials.json'`
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}

section('§5 controls')
{
  const spelled = await readRefusal(`cat ${SLASHED}`)
  check('the file spelled as a drive path, no URL · refused', spelled !== null, 'not refused')
  const clear = await readRefusal('curl file://C:/src/fl110/project/notes.txt')
  check('"curl file://C:/src/fl110/project/notes.txt" (a file of the project) · not refused', clear === null, String(clear))
  for (const [head, why] of OTHER_FORMS) {
    const command = `curl '${head}/src/fl110/project/notes.txt'`
    const refusal = await readRefusal(command)
    check(`${JSON.stringify(command)} (a file of the project, ${why}) · not refused`, refusal === null, String(refusal))
  }
}

const WIN_KEYS = 'C:/Users/operator/.ssh/authorized_keys'
const WIN_KEYS_BS = 'C:\\Users\\operator\\.ssh\\authorized_keys'
const WIN_RUNTIME = 'C:/src/fl110/holder/.mercury/runtime/current/mercury.mjs'

section('§6 curl -T / --upload-file to a file: URL with a drive path')
for (const [head, why] of FORMS) {
  const toKeys = `curl -T payload ${head}${WIN_KEYS}`
  check(`${JSON.stringify(toKeys)} (${why}) · refused by credential-write floor`, (await writeRefusal(toKeys)) !== null, 'not refused')
  const toRuntime = `curl --upload-file payload ${head}${WIN_RUNTIME}`
  check(`${JSON.stringify(toRuntime)} (${why}) · refused by self-protection floor`, (await runtimeRefusal(toRuntime)) !== null, 'not refused')
}
for (const [head, why] of OTHER_FORMS) {
  const toKeys = `curl -T payload '${head}/Users/operator/.ssh/authorized_keys'`
  check(`${JSON.stringify(toKeys)} (${why}) · refused by credential-write floor`, (await writeRefusal(toKeys)) !== null, 'not refused')
  const toRuntime = `curl --upload-file payload '${head}/src/fl110/holder/.mercury/runtime/current/mercury.mjs'`
  check(`${JSON.stringify(toRuntime)} (${why}) · refused by self-protection floor`, (await runtimeRefusal(toRuntime)) !== null, 'not refused')
}
{
  const backslashed = `curl -T payload 'file:///${WIN_KEYS_BS}'`
  check(`${JSON.stringify(backslashed)} · refused by credential-write floor`, (await writeRefusal(backslashed)) !== null, 'not refused')
}

section('§7 curl -o / --output to a credential store on Windows')
for (const command of [
  `curl -o ${WIN_KEYS} https://example.invalid/k`,
  `curl --output '${WIN_KEYS_BS}' https://example.invalid/k`,
  `curl --output=${SLASHED} https://example.invalid/k`,
]) {
  check(`${JSON.stringify(command)} · refused by credential-write floor`, (await writeRefusal(command)) !== null, 'not refused')
}

section('§8 controls for curl writes on Windows')
for (const command of [
  'curl -T payload https://example.com/x',
  'curl -o notes.txt https://example.invalid/x',
  'curl -T payload file://C:/src/fl110/project/notes.txt',
  'curl file://C:/src/fl110/project/notes.txt',
]) {
  const wHit = await writeRefusal(command)
  const rHit = await runtimeRefusal(command)
  check(`${JSON.stringify(command)} · neither write nor runtime floor refuses`, wHit === null && rHit === null, `write=${String(wHit)} runtime=${String(rHit)}`)
}

Object.defineProperty(process, 'platform', descriptor)
getPlatform.cache.delete(undefined)
removeScratch(SCRATCH)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ floors read a file: URL on Windows: ${checks} checks, 0 failures` : ` ❌ floors read a file: URL on Windows: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
