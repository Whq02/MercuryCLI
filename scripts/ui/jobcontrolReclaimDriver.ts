#!/usr/bin/env bun
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
  const r = reclaimTerminalAfterChild('panel-shell(test)')
  const reason = (r.reason ?? 'none').replace(/ /g, '-')
  out(`reclaim-driver: receipt reclaimed=${r.reclaimed} reason=${reason} before=${r.before ?? '-'} after=${r.after ?? '-'}`)
  try {
    const buf = Buffer.alloc(1)
    const n = readSync(0, buf, 0, 1, null)
    out(`reclaim-driver: read ok (${n})`)
  } catch (e) {
    out(`reclaim-driver: read failed ${(e as NodeJS.ErrnoException).code ?? String(e)}`)
  }
  process.exit(0)
})
