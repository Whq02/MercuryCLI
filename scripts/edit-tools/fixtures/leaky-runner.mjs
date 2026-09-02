#!/usr/bin/env node
// leaky-runner — a runner child that forks a GRANDCHILD holding the
// inherited pipes, then behaves as LEAKY_MODE says. The shape a real
// `cargo test`, `go test ./...` or `npm run build` takes when it spawns
// workers: the leader can end while a descendant keeps stdout/stderr open,
// so the parent's `close` event never fires.
//
//   linger  — print a line, spawn the grandchild, then EXIT. `exit` fires;
//             `close` cannot, because the grandchild holds the pipes.
//   hang    — print a line, spawn the grandchild, and never exit. Neither
//             `exit` nor `close` fires: only a deadline can settle this.
//
// The grandchild writes its own pid to LEAKY_PID_FILE (so a proof can
// census whether the tree kill reached it) and sleeps well past any
// proof budget. It inherits stdout/stderr on purpose.
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
  // The leader ends; the grandchild keeps the inherited pipes open.
  setTimeout(() => process.exit(0), 150)
} else {
  // Never exits — the deadline is the only settlement.
  setInterval(() => {}, 1000)
}
