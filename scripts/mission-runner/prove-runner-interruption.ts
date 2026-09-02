#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLatestSession, launchArgs, runTaskWithPolicy } from './live/runner.js'
import { policyById } from './live/policies.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures += 1
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
}

const scratchRoot = mkdtempSync(join(tmpdir(), 'helix-interrupt-proof-'))
const corpusRoot = join(scratchRoot, 'corpus')
const configHome = join(scratchRoot, 'config')
mkdirSync(configHome, { recursive: true })
process.env.HELIX_TIME_CEILING_OVERRIDE = '900'
const policy = policyById('solo')

const interrupted = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: 'echo p1 >> "$HELIX_WORKDIR/progress.txt"; sleep 30',
  interruptAfterSec: 1,
})
check('§1 status is interrupted', interrupted.status === 'interrupted', interrupted.status)
check('§1 runPhase recorded', interrupted.runPhase === 'interrupted')
check('§1 interruptedAfterSec recorded', interrupted.interruptedAfterSec === 1)
check('§1 the workdir is named and KEPT', Boolean(interrupted.workdir) && existsSync(interrupted.workdir ?? ''))
const progressPath = join(interrupted.workdir ?? '', 'progress.txt')
check('§1 phase-1 effect landed once', readFileSync(progressPath, 'utf8') === 'p1\n')

process.env.HELIX_TIME_CEILING_OVERRIDE = '1'
const ceilinged = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: 'sleep 30',
  interruptAfterSec: 600,
})
check('§2 ceiling wins as incomplete, never interrupted', ceilinged.status === 'incomplete', ceilinged.status)
process.env.HELIX_TIME_CEILING_OVERRIDE = '900'

const resumed = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: 'echo p2 >> "$HELIX_WORKDIR/progress.txt"; echo \'{"result":"continued and finished"}\'',
  resumeFrom: { sessionId: 'fake-session-0001', workdir: interrupted.workdir ?? '' },
})
check('§3 resumed row is terminal', resumed.status !== 'interrupted' && resumed.status !== 'incomplete', resumed.status)
check('§3 runPhase resumed + linkage', resumed.runPhase === 'resumed' && resumed.resumedFromSessionId === 'fake-session-0001')
check('§3 no duplicate side effects', readFileSync(progressPath, 'utf8') === 'p1\np2\n')
check('§3 grading ran in the kept workdir', Array.isArray(resumed.graderComponents) && resumed.graderComponents.length > 0)

const argv = launchArgs(policy, 'go', 'sess-9')
check('§4 --resume rides the real launch', argv[1] === '--resume' && argv[2] === 'sess-9')
check('§4 the brief + model still ride', argv.includes('-p') && argv.includes('go') && argv.includes('--model'))
const plain = launchArgs(policy, 'go')
check('§4 no resume flag without a session', !plain.includes('--resume'))

const workdirFake = join(scratchRoot, 'projected work', 'dir')
const slugDir = join(configHome, 'projects', sanitizePath(workdirFake))
mkdirSync(slugDir, { recursive: true })
writeFileSync(join(slugDir, 'older-session.jsonl'), '{}\n')
utimesSync(join(slugDir, 'older-session.jsonl'), new Date(1000), new Date(1000))
writeFileSync(join(slugDir, 'newer-session.jsonl'), '{}\n')
utimesSync(join(slugDir, 'newer-session.jsonl'), new Date(5000), new Date(5000))
check('§5 finds the newest since-launch transcript', findLatestSession(configHome, workdirFake, 2000) === 'newer-session')
check('§5 nothing since => null', findLatestSession(configHome, workdirFake, 9000) === null)
check('§5 unknown workdir => null', findLatestSession(configHome, join(scratchRoot, 'nowhere'), 0) === null)

rmSync(scratchRoot, { recursive: true, force: true })
delete process.env.HELIX_TIME_CEILING_OVERRIDE

if (failures > 0) {
  console.error('prove-runner-interruption: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-runner-interruption: green')
