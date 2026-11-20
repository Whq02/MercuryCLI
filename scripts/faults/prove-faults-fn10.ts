#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn10-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

try {
  console.log('1. src/services/concourse/projectActivity.ts')
  {
    const { runningByProjectKey } = await import('../../src/services/concourse/projectActivity.ts')
    const absentDir = join(SCRATCH, 'pa-absent')
    mkdirSync(absentDir, { recursive: true })
    const absentMap = await runningByProjectKey(absentDir)
    check('projectActivity.runningByProjectKey absent records file returns empty map', absentMap.size === 0)

    const corruptDir = join(SCRATCH, 'pa-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'concourse-workers.json'), '{not-json')
    const corruptErr = await rejects(() => runningByProjectKey(corruptDir))
    check('projectActivity.runningByProjectKey rejects on corrupt records file', corruptErr !== null, 'returned empty map instead of rejecting')

    if (POSIX_MODES) {
      const unreadableDir = join(SCRATCH, 'pa-unreadable')
      mkdirSync(unreadableDir, { recursive: true })
      const file = join(unreadableDir, 'concourse-workers.json')
      writeFileSync(file, JSON.stringify({ version: 1, workers: {} }))
      chmodSync(file, 0o200)
      const permErr = await rejects(() => runningByProjectKey(unreadableDir))
      chmodSync(file, 0o600)
      check('projectActivity.runningByProjectKey rejects on unreadable records file', permErr !== null, 'returned empty map instead of rejecting')
    }
  }

  console.log('2. src/services/concourse/sessionTitleMint.ts')
  {
    const { transcriptHeadFacts } = await import('../../src/services/concourse/sessionTitleMint.ts')
    const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
    const workspaceId = join(SCRATCH, 'ws-title')
    mkdirSync(workspaceId, { recursive: true })
    const absent = transcriptHeadFacts({ sessionId: 'absent-session', workspaceId })
    check('sessionTitleMint.transcriptHeadFacts absent transcript returns zero turns', absent.assistantTurns === 0 && absent.description === '')

    if (POSIX_MODES) {
      const rec = { sessionId: 'unreadable-session', workspaceId }
      const file = workerTranscriptPath(rec)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '{}\n')
      chmodSync(file, 0o200)
      let threw: unknown = null
      try {
        transcriptHeadFacts(rec)
      } catch (error) {
        threw = error
      } finally {
        chmodSync(file, 0o600)
      }
      check('sessionTitleMint.transcriptHeadFacts throws on unreadable transcript', threw !== null, 'returned zero turns on EACCES')
    }
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
