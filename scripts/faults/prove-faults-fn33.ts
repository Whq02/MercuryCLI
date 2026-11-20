#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn33-')))
const HOME = join(SCRATCH, 'home')
const TMP = join(SCRATCH, 'tmp')
mkdirSync(HOME, { recursive: true })
mkdirSync(TMP, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = TMP
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runPidAlive(): Promise<void> {
  console.log('\npidAlive — EPERM means alive, ESRCH means dead')
  const { pidAlive } = await import('../../src/utils/pidAlive.ts')
  const origKill = process.kill
  try {
    process.kill = ((_pid: number, _sig?: string | number) => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }) as typeof process.kill
    check('pidAlive returns true on EPERM', pidAlive(424242) === true)

    process.kill = ((_pid: number, _sig?: string | number) => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }) as typeof process.kill
    check('pidAlive returns false on ESRCH', pidAlive(424242) === false)
  } finally {
    process.kill = origKill
  }
}

async function runLocalJsxCommandError(): Promise<void> {
  console.log('\nprocessSlashCommand — local-jsx load failure reports stderr and commandError')
  const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const brokenCommand = {
    type: 'local-jsx' as const,
    name: 'broken-jsx-proof',
    description: 'broken',
    isEnabled: () => true,
    load: async () => {
      throw new Error('boom-jsx-load')
    },
  }
  const fakeContext = {
    options: { commands: [brokenCommand] },
  } as unknown as Parameters<typeof processSlashCommand>[4]
  const res = await processSlashCommand('/broken-jsx-proof', [], [], [], fakeContext, () => {})
  check(
    'local-jsx failure returns commandError and stderr message',
    typeof res.commandError === 'string' &&
      res.commandError.includes('boom-jsx-load') &&
      res.messages.length >= 2,
    JSON.stringify({ commandError: res.commandError, messageCount: res.messages.length }),
  )
}

try {
  await runPidAlive()
  await runLocalJsxCommandError()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

void chmodSync
void readFileSync
void symlinkSync
void writeFileSync
void POSIX_MODES

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
