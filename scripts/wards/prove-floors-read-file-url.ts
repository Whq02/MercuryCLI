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
const HOLDER = join(SCRATCH, 'holder')
const STORE = join(HOLDER, '.mercury')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(STORE, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
process.env.HOME = HOLDER
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_DAEMON_DIR = join(STORE, 'daemon')
for (const key of ['MERCURY_HOME', 'MERCURY_WARDS', 'MERCURY_SPAWNED_BY', 'MERCURY_SKIP_PERMISSIONS']) delete process.env[key]

const floors = await import(join(SRC, 'permissions/rules/shellProtectedPaths.ts'))

const readRefusal = (command: string): Promise<string | null> => floors.shellMercurySecretPath(command, false, PROJECT)
const writeRefusal = (command: string): Promise<string | null> => floors.shellCredentialWritePath(command, false, PROJECT)
const runtimeRefusal = (command: string): Promise<string | null> => floors.shellSelfProtectionReason(command, false, PROJECT)
const shown = (text: string): string => text.replaceAll(SCRATCH, '<scratch>')

const FILE = `${STORE}/.credentials.json`
const ENCODED = `${STORE}/%2Ecredentials.json`
const SSH_DIR = `${HOLDER}/.ssh`
const AUTH_KEYS = `${SSH_DIR}/authorized_keys`
const ENCODED_AUTH_KEYS = `${HOLDER}/%2Essh/authorized_keys`
const RUNTIME = `${STORE}/runtime/current/mercury.mjs`
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

section('§4 curl -T / --upload-file to a file: URL writes the local path')
for (const [head, why] of FORMS) {
  const toKeys = `curl -T payload ${head}${AUTH_KEYS}`
  const keysHit = await writeRefusal(toKeys)
  check(`${JSON.stringify(shown(toKeys))} (${why}) · refused by credential-write floor`, keysHit !== null, 'not refused')

  const toRuntime = `curl --upload-file payload ${head}${RUNTIME}`
  const runtimeHit = await runtimeRefusal(toRuntime)
  check(`${JSON.stringify(shown(toRuntime))} (${why}) · refused by self-protection floor`, runtimeHit !== null, 'not refused')
}
{
  const toStore = `curl --upload-file=payload file://${FILE}`
  check(`${JSON.stringify(shown(toStore))} · refused by credential-write floor`, (await writeRefusal(toStore)) !== null, 'not refused')
  const encoded = `curl -T payload file://${ENCODED_AUTH_KEYS}`
  check(`${JSON.stringify(shown(encoded))} · refused by credential-write floor`, (await writeRefusal(encoded)) !== null, 'not refused')
  const fused = `curl -sTpayload file://${AUTH_KEYS}`
  check(`${JSON.stringify(shown(fused))} · refused by credential-write floor`, (await writeRefusal(fused)) !== null, 'not refused')
  const urlFlag = `curl -T payload --url file://${RUNTIME}`
  check(`${JSON.stringify(shown(urlFlag))} · refused by self-protection floor`, (await runtimeRefusal(urlFlag)) !== null, 'not refused')
}

section('§5 curl -o / --output to a credential store')
for (const command of [
  `curl -o ${AUTH_KEYS} https://example.invalid/k`,
  `curl --output ${AUTH_KEYS} https://example.invalid/k`,
  `curl --output=${FILE} https://example.invalid/k`,
  `curl -o${AUTH_KEYS} https://example.invalid/k`,
  `curl -fsSo ${AUTH_KEYS} https://example.invalid/k`,
  `curl --output-dir ${SSH_DIR} -O https://example.invalid/k`,
]) {
  const hit = await writeRefusal(command)
  check(`${JSON.stringify(shown(command))} · refused by credential-write floor`, hit !== null, 'not refused')
}

section('§6 controls for curl writes that stay unanswered')
for (const command of [
  'curl -T payload https://example.com/x',
  'curl -o notes.txt https://example.invalid/x',
  `curl file://${NOTES}`,
  `curl -T payload file://${NOTES}`,
  `curl -XPOST file://${AUTH_KEYS}`,
]) {
  const wHit = await writeRefusal(command)
  const rHit = await runtimeRefusal(command)
  check(`${JSON.stringify(shown(command))} · neither write nor runtime floor refuses`, wHit === null && rHit === null, `write=${String(wHit)} runtime=${String(rHit)}`)
}

removeScratch(SCRATCH)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ floors read a file: URL: ${checks} checks, 0 failures` : ` ❌ floors read a file: URL: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
