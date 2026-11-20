#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn08-')))
const HOME = join(SCRATCH, 'home')
const WORK = join(SCRATCH, 'work')
mkdirSync(HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runRow(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n${name}`)
  try {
    await fn()
  } catch (err) {
    failures++
    console.log(`  [FAIL] ${name} threw unexpectedly — ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  await runRow('overrides: refuses overwrite when agent-overrides.json is unreadable or corrupt', async () => {
    const overrides = await import('../../src/services/agents/overrides.js')
    const file = overrides.userOverridesPath()
    const valid = JSON.stringify({ version: 1, disabled: ['keep-me'], agents: { helper: { model: 'sonnet' } } }, null, 2) + '\n'
    mkdirSync(HOME, { recursive: true })

    writeFileSync(file, '{not valid json', { mode: 0o600 })
    let corruptThrew = false
    try {
      await overrides.setAgentDisabled('user', WORK, 'other', true)
    } catch {
      corruptThrew = true
    }
    check('setAgentDisabled rejects corrupt file', corruptThrew)
    check('corrupt file stands unchanged after setAgentDisabled', readFileSync(file, 'utf8') === '{not valid json')

    let corruptOverrideThrew = false
    try {
      await overrides.setAgentOverride('user', WORK, 'other', { model: 'opus' })
    } catch {
      corruptOverrideThrew = true
    }
    check('setAgentOverride rejects corrupt file', corruptOverrideThrew)
    check('corrupt file stands unchanged after setAgentOverride', readFileSync(file, 'utf8') === '{not valid json')

    if (POSIX_MODES) {
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      let eaccesDisabled = false
      let eaccesOverride = false
      try {
        try {
          await overrides.setAgentDisabled('user', WORK, 'other', true)
        } catch {
          eaccesDisabled = true
        }
        try {
          await overrides.setAgentOverride('user', WORK, 'other', { model: 'opus' })
        } catch {
          eaccesOverride = true
        }
      } finally {
        chmodSync(file, 0o600)
      }
      check('setAgentDisabled rejects unreadable file', eaccesDisabled)
      check('setAgentOverride rejects unreadable file', eaccesOverride)
      check('unreadable file keeps existing overrides byte for byte', readFileSync(file, 'utf8') === valid)
    }

    rmSync(file, { force: true })
    const created = await overrides.setAgentDisabled('user', WORK, 'other', true)
    check('absent file still writes cleanly', created.disabled.includes('other'))
  })
}

try {
  await main()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
