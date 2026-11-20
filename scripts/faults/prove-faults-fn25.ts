#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn25-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resolveAgentCwd } = await import('../../src/tools/AgentTool/agent/cwd.ts')

{
  const dir = join(scratch, 'cwd-loop')
  mkdirSync(dir, { recursive: true })
  const loopA = join(dir, 'a')
  const loopB = join(dir, 'b')
  symlinkSync(loopB, loopA)
  symlinkSync(loopA, loopB)
  let thrown: (Error & { code?: string }) | null = null
  try {
    resolveAgentCwd(loopA, getEmptyToolPermissionContext())
  } catch (error) {
    thrown = error as Error & { code?: string }
  }
  check(
    'agent/cwd: non-ENOENT stat failure throws real errno instead of claiming cwd does not exist',
    thrown !== null && thrown.code === 'ELOOP' && !thrown.message.includes('cwd does not exist'),
    thrown ? `${thrown.code ?? 'no-code'}: ${thrown.message}` : 'did not throw',
  )
  let missing: Error | null = null
  try {
    resolveAgentCwd(join(dir, 'absent'), getEmptyToolPermissionContext())
  } catch (error) {
    missing = error as Error
  }
  check(
    'agent/cwd: ENOENT still reports cwd does not exist',
    missing !== null && missing.message.includes('cwd does not exist'),
    missing ? missing.message : 'did not throw',
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
