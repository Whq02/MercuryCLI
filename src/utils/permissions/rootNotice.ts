import { writeSync } from 'node:fs'
import type { PermissionMode } from './PermissionMode.js'

let shown = false

export function noteRootSovereign(mode: PermissionMode): void {
  if (shown || mode !== 'sovereign' || process.getuid?.() !== 0) return
  shown = true
  try {
    writeSync(2, 'Running as root in sovereign mode: the agent can change any file on this machine without asking.\n')
  } catch {}
}
