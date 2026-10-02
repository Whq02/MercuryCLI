#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mdm-locations-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const MERCURY_DOMAIN = 'com.mercury.harness'
const MERCURY_HKLM = 'HKLM\\SOFTWARE\\Policies\\Mercury'
const MERCURY_HKCU = 'HKCU\\SOFTWARE\\Policies\\Mercury'
const POLICY = '    Settings    REG_SZ    {"guardrails":{"deny":["Bash(rm *)"]}}'

const queried: string[][] = []
let answers: (args: string[]) => string | null = () => null
const childProcess = await import('node:child_process')
mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void): void => {
    queried.push([command, ...args])
    const stdout = answers(args)
    setTimeout(() => (stdout === null ? callback(new Error('not found'), '') : callback(null, stdout)), 0)
  },
}))

const constants = await import('../../src/utils/settings/mdm/constants.js')
const raw = await import('../../src/utils/settings/mdm/rawRead.js')

section('§1 macOS: the managed-preferences candidates are the Mercury domain alone, per-user before device')
{
  const paths = constants.getMacOSPlistPaths()
  check('every candidate plist carries the Mercury domain', paths.length >= 1 && paths.every(p => p.path.endsWith(`/${MERCURY_DOMAIN}.plist`) && p.label.includes(MERCURY_DOMAIN)), JSON.stringify(paths))
  check('one per tier: the per-user plist (when the user is known) and the device plist, nothing else', paths.length <= 2 && paths[paths.length - 1]!.path === `/Library/Managed Preferences/${MERCURY_DOMAIN}.plist`, JSON.stringify(paths))
  const exported = Object.keys(constants).sort()
  check('the module exports one preference domain and two registry key paths', exported.filter(name => /DOMAIN$/.test(name)).join(',') === 'MACOS_PREFERENCE_DOMAIN' && exported.filter(name => /REGISTRY_KEY_PATH/.test(name)).join(',') === 'WINDOWS_REGISTRY_KEY_PATH_HKCU,WINDOWS_REGISTRY_KEY_PATH_HKLM', exported.join(','))
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const onWindows = async <T,>(body: () => Promise<T>): Promise<T> => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    return await body()
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
}

section('§2 Windows: one registry query per hive, both at the Mercury key')
{
  queried.length = 0
  answers = () => null
  const result = await onWindows(() => raw.fireRawRead())
  const keys = queried.map(q => q[2] ?? '')
  check('exactly two reg queries fire', queried.length === 2 && queried.every(q => q[0] === 'reg' && q[1] === 'query'), JSON.stringify(queried))
  check('they name the Mercury HKLM and HKCU keys and the Settings value', keys.includes(MERCURY_HKLM) && keys.includes(MERCURY_HKCU) && queried.every(q => q[3] === '/v' && q[4] === 'Settings'), JSON.stringify(queried))
  check('no query names any other key path', keys.every(key => key === MERCURY_HKLM || key === MERCURY_HKCU), keys.join(' | '))
  check('with nothing stored, both hives read as absent', result.hklmStdout === null && result.hkcuStdout === null && result.plistStdouts === null, JSON.stringify(result))
}

section('§3 Windows: a value stored only at a key Mercury does not read is not read')
{
  queried.length = 0
  answers = args => (args.includes(MERCURY_HKLM) || args.includes(MERCURY_HKCU) ? null : POLICY)
  const result = await onWindows(() => raw.fireRawRead())
  check('a policy answered for every key except the Mercury ones reaches neither hive', result.hklmStdout === null && result.hkcuStdout === null, JSON.stringify(result))
  check('and the Mercury keys were the only ones asked', queried.every(q => q[2] === MERCURY_HKLM || q[2] === MERCURY_HKCU), JSON.stringify(queried))
}

section('§4 Windows: a value at the Mercury key is read, per hive')
{
  queried.length = 0
  answers = args => (args.includes(MERCURY_HKLM) ? POLICY : null)
  const hklm = await onWindows(() => raw.fireRawRead())
  check('HKLM answers and HKCU stays absent', hklm.hklmStdout === POLICY && hklm.hkcuStdout === null, JSON.stringify(hklm))
  answers = args => (args.includes(MERCURY_HKCU) ? POLICY : null)
  const hkcu = await onWindows(() => raw.fireRawRead())
  check('HKCU answers and HKLM stays absent', hkcu.hkcuStdout === POLICY && hkcu.hklmStdout === null, JSON.stringify(hkcu))
}

rmSync(home, { recursive: true, force: true })
console.log(`\nmdm locations: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
