#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
process.chdir(realpathSync(mkdtempSync(join(tmpdir(), 'floors-windows-cd-'))))
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
const { readShellCommands } = await import(join(SRC, 'utils/wards/wardsShellRead.ts'))
const floors = await import(join(SRC, 'utils/permissions/shellProtectedPaths.ts'))

const readRefusal = (command: string, cwd = PROJECT, powershell = false): Promise<string | null> => floors.shellMercurySecretPath(command, powershell, cwd)
const runtimeRefusal = (command: string, cwd = PROJECT): Promise<string | null> => floors.shellSelfProtectionReason(command, false, cwd)
const storeRefusal = (command: string, cwd = PROJECT): Promise<string | null> => floors.shellCredentialWritePath(command, false, cwd)

console.log('============================================================')
console.log(' on Windows the floors follow a cd to an absolute path')
console.log('============================================================')

section('§1 the reading: the folder a cd leaves, with the reading told it stands on Windows')
{
  const world = { cwd: 'C:/src/fl110/project', home: 'C:/Users/operator', homesRoot: 'C:/Users', ownNames: [], windows: true }
  for (const [command, folder, why] of [
    ['cd C:/src/fl110/holder/.mercury && ls', 'C:/src/fl110/holder/.mercury', 'a drive path with forward slashes'],
    ["cd 'C:\\src\\fl110\\holder\\.mercury' && ls", 'C:/src/fl110/holder/.mercury', 'the same with backslashes, quoted'],
    ['cd c:/src/fl110/holder/.mercury && ls', 'c:/src/fl110/holder/.mercury', 'the drive letter in lower case'],
    ['cd /c/src/fl110/holder/.mercury && ls', 'c:/src/fl110/holder/.mercury', 'the Git Bash and MSYS form'],
    ['cd /mnt/c/src/fl110/holder && ls', 'c:/src/fl110/holder', 'the mounted form'],
    ["cd '\\\\?\\C:\\src\\fl110\\holder' && ls", 'C:/src/fl110/holder', 'the long-path prefix in front'],
    ['pushd C:/src/fl110/holder/.mercury && ls', 'C:/src/fl110/holder/.mercury', 'pushd'],
    ['cd C:/src/fl110/holder && cd .mercury && ls', 'C:/src/fl110/holder/.mercury', 'an absolute cd, then a relative one'],
    ["cd /d 'C:\\src\\fl110\\holder' && ls", 'C:/src/fl110/holder', 'the drive switch in front of the path'],
    ['cd ~/.ssh && ls', 'C:/Users/operator/.ssh', 'the home by its tilde'],
    ['cd ../holder/.mercury && ls', 'C:/src/fl110/holder/.mercury', 'a relative cd, as before'],
    ['cd /tmp && ls', '/tmp', 'a rooted path that names no drive, as before'],
  ] as const) {
    const read = await readShellCommands(command, 'posix', world)
    const left = read.commands.at(-1)?.cwd
    check(`${JSON.stringify(command)} (${why}) · the next command stands in ${folder}`, left === folder, String(left))
  }
  const shell = await readShellCommands('Set-Location C:\\src\\fl110\\holder\\.mercury; Get-ChildItem', 'powershell', world)
  check('PowerShell · Set-Location to a drive path · the next command stands there', shell.commands.at(-1)?.cwd === 'C:/src/fl110/holder/.mercury', String(shell.commands.at(-1)?.cwd))
  const posix = { cwd: '/work/project', home: '/home/operator', homesRoot: '/home', ownNames: [] }
  const named = await readShellCommands('cd C:/src && ls', 'posix', posix)
  check('off Windows a drive spelling is a relative name, as before', named.commands.at(-1)?.cwd === '/work/project/C:/src', String(named.commands.at(-1)?.cwd))
  const rooted = await readShellCommands('cd /c/src && ls', 'posix', posix)
  check('off Windows /c/src is the rooted path it spells, as before', rooted.commands.at(-1)?.cwd === '/c/src', String(rooted.commands.at(-1)?.cwd))
}

section('§2 the credential read floor after a cd into the store by an absolute path')
for (const [command, why] of [
  ['cd C:/src/fl110/holder/.mercury && cat $(ls -a)', 'the line the box ran: a listing handed to a reader'],
  ['cd /c/src/fl110/holder/.mercury && cat $(ls -a)', 'the Git Bash form'],
  ['cd C:/src/fl110/holder/.mercury && cat .credentials.json', 'the file by its name'],
  ['cd C:/src/fl110/holder/.mercury && cat .cred*', 'a wildcard'],
  ["cd 'C:\\src\\fl110\\holder\\.mercury' && cat mcp-auth.json", 'backslashes, quoted'],
  ['cd c:/SRC/fl110/holder/.mercury && cat .credentials.json', 'another case'],
  ['pushd C:/src/fl110/holder/.mercury && cat .credentials.json', 'pushd'],
  ["cd '\\\\?\\C:\\src\\fl110\\holder\\.mercury' && cat .credentials.json", 'the long-path prefix in front'],
  ['cd C:/src/fl110/holder && cd .mercury && cat .credentials.json', 'an absolute cd, then a relative one'],
  ['cd C:/src/fl110/holder && cat .mercury/.credentials.json', 'the folder above, then the file through the store'],
  ['cd "$(echo C:/src/fl110/holder/.mercury)" && cat .credentials.json', 'the path echoed'],
] as const) {
  const refusal = await readRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused as a read of the credentials`, refusal !== null, 'not refused')
}
{
  const relative = await readRefusal('cd .mercury && cat $(ls -a)', HOLDER)
  check('"cd .mercury && cat $(ls -a)" from the folder that holds the store (a relative cd) · refused', relative !== null, 'not refused')
  const shell = await readRefusal('Set-Location C:\\src\\fl110\\holder\\.mercury; Get-Content .credentials.json', PROJECT, true)
  check('PowerShell · Set-Location to the store, then Get-Content of the file by its name · refused', shell !== null, 'not refused')
  const spelled = await readRefusal('cat C:/src/fl110/holder/.mercury/.credentials.json')
  check('control · the file spelled absolutely · refused', spelled !== null, 'not refused')
}

section('§3 the runtime floor after the same cd')
for (const [command, why] of [
  ['cd C:/src/fl110/holder/.mercury && rm -rf runtime', 'the runtime by its name'],
  ['cd /c/src/fl110/holder/.mercury/runtime && rm -rf current', 'the Git Bash form, a folder deeper'],
  ["cd 'C:\\src\\fl110\\holder\\.mercury' && rm -rf runtime", 'backslashes, quoted'],
] as const) {
  const refusal = await runtimeRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused`, refusal !== null, 'not refused')
}

section('§4 the credential store floor after a cd into a store by an absolute path')
for (const [command, why] of [
  ['cd C:/Users/operator/.ssh && echo x >> authorized_keys', 'a drive path'],
  ['cd /c/Users/operator/.ssh && echo x >> authorized_keys', 'the Git Bash form'],
  ['cd ~/.ssh && echo x >> authorized_keys', 'the home by its tilde'],
] as const) {
  const refusal = await storeRefusal(command)
  check(`${JSON.stringify(command)} (${why}) · refused`, refusal !== null, 'not refused')
}

section('§5 what stays clear')
for (const [command, why] of [
  ['cd C:/src/fl110/project/docs && cat notes.md', 'a folder of the project'],
  ['cd C:/src/fl110/holder && cat notes.txt', 'the folder that holds the store, a plain file'],
  ['cd C:/src/fl110/holder && cat "$FILE"', 'the folder that holds the store, a file no reading can value'],
  ['cd C:/src/fl110/holder/.mercury && echo $$', 'in the store, a program that reads no file'],
  ['cd C:/src/fl110/holder/.mercury && ls', 'in the store, a listing'],
  ['cd D:/work && rm -rf build', 'another drive'],
  ['cd C:/src/fl110/project/docs; cat notes.md', 'a cd joined by no &&, its folder not standing on the machine that judges'],
  ['cd D:/work; rm -rf build', 'the same on another drive'],
  ['cd C:/Users/operator/Documents && echo x >> notes.txt', 'a folder of the home that is no store'],
] as const) {
  const refusals = [await readRefusal(command), await runtimeRefusal(command), await storeRefusal(command)]
  check(`${JSON.stringify(command)} (${why}) · refused by none of the three floors`, refusals.every(refusal => refusal === null), refusals.map(String).join(' · '))
}

Object.defineProperty(process, 'platform', descriptor)
getPlatform.cache.delete(undefined)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ floors follow a Windows cd: ${checks} checks, 0 failures` : ` ❌ floors follow a Windows cd: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
