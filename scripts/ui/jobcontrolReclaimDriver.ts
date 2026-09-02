#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/jobcontrolReclaimDriver.ts — the native reclaim, exercised
//  against a REAL terminal under a job-control shell.
//
//  The product hands the terminal to a child that takes its foreground
//  process group (an editor, the panel's login shell) and, killed, gives
//  nothing back; the reclaim owner (utils/terminalHandback) puts the group
//  back through the native pack. The product's hand-off is a spawnSync with
//  inherited stdio, and the product runs under node — where nothing restores
//  the foreground group when the child is killed, so the reclaim is needed.
//
//  A prover, though, runs under bun, whose spawnSync with an inherited child
//  restores the foreground group ITSELF on the child's exit — which would
//  MASK the reclaim (the group comes back with or without it). So this driver
//  does NOT steal the terminal through an inherited-stdio spawn: it spawns a
//  detached thief (stdio ignored) that tcsetpgrp's the terminal to its own
//  group and holds it — the exact state a killed editor leaves — and, when
//  the host kills the thief, calls the SAME owner the hand-off finally calls.
//  Here only the native reclaim can flip the foreground group back, so the
//  observation is the reclaim's, faithful to the product under node.
//
//  Lines the host waits for:
//    reclaim-driver: thief spawned
//    reclaim-thief holds pgid=<n> was=<n>        (the thief, to /dev/tty)
//    reclaim-driver: receipt reclaimed=<bool> reason=<r> before=<n> after=<n>
//    reclaim-driver: read ok (<n>)               (the read that would have
//                                                 stopped the job returns)
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reclaimTerminalAfterChild } from '../../src/utils/terminalHandback.ts'

const out = (line: string): void => void process.stdout.write(`${line}\r\n`)

const dir = mkdtempSync(join(tmpdir(), 'reclaim-'))
const thiefPath = join(dir, 'reclaim-thief.py')
writeFileSync(
  thiefPath,
  `#!/usr/bin/python3
import os, signal, time
tty = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
was = os.tcgetpgrp(tty)
os.setpgrp()
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
os.tcsetpgrp(tty, os.getpgrp())
os.write(tty, ('reclaim-thief holds pgid=%d was=%d\\r\\n' % (os.getpgrp(), was)).encode())
while True:
    time.sleep(0.05)
`,
)

const thief = spawn('/usr/bin/python3', [thiefPath], { stdio: 'ignore' })
out('reclaim-driver: thief spawned')

thief.on('exit', () => {
  // The thief was killed; the terminal's foreground group is its dead group —
  // the exact state a killed editor or panel shell leaves.
  const r = reclaimTerminalAfterChild('panel-shell(test)')
  const reason = (r.reason ?? 'none').replace(/ /g, '-')
  out(`reclaim-driver: receipt reclaimed=${r.reclaimed} reason=${reason} before=${r.before ?? '-'} after=${r.after ?? '-'}`)
  // The read that stops a background job. With the reclaim it runs as the
  // foreground group and returns (the host feeds a byte); without it (pack
  // absent) it stops the job with SIGTTIN, or fails from the background.
  try {
    const buf = Buffer.alloc(1)
    const n = readSync(0, buf, 0, 1, null)
    out(`reclaim-driver: read ok (${n})`)
  } catch (e) {
    out(`reclaim-driver: read failed ${(e as NodeJS.ErrnoException).code ?? String(e)}`)
  }
  process.exit(0)
})
