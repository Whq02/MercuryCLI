#!/usr/bin/env bun
// ============================================================================
//  prove-runner-interactive.ts — the §5.9 interactive PTY lane on
//  the runner (zero model calls; a scripted pty child):
//    §1 the lane drives a REAL pty child through the driver with a
//       timed tape; sends arrive IN ORDER and the child sees a tty;
//    §2 every tape send lands on the row as a TYPED attention event
//
//    §3 grading runs against the workdir exactly like the headless path;
//    §4 a tape that never quits types as the ceiling's 'incomplete';
//    §5 the capture spawn passes an explicit maxBuffer (§4.14 — pinned
//       structurally: the 1 MiB default killer stays dead).
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTaskWithPolicy } from './live/runner.js'
import { policyById } from './live/policies.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures += 1
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
}

const scratchRoot = mkdtempSync(join(tmpdir(), 'helix-interactive-proof-'))
const corpusRoot = join(scratchRoot, 'corpus')
const configHome = join(scratchRoot, 'config')
process.env.HELIX_TIME_CEILING_OVERRIDE = '20'
const policy = policyById('solo')

// The scripted pty child: proves tty-ness, logs every stdin line, quits on
// command. (python3 is a corpus prerequisite already.)
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

// §1-§3: an orderly journey — primer, brief, quit.
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
check('§1 the lane ran and settled before the ceiling', row.timedOut !== true, row.status)
check('§2 runMode recorded', row.runMode === 'interactive-pty')
check(
  '§2 attention events typed per send (primer/brief/control)',
  JSON.stringify((row.attentionEvents ?? []).map(e => e.kind)) === '["primer","brief","control"]',
)
check(
  '§2 events carry offsets + char counts, never content',
  (row.attentionEvents ?? []).every(e => typeof e.atMs === 'number' && typeof e.chars === 'number' && !('text' in e)),
)
const workdir = row.workdir ?? ''
check('§2 a kept run names its workdir', workdir !== '' && existsSync(workdir))
const received = existsSync(join(workdir, 'received.txt'))
  ? readFileSync(join(workdir, 'received.txt'), 'utf8')
  : '(missing)'
check('§1 sends arrived in order at the pty child', /primer[\s\S]*do the task[\s\S]*quit/.test(received), JSON.stringify(received.slice(0, 80)))
check('§3 grading ran (components present)', Array.isArray(row.graderComponents) && row.graderComponents.length > 0)
check('§3 T01 unchanged by the journey => rejected, never accepted', row.status === 'rejected', row.status)

// §4 a tape that never quits: the ceiling types it.
process.env.HELIX_TIME_CEILING_OVERRIDE = '3'
const stuck = runTaskWithPolicy('T01', policy, {
  root: corpusRoot,
  configHome,
  agentCmd: CHILD,
  interactive: { tape: [{ atMs: 500, text: 'hello\\r', kind: 'brief' }] },
})
check('§4 no quit => the ceiling wins as incomplete', stuck.status === 'incomplete', stuck.status)
process.env.HELIX_TIME_CEILING_OVERRIDE = '900'

// §5 the maxBuffer law, pinned structurally at the lane's spawn.
const runnerSource = readFileSync(join(import.meta.dir, 'live/runner.ts'), 'utf8')
const laneSpawn = runnerSource.slice(runnerSource.indexOf('the §5.9 interactive PTY lane'), runnerSource.indexOf('} else if (agentCmd)'))
check('§5 the pty capture spawn pins an explicit maxBuffer', /maxBuffer:\s*64 \* 1024 \* 1024/.test(laneSpawn))

if (failures > 0) {
  console.error('prove-runner-interactive: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-runner-interactive: green')
