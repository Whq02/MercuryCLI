
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const CLEARED = [
  'MERCURY_FAULT_INJECT',
  'MERCURY_FAULT_INJECT',
  'MERCURY_DURABLE_FSYNC',
  'MERCURY_DURABLE_FSYNC',
  'MERCURY_LANES',
  'MERCURY_LANES',
  'MERCURY_GATE_LEDGER',
] as const

export function scratchRoot(prefix: string): string {
  for (const key of CLEARED) delete process.env[key]
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `keel-${prefix}-`)))
  process.env.MERCURY_CONFIG_DIR = root
  return root
}

export function guardWrite(root: string, path: string): string {
  const full = resolve(path)
  const rel = relative(root, full)
  const inside = full === root || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel))
  if (!inside) {
    throw new Error(`durability proof refused a write outside its scratch root: ${full}`)
  }
  return full
}

export async function waitUntil(
  pred: () => boolean,
  opts?: { tries?: number; everyMs?: number },
): Promise<boolean> {
  const tries = opts?.tries ?? 600
  const everyMs = opts?.everyMs ?? 5
  for (let i = 0; i < tries; i++) {
    if (pred()) return true
    await new Promise<void>(res => setTimeout(res, everyMs))
  }
  return pred()
}

export const CHECKS_FAILED_EXIT = 3

export interface Checker {
  check(label: string, cond: boolean, detail?: string): void
  section(title: string): void
  failures(): number
  finish(name: string): never
}

export function checker(): Checker {
  let failures = 0
  return {
    check(label, cond, detail = '') {
      if (!cond) failures++
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
    },
    section(title) {
      console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
    },
    failures: () => failures,
    finish(name) {
      console.log(
        `\n${failures === 0 ? '✅' : '❌'} ${name} — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`,
      )
      process.exit(failures === 0 ? 0 : CHECKS_FAILED_EXIT)
    },
  }
}
