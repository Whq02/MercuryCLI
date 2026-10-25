#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'ps-dash-flags-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

const { isAllowlistedCommand } = await import('../../src/tools/PowerShellTool/readOnlyValidation.js')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const DASHES: Array<[string, string]> = [['-', 'ASCII hyphen'], ['\u2013', 'en dash'], ['\u2014', 'em dash'], ['\u2015', 'horizontal bar']]
const isDashed = (arg: string): boolean => /^[-\u2013\u2014\u2015]/.test(arg)
const readsOnly = (command: string): boolean => {
  const [name, ...args] = command.split(' ')
  return isAllowlistedCommand(
    { name: name as string, text: command, nameType: 'unknown', args, elementTypes: args.map(arg => (isDashed(arg) ? 'Parameter' : 'StringConstant')), elementType: 'CommandAst' } as never,
    command,
  )
}

console.log('1. a safe flag reads the same under every dash')
for (const [dash, label] of DASHES) {
  check(`Get-Content ${dash}Raw notes.txt is read-only (${label})`, readsOnly(`Get-Content ${dash}Raw notes.txt`) === true)
  check(`Get-Content ${dash}Tail 20 notes.txt is read-only (${label})`, readsOnly(`Get-Content ${dash}Tail 20 notes.txt`) === true)
  check(`Get-Content ${dash}Tail:20 notes.txt — the colon cut still finds the flag (${label})`, readsOnly(`Get-Content ${dash}Tail:20 notes.txt`) === true)
  check(`Get-Content ${dash}Verbose notes.txt — a common parameter is skipped (${label})`, readsOnly(`Get-Content ${dash}Verbose notes.txt`) === true)
}

console.log('2. an unlisted flag refuses under every dash — the dash never widens the read')
for (const [dash, label] of DASHES) {
  check(`Get-Content ${dash}Wait notes.txt asks (${label})`, readsOnly(`Get-Content ${dash}Wait notes.txt`) === false)
  check(`Get-ChildItem ${dash}Recurse ${dash}Force . — one unlisted flag spoils the pair (${label})`, readsOnly(`Get-ChildItem ${dash}Recurse ${dash}NoSuchFlag .`) === false)
}

console.log('3. the verdict is identical across the four spellings for a corpus of commands')
const CORPUS = ['Get-Content -Raw a.txt', 'Get-Content -Wait a.txt', 'Get-ChildItem -Recurse src', 'Get-ChildItem -Bogus src', 'Select-String -Pattern todo -Path a.txt', 'Get-Item -Path a.txt -Force']
for (const ascii of CORPUS) {
  const expected = readsOnly(ascii)
  for (const [dash, label] of DASHES.slice(1)) {
    const spelled = ascii.replaceAll(' -', ` ${dash}`)
    check(`${JSON.stringify(spelled)} reads ${expected} like its ASCII twin (${label})`, readsOnly(spelled) === expected)
  }
}

console.log(failures === 0 ? '\nPOWERSHELL DASH FLAGS: ALL PASS' : `\nPOWERSHELL DASH FLAGS: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
