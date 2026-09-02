#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-seat-permission-mode.ts — the seat's initial
//  permission mode (the operator's line-10 parity edit at the unsoldering
//  signing): a seat is a full Mercury instance, so it boots in the OPERATOR'S
//  SAVED DEFAULT (settings.permissions.defaultMode) when one is set — never a
//  posture more permissive than the operator's own by accident. A dispatch may
//  carry an explicit override; when neither is set the fallback stays today's
//  'flow' for board-spawned workers.
//
//   M1  an explicit override that is a valid headless posture wins;
//   M2  no override + a SAVED default (a scratch home) ⇒ the seat boots that
//       default (the whole point: 'default' shows no "✦ flow on" badge);
//   M3  no override + NO saved default ⇒ today's 'flow' (unchanged);
//   M4  a saved default outside the headless set (e.g. 'plan') ⇒ 'flow', never
//       a seat booted in an unintended posture;
//   M5  an unreadable settings store fails soft to 'flow' (never blocks a
//       spawn) — the poison control.
//  getInitialSettings memoizes per process, so each scenario resolves in its
//  OWN fresh bun subprocess with its own scratch MERCURY_CONFIG_DIR — a true
//  unit read of the resolver, no cross-scenario cache bleed.
// ============================================================================
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

/** Resolve seatInitialPermissionMode in a fresh process: write the scratch
 *  home's settings.json, then import the resolver and print its answer. */
function resolveIn(opts: { defaultMode?: string; override?: string; home?: string }): string {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'seat-perm-mode-'))
  if (opts.home === undefined) {
    const settings = opts.defaultMode === undefined ? {} : { permissions: { defaultMode: opts.defaultMode } }
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
      // the daemon-permission env override must not shadow the resolver
      MERCURY_DAEMON_PERMISSION_MODE: '',
    },
  })
  return (res.stdout ?? '').trim()
}

// ── M1: an explicit override wins ──
check("M1 override 'default' is honored", resolveIn({ override: 'default' }) === 'default')
check("M1 override 'sovereign' is honored", resolveIn({ override: 'sovereign' }) === 'sovereign')
check("M1 override 'flow' is honored", resolveIn({ override: 'flow' }) === 'flow')

// ── M2: a saved default, no override ──
check("M2 saved 'default' ⇒ the seat boots 'default' (no '✦ flow on' badge)", resolveIn({ defaultMode: 'default' }) === 'default')
{
  const m = resolveIn({ defaultMode: 'acceptEdits' })
  check("M2 saved 'acceptEdits' ⇒ a valid headless posture, never 'flow'", m !== 'flow' && m.length > 0, m)
}
check("M2 saved 'sovereign' ⇒ the seat boots 'sovereign'", resolveIn({ defaultMode: 'sovereign' }) === 'sovereign')

// ── M3: no saved default ⇒ today's 'flow' (unchanged) ──
check("M3 no saved default, no override ⇒ 'flow' (today's behavior held)", resolveIn({}) === 'flow')

// ── M4: a saved default outside the headless set ⇒ 'flow' ──
check("M4 saved 'plan' (not a headless posture) ⇒ 'flow', never an unintended mode", resolveIn({ defaultMode: 'plan' }) === 'flow')

// ── M5: the poison control — an unreadable store fails soft to 'flow' ──
check(
  'M5 an unreadable settings store fails soft to flow (never blocks a spawn)',
  resolveIn({ home: join(mkdtempSync(join(tmpdir(), 'seat-perm-gone-')), 'does', 'not', 'exist') }) === 'flow',
)

console.log(failures === 0 ? '\nprove-seat-permission-mode: ALL LAWS HOLD' : `\nprove-seat-permission-mode: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
