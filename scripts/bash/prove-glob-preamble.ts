#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveBashPackDir } from '../../src/platform/shell/bashPack.js'
import { createBashShellProvider } from '../../src/platform/shell/bashProvider.js'
import { getGlobPreambleCommand } from '../../src/platform/shell/globPreamble.js'
import { systemShellAt } from '../../src/platform/shell/shellRecord.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  const failureHint = 'to fix, change getGlobPreambleCommand in src/platform/shell/globPreamble.ts (the preamble text per shell origin) or buildExecCommand in src/platform/shell/bashProvider.ts (where the preamble is placed); the check that no bash stands needs the bundled bash pack from resolveBashPackDir in src/platform/shell/bashPack.ts or /bin/bash on this host'
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? ` — ${detail}` : '') : ` — ${detail ? `${detail}; ` : ''}${failureHint}`}`)
  if (!ok) failures = 1
}

const UNMATCHED = `/tmp/__no_such_dir_${process.pid}/*.yml`
const run = (shell: string, flags: string[], cmd: string) => spawnSync(shell, [...flags, '-c', cmd], { encoding: 'utf8' })

const hadPrefix = process.env.MERCURY_SHELL_PREFIX
delete process.env.MERCURY_SHELL_PREFIX

console.log('— the preamble, by where the shell came from —')
const shippedPre = getGlobPreambleCommand('shipped')
const systemPre = getGlobPreambleCommand('system')
t('the shipped bash takes the bash preamble, byte for byte as the bash branch stood', shippedPre === 'shopt -u extglob 2>/dev/null || true', String(shippedPre))
t('the system bash takes the same', systemPre === shippedPre, String(systemPre))
t('the engine takes none', getGlobPreambleCommand('engine') === null)
process.env.MERCURY_SHELL_PREFIX = 'env'
const prefixPre = getGlobPreambleCommand('engine')
delete process.env.MERCURY_SHELL_PREFIX
t('under a shell prefix every origin takes the bash preamble, and no option of another shell is named', prefixPre === shippedPre && !String(prefixPre).includes('setopt'), String(prefixPre))

console.log('— behaviour: real shells, a glob that matches nothing, extglob switched on before —')
const pack = resolveBashPackDir()
const shells: Array<[string, string]> = [
  ...(pack.state === 'ok' ? [[`the shipped bash ${pack.manifest.bashVersion}`, pack.binaryPath] as [string, string]] : []),
  ...(existsSync('/bin/bash') ? [['the system bash at /bin/bash', '/bin/bash'] as [string, string]] : []),
]
t('a bash stands under this proof', shells.length > 0, pack.state === 'ok' ? '' : pack.note)
for (const [name, shell] of shells) {
  const glob = run(shell, [], `${shippedPre} && echo ${UNMATCHED}`)
  t(`${name} + preamble: the unmatched glob passes through literally, exit 0`, glob.status === 0 && glob.stdout.includes('__no_such_dir_'), `status=${glob.status} stderr=${glob.stderr.trim()}`)
  const control = run(shell, ['-O', 'extglob'], 'shopt -q extglob; echo "extglob=$?"')
  t(`CONTROL: ${name} started with extglob on reads it on`, control.stdout.trim() === 'extglob=0', control.stdout.trim())
  const off = run(shell, ['-O', 'extglob'], `${shippedPre} && { shopt -q extglob; echo "extglob=$?"; }`)
  t(`${name} + preamble: extglob reads off, whatever the shell was started with`, off.stdout.trim() === 'extglob=1', off.stdout.trim())
}

console.log('— wiring: the provider composes this preamble for the shell its record names —')
{
  const provider = await createBashShellProvider(systemShellAt('/bin/bash'), { skipSnapshot: true })
  const built = await provider.buildExecCommand('echo wired', { id: 'glob-preamble-proof' })
  const at = built.commandString.indexOf(String(shippedPre))
  t('the command a system bash is handed carries the preamble before the eval of the command', at >= 0 && at < built.commandString.indexOf('eval '), built.commandString.slice(0, 160))
  t('…and names no option of another shell', !built.commandString.includes('setopt') && !built.commandString.includes('pipestatus'), built.commandString.slice(0, 160))
}

if (hadPrefix !== undefined) process.env.MERCURY_SHELL_PREFIX = hadPrefix
console.log(failures ? '\n❌ GLOB-PREAMBLE RED' : '\n✅ GLOB-PREAMBLE GREEN')
process.exit(failures)
