#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { findLatestSession, launchArgs, runTaskWithPolicy } from './live/runner.js'
import { policyById } from './live/policies.js'
import { getProjectDir } from '../../src/sessions/transcripts/sessionStoragePortable.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures += 1
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
check('§1 status is interrupted', interrupted.status === 'interrupted', interrupted.status, 'an armed interruptAfterSec shorter than the time ceiling must end the run as interrupted; see the interruptArmed branch of runTaskWithPolicy in scripts/mission-runner/live/runner.ts')
check('§1 runPhase recorded', interrupted.runPhase === 'interrupted', '', 'the row spread of runTaskWithPolicy in scripts/mission-runner/live/runner.ts must set runPhase when interrupted')
check('§1 interruptedAfterSec recorded', interrupted.interruptedAfterSec === 1, '', 'the row spread of runTaskWithPolicy in scripts/mission-runner/live/runner.ts must record interruptedAfterSec')
check('§1 the workdir is named and KEPT', Boolean(interrupted.workdir) && existsSync(interrupted.workdir ?? ''), '', 'an interrupted row must carry its workdir and runTaskWithPolicy in scripts/mission-runner/live/runner.ts must not delete it')
const progressPath = join(interrupted.workdir ?? '', 'progress.txt')
check('§1 phase-1 effect landed once', readFileSync(progressPath, 'utf8') === 'p1\n', '', 'the agent command should run once in the kept workdir before the interrupt; see runTaskWithPolicy in scripts/mission-runner/live/runner.ts')

process.env.HELIX_TIME_CEILING_OVERRIDE = '1'
const ceilinged = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: 'sleep 30',
  interruptAfterSec: 600,
})
check('§2 ceiling wins as incomplete, never interrupted', ceilinged.status === 'incomplete', ceilinged.status, 'when the time ceiling (HELIX_TIME_CEILING_OVERRIDE) is not above interruptAfterSec the interrupt must not arm; see interruptArmed in runTaskWithPolicy, scripts/mission-runner/live/runner.ts')
process.env.HELIX_TIME_CEILING_OVERRIDE = '900'

const resumed = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: 'echo p2 >> "$HELIX_WORKDIR/progress.txt"; echo \'{"type":"outcome","status":"completed","answer":"continued and finished"}\'',
  resumeFrom: { sessionId: 'fake-session-0001', workdir: interrupted.workdir ?? '' },
})
check('§3 resumed row is terminal', resumed.status !== 'interrupted' && resumed.status !== 'incomplete', resumed.status, 'a resumeFrom run must finish and be graded; see the resuming branch of runTaskWithPolicy in scripts/mission-runner/live/runner.ts')
check('§3 runPhase resumed + linkage', resumed.runPhase === 'resumed' && resumed.resumedFromSessionId === 'fake-session-0001', '', 'the row spread of runTaskWithPolicy in scripts/mission-runner/live/runner.ts must set runPhase resumed and resumedFromSessionId from resumeFrom')
check('§3 no duplicate side effects', readFileSync(progressPath, 'utf8') === 'p1\np2\n', '', 'a resumed run must reuse the kept workdir without re-running the first phase; see the resuming branch of runTaskWithPolicy in scripts/mission-runner/live/runner.ts')
check('§3 grading ran in the kept workdir', Array.isArray(resumed.graderComponents) && resumed.graderComponents.length > 0, '', 'a resumed run must grade the kept workdir and put the verdict components on the row; see runTaskWithPolicy in scripts/mission-runner/live/runner.ts')

const argv = launchArgs(policy, 'go', 'sess-9')
check('§4 --resume rides the real launch', argv[1] === 'run' && argv[2] === '--resume' && argv[3] === 'sess-9', '', 'launchArgs in scripts/mission-runner/live/runner.ts must place run, --resume and the session id right after the entry script: ' + JSON.stringify(argv))
check('§4 the brief + model still ride', argv[4] === 'go' && argv[5] === '--model' && argv[6] === policy.model, '', 'launchArgs in scripts/mission-runner/live/runner.ts must follow --resume with the brief, --model and the policy model: ' + JSON.stringify(argv))
const plain = launchArgs(policy, 'go')
check('§4 no resume flag without a session', !plain.includes('--resume'), '', 'launchArgs in scripts/mission-runner/live/runner.ts must add --resume only when given a session id')

const workdirFake = join(scratchRoot, 'projected work', 'dir')
const slugDir = join(configHome, 'projects', basename(getProjectDir(workdirFake)))
mkdirSync(slugDir, { recursive: true })
writeFileSync(join(slugDir, 'older-session.jsonl'), '{}\n')
utimesSync(join(slugDir, 'older-session.jsonl'), new Date(1000), new Date(1000))
writeFileSync(join(slugDir, 'newer-session.jsonl'), '{}\n')
utimesSync(join(slugDir, 'newer-session.jsonl'), new Date(5000), new Date(5000))
check('§5 finds the newest since-launch transcript', findLatestSession(configHome, workdirFake, 2000) === 'newer-session', '', 'findLatestSession in scripts/mission-runner/live/runner.ts must return the newest .jsonl at or after sinceMs in the workdir project folder')
check('§5 nothing since => null', findLatestSession(configHome, workdirFake, 9000) === null, '', 'findLatestSession in scripts/mission-runner/live/runner.ts must return null when no transcript is newer than sinceMs')
check('§5 unknown workdir => null', findLatestSession(configHome, join(scratchRoot, 'nowhere'), 0) === null, '', 'findLatestSession in scripts/mission-runner/live/runner.ts must return null when the workdir has no project folder')

rmSync(scratchRoot, { recursive: true, force: true })
delete process.env.HELIX_TIME_CEILING_OVERRIDE

if (failures > 0) {
  console.error('prove-runner-interruption: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-runner-interruption: green')
