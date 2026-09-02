#!/usr/bin/env bun
// prove-flag-dormant — the MERCURY_RENDER_ENGINE gate: registered, opt-in,
// default OFF, and the module is DORMANT while off.
//
//   §1 the registry row exists with the opt-in polarity and the module
//      consumer.
//   §2 the gate answers OFF unset, ON at '1', and re-reads env LIVE.
//   §3 dormancy is structural, in its POST-MIGRATION form. The migration
//      lane landed the cockpit mount (the state the pre-landing pin named
//      as its own retirement), so "no product import" evolved into the
//      import law: outside src/render-engine/, product files may import the
//      engine ONLY through the cockpit mount seams (cockpit/engineMount ·
//      cockpit/terminalOut) — never an engine internal (ledger, door,
//      painter, scheduler, projection…) directly — and the mount itself
//      REFUSES to construct with the flag off (behavioral dormancy: every
//      gate reads null and the classic painter runs byte-identically).
//   §4 the engine demo is gated: with the flag forced off it refuses to run.

import { execSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Stamp-sim BEFORE importing the registry (the stamp folds off MACRO).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FLAG_REGISTRY, deleteFlagEnv, setFlagEnv } = await import('../../src/substrate/flagRegistry.ts')
const { renderEngineEnabled } = await import('../../src/render-engine/flag.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const root = join(import.meta.dir, '..', '..')

section('§1 the registry row')
{
  const row = FLAG_REGISTRY.find(r => r.env === 'MERCURY_RENDER_ENGINE')
  check('the row exists', row !== undefined)
  check('opt-in polarity (default OFF)', row?.kind === 'opt-in')
  check('the consumer is the engine flag module', row?.consumer === 'src/render-engine/flag.ts')
  check('the tier is declared', row?.tier === 'infra')
}

section('§2 live polarity')
{
  deleteFlagEnv('MERCURY_RENDER_ENGINE')
  check('unset ⇒ OFF', renderEngineEnabled() === false)
  setFlagEnv('MERCURY_RENDER_ENGINE', '1')
  check("'1' ⇒ ON (live re-read)", renderEngineEnabled() === true)
  setFlagEnv('MERCURY_RENDER_ENGINE', '0')
  check("'0' ⇒ OFF (live re-read)", renderEngineEnabled() === false)
  deleteFlagEnv('MERCURY_RENDER_ENGINE')
}

section('§3 structural dormancy — the post-migration import law')
{
  let referers: string[] = []
  try {
    referers = execSync(
      `grep -rln "render-engine" src --include='*.ts' --include='*.tsx' | grep -v '^src/render-engine/'`,
      { encoding: 'utf8', cwd: root, maxBuffer: 16 * 1024 * 1024 },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    referers = []
  }
  // Every import specifier that names render-engine must point at a mount
  // seam — the cockpit assembly or the door fold — never an internal.
  const MOUNT_SEAM = /render-engine\/cockpit\/(engineMount|terminalOut)(\.js)?$/
  const offenders: string[] = []
  for (const file of referers) {
    if (file === 'src/substrate/flagRegistry.ts') continue // the registry rows name consumer PATHS, not imports
    const body = execSync(`cat ${JSON.stringify(file)}`, { encoding: 'utf8', cwd: root, maxBuffer: 16 * 1024 * 1024 })
    const specs = [...body.matchAll(/from\s+['"]([^'"]*render-engine[^'"]*)['"]/g)].map(m => m[1]!)
    const bad = specs.filter(s => !MOUNT_SEAM.test(s))
    if (specs.length === 0 || bad.length > 0) {
      offenders.push(`${file}${bad.length > 0 ? ` → ${bad.join(', ')}` : ' (reference without a mount-seam import)'}`)
    }
  }
  check(
    'every product reference imports ONLY the mount seams (engineMount · terminalOut)',
    offenders.length === 0,
    offenders.join(' | '),
  )

  // Behavioral dormancy at the seam itself: the mount refuses flag-off.
  const { mountCockpitEngine, cockpitEngine, installCockpitEngineForTest } = await import(
    '../../src/render-engine/cockpit/engineMount.ts'
  )
  installCockpitEngineForTest(null)
  deleteFlagEnv('MERCURY_RENDER_ENGINE')
  const fakeTty = { isTTY: true, fd: 1, write: () => true } as never
  const refused = mountCockpitEngine({ stdout: fakeTty, columns: 80 })
  check('the mount refuses to construct with the flag off', refused === null && cockpitEngine() === null)
}

section('§4 the demo refuses to run with the gate off')
{
  const res = spawnSync(process.execPath, ['run', 'scripts/render-engine/demo-surface.ts', '--duration-ms', '100'], {
    cwd: root,
    env: { ...process.env, MERCURY_RENDER_ENGINE: '0' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  // The demo stamps '1' itself only when the operator has not pinned the
  // gate; a forced '0' must win at the gate read.
  check(
    'a forced-off gate is honored (demo exits non-zero, names the gate)',
    res.status === 2 && (res.stderr ?? '').includes('MERCURY_RENDER_ENGINE'),
    `status ${res.status}`,
  )
}

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
