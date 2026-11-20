#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn32-')))
const CFG = join(SCRATCH, 'cfg')
mkdirSync(CFG, { recursive: true })
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {}
})

process.env.MERCURY_CONFIG_DIR = CFG
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

{
  const { assessDeployedAssets } = await import('../../src/utils/healthDeployedAssets.ts')
  const label = 'healthDeployedAssets: unreadable deployed file throws instead of reporting drift'
  if (!POSIX_MODES) skip(label, 'needs non-root POSIX chmod')
  else {
    const repo = join(SCRATCH, 'hda-repo')
    const home = join(SCRATCH, 'hda-home')
    mkdirSync(join(repo, 'scripts', 'ops'), { recursive: true })
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(join(repo, 'scripts/ops/launcher-mercury.sh'), '#!/bin/sh\necho ok\n')
    const deployed = join(home, 'bin/mercury')
    writeFileSync(deployed, '#!/bin/sh\necho ok\n')
    chmodSync(deployed, 0o000)
    let threw: unknown = null
    try {
      assessDeployedAssets(repo, home)
    } catch (error) {
      threw = error
    } finally {
      chmodSync(deployed, 0o600)
    }
    check(label, threw !== null && (threw as NodeJS.ErrnoException).code === 'EACCES', String(threw))
  }
}

{
  const fsOps = await import('../../src/utils/fsOperations.ts')
  const { detectManagedSettingsWarnings, managedPolicyPath, managedPolicyPresent } = await import('../../src/utils/healthDiagnostic.ts')
  const real = fsOps.getFsImplementation()
  const policyPath = managedPolicyPath()
  try {
    fsOps.setFsImplementation({
      ...real,
      existsSync: ((p: string) => {
        if (p === policyPath) throw new Error('fs probe bug')
        return real.existsSync(p)
      }) as never,
    } as never)
    let threw: unknown = null
    try {
      managedPolicyPresent()
    } catch (error) {
      threw = error
    }
    check('healthDiagnostic: managedPolicyPresent lets unexpected fs error throw instead of returning false', threw instanceof Error && threw.message === 'fs probe bug', String(threw))

    fsOps.setFsImplementation({
      ...real,
      readFileSync: ((p: string, opts?: unknown) => (p === policyPath ? '{bad json' : (real.readFileSync as (a: string, b?: unknown) => unknown)(p, opts))) as never,
    } as never)
    let parseThrew: unknown = null
    try {
      detectManagedSettingsWarnings()
    } catch (error) {
      parseThrew = error
    }
    check('healthDiagnostic: detectManagedSettingsWarnings throws on invalid JSON instead of returning no warnings', parseThrew instanceof SyntaxError, String(parseThrew))
  } finally {
    fsOps.setFsImplementation(real)
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
