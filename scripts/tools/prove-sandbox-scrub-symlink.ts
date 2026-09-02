#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-scrub-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const projectDir = join(scratch, 'project')
mkdirSync(projectDir)
process.chdir(projectDir)

symlinkSync(join(scratch, 'nonexistent-stow-target'), join(projectDir, 'config'))
const stowDir = join(scratch, 'stow')
mkdirSync(stowDir)
writeFileSync(join(stowDir, 'hooks-real'), 'the real hooks file\n', 'utf8')
symlinkSync(join(stowDir, 'hooks-real'), join(projectDir, 'hooks'))

const { convertToSandboxRuntimeConfig, SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const config = convertToSandboxRuntimeConfig({
  sandbox: {
    enabled: true,
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { allowRead: [], denyRead: [], allowWrite: [] },
  },
} as never)

const resolvedProject = realpathSync(projectDir)
const denyWrite = (config as { filesystem?: { denyWrite?: string[] } }).filesystem?.denyWrite ?? []
check('the dangling config symlink is DENIED, never scrub-listed',
  denyWrite.includes(join(resolvedProject, 'config')), JSON.stringify(denyWrite.filter(p => p.includes('project'))))
check('the live hooks symlink is DENIED, never scrub-listed',
  denyWrite.includes(join(resolvedProject, 'hooks')))
check('genuinely absent HEAD is NOT in denyWrite (it is scrub prey)',
  !denyWrite.includes(join(resolvedProject, 'HEAD')))

SandboxManager.cleanupAfterCommand()

check('the dangling config symlink SURVIVES the scrub',
  (() => { try { return lstatSync(join(projectDir, 'config')).isSymbolicLink() } catch { return false } })())
check('the live hooks symlink SURVIVES the scrub',
  (() => { try { return lstatSync(join(projectDir, 'hooks')).isSymbolicLink() } catch { return false } })())
check('the stow target is untouched', existsSync(join(stowDir, 'hooks-real')))

writeFileSync(join(projectDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
SandboxManager.cleanupAfterCommand()
check('a planted HEAD is scrubbed', !existsSync(join(projectDir, 'HEAD')))

process.chdir(tmpdir())
rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0
  ? `\nsandbox scrub symlink: green (${checks} checks)`
  : `\nsandbox scrub symlink: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
