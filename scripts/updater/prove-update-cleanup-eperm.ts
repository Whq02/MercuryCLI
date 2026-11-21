#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LayoutRoots, SweepReport } from '../../src/services/privateChannel/installLayout.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'update-cleanup-eperm-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_VERSIONS_DIR
delete process.env.MERCURY_UPDATE_FAULT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { installPayload, sweepUpdaterResidue } = await import('../../src/services/privateChannel/installLayout.ts')

const IS_WINDOWS = process.platform === 'win32'
const DEAD = 4242421

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')
const describe = (value: unknown): string => (value instanceof Error ? value.message.slice(0, 160) : String(JSON.stringify(value)).slice(0, 240))

const realKill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === DEAD && signal === 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  return realKill(pid, signal as NodeJS.Signals)
}) as typeof process.kill

const rootsFor = (name: string): LayoutRoots => {
  const base = join(SCRATCH, name)
  mkdirSync(join(base, 'versions'), { recursive: true })
  return {
    versionsDir: join(base, 'versions'),
    binDir: join(base, 'bin'),
    shimPath: join(base, 'bin', IS_WINDOWS ? 'mercury.cmd' : 'mercury'),
    isWindows: IS_WINDOWS,
  }
}

const makePayload = (name: string, version: string, marker: string): string => {
  const dir = join(SCRATCH, 'payloads', name)
  mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ version })}\n`)
  writeFileSync(join(dir, 'mercury.mjs'), `console.log('Mercury ${version} ${marker}')\n`)
  writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexec node "$(dirname "$0")/mercury.mjs" "$@"\n')
  return dir
}

interface InUse {
  running: boolean
  release: () => Promise<void>
}

const SYSTEM_PING = join(process.env.SystemRoot ?? process.env.windir ?? '', 'System32', 'PING.EXE')

async function holdInUse(dir: string): Promise<InUse> {
  const nodeDir = join(dir, 'vendor', 'node')
  mkdirSync(nodeDir, { recursive: true })
  if (!IS_WINDOWS) {
    const file = join(nodeDir, 'node')
    writeFileSync(file, 'in use\n')
    const fd = openSync(file, 'r')
    return { running: true, release: async () => closeSync(fd) }
  }
  const program = existsSync(SYSTEM_PING)
    ? { source: SYSTEM_PING, args: ['-n', '60', '127.0.0.1'] }
    : { source: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] }
  const exe = join(nodeDir, 'node.exe')
  copyFileSync(program.source, exe)
  const child = spawn(exe, program.args, { stdio: 'ignore', windowsHide: true })
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  await new Promise(resolve => setTimeout(resolve, 300))
  return {
    running: child.pid !== undefined && child.exitCode === null && child.signalCode === null,
    release: async () => {
      child.kill()
      await exited
    },
  }
}

const sweep = (roots: LayoutRoots): { report: SweepReport | null; thrown: unknown } => {
  try {
    return { report: sweepUpdaterResidue(roots), thrown: null }
  } catch (error) {
    return { report: null, thrown: error }
  }
}

console.log('============================================================')
console.log(' the update cleanup deletes against a copy still in use')
console.log('============================================================')

console.log('§1 with nothing in use, the cleanup removes what it always removed')
{
  const roots = rootsFor('free')
  const version = '9.9.4-beta.1'
  installPayload(roots, makePayload('free-1', version, 'first'), version)
  const out = installPayload(roots, makePayload('free-2', version, 'second'), version)
  const parked = join(roots.versionsDir, `.replaced-${version}-${process.pid}`)
  check(
    'a same-version reinstall with new bytes reports installed, promotes them and removes the displaced copy',
    out.state === 'installed' && out.changed === true && !existsSync(parked) && read(join(roots.versionsDir, version, 'mercury.mjs')).includes('second'),
    describe(out),
  )
  const residue = `.download-${DEAD}`
  mkdirSync(join(roots.versionsDir, residue), { recursive: true })
  writeFileSync(join(roots.versionsDir, residue, 'partial'), 'bytes')
  const { report, thrown } = sweep(roots)
  check(
    'the sweep removes a dead updater\'s residue and reports it',
    thrown === null && report !== null && report.removed.includes(residue) && !existsSync(join(roots.versionsDir, residue)),
    describe(thrown ?? report),
  )
}

console.log(
  IS_WINDOWS
    ? '§2 a program still runs from the copy: the cleanup keeps the verdict and leaves the copy for a later sweep'
    : '§2 an open file inside the copy never blocks a delete on POSIX: the cleanup removes it as it always has',
)
{
  const roots = rootsFor('in-use')
  const version = '9.9.4-beta.2'
  installPayload(roots, makePayload('in-use-1', version, 'first'), version)
  const holder = await holdInUse(join(roots.versionsDir, version))
  const out = installPayload(roots, makePayload('in-use-2', version, 'second'), version)
  const parked = join(roots.versionsDir, `.replaced-${version}-${process.pid}`)
  const promoted = read(join(roots.versionsDir, version, 'mercury.mjs')).includes('second')
  if (IS_WINDOWS) {
    check('a program runs from the installed version', holder.running)
    check('the promoted install reports installed, not failed, while its displaced copy cannot be deleted yet', out.state === 'installed' && out.changed === true, describe(out))
    check('the new bytes are the ones in the version directory', promoted)
    check('the displaced copy is left parked, the running program in it, for a later sweep', existsSync(join(parked, 'vendor', 'node', 'node.exe')))
  } else {
    check('the install reports installed, promotes the new bytes and removes the displaced copy', out.state === 'installed' && out.changed === true && promoted && !existsSync(parked), describe(out))
  }
  await holder.release()
}
{
  const roots = rootsFor('sweep-in-use')
  const version = '9.9.4-beta.3'
  mkdirSync(join(roots.versionsDir, version), { recursive: true })
  const before = `.download-${DEAD}`
  const stuck = `.replaced-${version}-${DEAD}`
  const after = `.staging-${version}-${DEAD}`
  for (const entry of [before, stuck, after]) {
    mkdirSync(join(roots.versionsDir, entry), { recursive: true })
    writeFileSync(join(roots.versionsDir, entry, 'partial'), 'bytes')
  }
  const holder = await holdInUse(join(roots.versionsDir, stuck))
  const { report, thrown } = sweep(roots)
  const gone = (entry: string): boolean => report !== null && report.removed.includes(entry) && !existsSync(join(roots.versionsDir, entry))
  if (IS_WINDOWS) {
    check('a program runs from a dead updater\'s parked copy', holder.running)
    check('the sweep returns instead of throwing out of the update', thrown === null, describe(thrown))
    check('the parked copy still in use is left in place and not reported removed', report !== null && !report.removed.includes(stuck) && existsSync(join(roots.versionsDir, stuck)), describe(report))
    check('the sweep goes on past it: the residue before and after it is removed and reported', gone(before) && gone(after), describe(report))
  } else {
    check('every dead residue is removed and reported, the one with an open file inside as well', thrown === null && gone(before) && gone(stuck) && gone(after), describe(thrown ?? report))
  }
  await holder.release()
  if (IS_WINDOWS) {
    const next = sweep(roots)
    check(
      'once the program has gone, the next sweep removes the parked copy',
      next.report !== null && next.report.removed.includes(stuck) && !existsSync(join(roots.versionsDir, stuck)),
      describe(next.thrown ?? next.report),
    )
  }
}

if (IS_WINDOWS) {
  console.log('§3 the cleanup deletes take the bounded Win32 retry, then leave what still will not go (an EPERM injected at the delete)')
  {
    const roots = rootsFor('fault-displaced')
    const version = '9.9.4-beta.4'
    installPayload(roots, makePayload('fault-displaced-1', version, 'first'), version)
    process.env.MERCURY_UPDATE_FAULT = 'displaced-rm'
    const out = installPayload(roots, makePayload('fault-displaced-2', version, 'second'), version)
    delete process.env.MERCURY_UPDATE_FAULT
    check(
      'an EPERM that never clears on the displaced copy keeps the installed verdict and parks the copy',
      out.state === 'installed' && existsSync(join(roots.versionsDir, `.replaced-${version}-${process.pid}`)),
      describe(out),
    )
  }
  {
    const roots = rootsFor('fault-heal')
    const version = '9.9.4-beta.5'
    installPayload(roots, makePayload('fault-heal-1', version, 'first'), version)
    process.env.MERCURY_UPDATE_FAULT = 'displaced-rm:2'
    const out = installPayload(roots, makePayload('fault-heal-2', version, 'second'), version)
    delete process.env.MERCURY_UPDATE_FAULT
    check(
      'EPERM twice, then clear: the bounded retry removes the displaced copy',
      out.state === 'installed' && !existsSync(join(roots.versionsDir, `.replaced-${version}-${process.pid}`)),
      describe(out),
    )
  }
  {
    const roots = rootsFor('fault-sweep')
    const residue = `.download-${DEAD}`
    mkdirSync(join(roots.versionsDir, residue), { recursive: true })
    process.env.MERCURY_UPDATE_FAULT = 'sweep-rm'
    const { report, thrown } = sweep(roots)
    delete process.env.MERCURY_UPDATE_FAULT
    check(
      'an EPERM that never clears on a residue leaves it for the next sweep, unreported, without throwing',
      thrown === null && report !== null && !report.removed.includes(residue) && existsSync(join(roots.versionsDir, residue)),
      describe(thrown ?? report),
    )
  }
}

process.kill = realKill as typeof process.kill
try {
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(`\nprove-update-cleanup-eperm: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
