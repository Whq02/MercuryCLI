import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function withProofAccountHome(prefix = 'proof-account-', base = tmpdir()): string {
  const flag = '--proof-account-home'
  const at = process.argv.indexOf(flag)
  if (at >= 0) {
    const home = process.argv[at + 1]
    if (!home || homedir() !== home || process.env.HOME !== home || process.env.USERPROFILE !== home) throw new Error('proof account home was not established before runtime startup')
    return home
  }
  const scratch = realpathSync(mkdtempSync(join(base, prefix)))
  const home = join(scratch, 'h')
  mkdirSync(home)
  let code = 1
  try {
    const child = spawnSync(process.execPath, [...process.argv.slice(1), flag, home], {
      stdio: 'inherit',
      env: { ...process.env, HOME: home, USERPROFILE: home, BUN: process.env.BUN ?? process.execPath },
    })
    code = child.status ?? 1
    if (child.error) console.error(`proof account child failed: ${child.error.message}`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
  process.exit(code)
}
