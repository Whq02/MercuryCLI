#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTaskWithPolicy } from './live/runner.js'
import { policyById } from './live/policies.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures += 1
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}${!cond && fix ? ' - ' + fix : ''}`)
}

const scratchRoot = mkdtempSync(join(tmpdir(), 'helix-interactive-proof-'))
const corpusRoot = join(scratchRoot, 'corpus')
const configHome = join(scratchRoot, 'config')
process.env.HELIX_TIME_CEILING_OVERRIDE = '20'
const policy = policyById('solo')

const CHILD =
  'python3 -u -c \'' +
  'import sys\n' +
  'print("READY tty=%s" % sys.stdin.isatty())\n' +
  'log = open("received.txt", "a")\n' +
  'for line in iter(sys.stdin.readline, ""):\n' +
  '    log.write(line)\n' +
  '    log.flush()\n' +
  '    if line.strip() == "quit":\n' +
  '        break\n' +
  '\''

const row = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: CHILD,
  keepWorkdir: true,
  interactive: {
    tape: [
      { atMs: 800, text: 'primer\\r', kind: 'primer' },
      { atMs: 1600, text: 'do the task\\r', kind: 'brief' },
      { atMs: 2600, text: 'quit\\r', kind: 'control' },
    ],
  },
})
check('§1 the lane ran and settled before the ceiling', row.timedOut !== true, row.status, 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must end the interactive lane when the child gets quit, before HELIX_TIME_CEILING_OVERRIDE')
check('§2 runMode recorded', row.runMode === 'interactive-pty', '', 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must set runMode to interactive-pty on the row when options.interactive is given')
check(
  '§2 attention events typed per send (primer/brief/control)',
  JSON.stringify((row.attentionEvents ?? []).map(e => e.kind)) === '["primer","brief","control"]',
  '',
  'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must put one attentionEvents entry per tape step, kind kept, in tape order',
)
check(
  '§2 events carry offsets + char counts, never content',
  (row.attentionEvents ?? []).every(e => typeof e.atMs === 'number' && typeof e.chars === 'number' && !('text' in e)),
  '',
  'the attentionEvents mapping in runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must keep atMs, kind and chars only, never the text',
)
const workdir = row.workdir ?? ''
check('§2 a kept run names its workdir', workdir !== '' && existsSync(workdir), '', 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must return the row workdir and keep the directory when keepWorkdir is set')
const received = existsSync(join(workdir, 'received.txt'))
  ? readFileSync(join(workdir, 'received.txt'), 'utf8')
  : '(missing)'
check('§1 sends arrived in order at the pty child', /primer[\s\S]*do the task[\s\S]*quit/.test(received), JSON.stringify(received.slice(0, 80)), 'the interactive lane in runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must type each tape step into the pty child at its atMs, in order')
check('§3 grading ran (components present)', Array.isArray(row.graderComponents) && row.graderComponents.length > 0, '', 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must grade the workdir after the interactive lane and return graderComponents')
check('§3 T01 unchanged by the journey => rejected, never accepted', row.status === 'rejected', row.status, 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must report status rejected when the workdir is unchanged after the lane')

process.env.HELIX_TIME_CEILING_OVERRIDE = '3'
const stuck = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: CHILD,
  interactive: { tape: [{ atMs: 500, text: 'hello\\r', kind: 'brief' }] },
})
check('§4 no quit => the ceiling wins as incomplete', stuck.status === 'incomplete', stuck.status, 'runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must report incomplete when HELIX_TIME_CEILING_OVERRIDE passes before the child quits')
process.env.HELIX_TIME_CEILING_OVERRIDE = '900'

const runnerSource = readFileSync(join(import.meta.dir, 'live/runner.ts'), 'utf8')
const laneSpawn = runnerSource.slice(runnerSource.indexOf('if (options.interactive) {'), runnerSource.indexOf('} else if (agentCmd)'))
check('§5 the pty capture spawn pins an explicit maxBuffer', laneSpawn.length > 0 && /maxBuffer:\s*64 \* 1024 \* 1024/.test(laneSpawn), '', 'the options.interactive branch of runTaskWithPolicy (scripts/mission-runner/live/runner.ts) must pass maxBuffer: 64 * 1024 * 1024 to its spawn')

if (failures > 0) {
  console.error('prove-runner-interactive: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-runner-interactive: green')
