#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0

function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function withScratchHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn24-')))
  const prevConfig = process.env.MERCURY_CONFIG_DIR
  const prevHome = process.env.MERCURY_HOME
  process.env.MERCURY_CONFIG_DIR = scratch
  delete process.env.MERCURY_HOME
  try {
    await fn(scratch)
  } finally {
    if (prevConfig === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevConfig
    if (prevHome === undefined) delete process.env.MERCURY_HOME
    else process.env.MERCURY_HOME = prevHome
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function proveLaunchMilestones(): Promise<void> {
  const m = await import('../../src/substrate/launchMilestones.js')
  await withScratchHome(home => {
    m._resetLaunchMilestonesForTesting()
    check('launchMilestones: missing file returns empty rows', m.readLaunchMilestones().length === 0)
    const file = join(home, 'launch-milestones.json')
    const corrupt = '{not-valid-json'
    writeFileSync(file, corrupt, { mode: 0o600 })
    let parseThrew = false
    try {
      m.readLaunchMilestones()
    } catch {
      parseThrew = true
    }
    check('launchMilestones: corrupt file throws instead of returning empty', parseThrew)
    m.recordLaunchMilestone('runtime-entry')
    check('launchMilestones: recordLaunchMilestone preserves corrupt file', readFileSync(file, 'utf8') === corrupt)
    if (POSIX_MODES) {
      const valid = JSON.stringify({ version: 1, rows: [{ schema: 1, pid: 1, milestone: 'input-live', atMs: 1 }] })
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      let eaccesCode: string | undefined
      try {
        m.lastBootReachedInputLive()
      } catch (e) {
        eaccesCode = (e as NodeJS.ErrnoException).code
      }
      m._resetLaunchMilestonesForTesting()
      m.recordLaunchMilestone('runtime-entry')
      chmodSync(file, 0o600)
      check('launchMilestones: unreadable file throws EACCES', eaccesCode === 'EACCES', String(eaccesCode))
      check('launchMilestones: recordLaunchMilestone preserves unreadable file', readFileSync(file, 'utf8') === valid)
    }
  })
}

async function main(): Promise<void> {
  await proveLaunchMilestones()
  console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
