#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.env.LEAKY_MODE ?? 'linger'
const pidFile = process.env.LEAKY_PID_FILE
const grandchildSeconds = Number(process.env.LEAKY_GRANDCHILD_SECONDS ?? '120')

process.stdout.write('leaky-runner: starting\n')

const grandchild = spawn(
  process.execPath,
  ['-e', `setTimeout(() => {}, ${grandchildSeconds * 1000})`],
  { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, env: { ...process.env } },
)
if (pidFile && grandchild.pid) writeFileSync(pidFile, String(grandchild.pid))

process.stdout.write(`leaky-runner: grandchild ${grandchild.pid ?? 'unknown'}\n`)

if (mode === 'linger') {
  setTimeout(() => process.exit(0), 150)
} else {
  setInterval(() => {}, 1000)
}
