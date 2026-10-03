#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')

function resolveIn(opts: { defaultMode?: string; override?: string; home?: string }): string {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'seat-perm-mode-'))
  if (opts.home === undefined) {
    const settings = opts.defaultMode === undefined ? {} : { guardrails: { mode: opts.defaultMode } }
    writeFileSync(join(home, 'settings.json'), JSON.stringify(settings))
  }
  const src = `
    import { seatInitialPermissionMode } from ${JSON.stringify(join(HERE, '../../src/daemon/concourseSupervisor.ts'))}
    const override = process.env.__OVERRIDE__ && process.env.__OVERRIDE__.length > 0 ? process.env.__OVERRIDE__ : undefined
    process.stdout.write(String(seatInitialPermissionMode(override)))
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      MERCURY_HOME: '',
      __OVERRIDE__: opts.override ?? '',
      MERCURY_DAEMON_PERMISSION_MODE: '',
    },
  })
  return (res.stdout ?? '').trim()
}

check("M1 override 'default' is honored", resolveIn({ override: 'default' }) === 'default')
check("M1 override 'sovereign' is honored", resolveIn({ override: 'sovereign' }) === 'sovereign')
check("M1 override 'flow' is honored", resolveIn({ override: 'flow' }) === 'flow')

check("M2 saved 'default' ⇒ the seat boots 'default' (no '✦ flow on' badge)", resolveIn({ defaultMode: 'default' }) === 'default')
check("M2 saved 'implement' ⇒ the seat boots 'implement'", resolveIn({ defaultMode: 'implement' }) === 'implement')
check("M2 saved 'sovereign' ⇒ the seat boots 'default' (a saved sovereign never arms the bypass; the launch flag is the consent)", resolveIn({ defaultMode: 'sovereign' }) === 'default')

check("M3 no saved default, no override ⇒ 'flow' (today's behavior held)", resolveIn({}) === 'flow')

check("M4 saved 'frobnicate' (no such mode) ⇒ 'default', never an unintended mode (both doors open the default on an unknown word)", resolveIn({ defaultMode: 'frobnicate' }) === 'default')

check(
  'M5 an unreadable settings store fails soft to flow (never blocks a spawn)',
  resolveIn({ home: join(mkdtempSync(join(tmpdir(), 'seat-perm-gone-')), 'does', 'not', 'exist') }) === 'flow',
)

console.log(failures === 0 ? '\nprove-seat-permission-mode: ALL LAWS HOLD' : `\nprove-seat-permission-mode: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
