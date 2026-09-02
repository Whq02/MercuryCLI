#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-headless-permission-mode.ts
//  PROOF: the daemon child permission posture (the recon-access P0 fix).
//
//  The gap under proof: a daemon child runs `-p` (print mode) where NO
//  permission prompt exists — getCanUseToolFn's no-prompt path resolves every
//  'ask' to a terminal deny (src/cli/print.ts:4297). Pre-fix, BOTH daemon argv
//  builders (buildStreamJsonInvocation for the long-lived crew and session
//  children; runTaskHeadless for cron one-shots) passed no permission
//  flag at all, so children booted 'default' mode and every non-rule-allowed
//  tool call silently died — indistinguishable from a tool failure upstream.
//
//  The fix under proof: both builders stamp an operator-configurable posture
//  (MERCURY_DAEMON_PERMISSION_MODE, live-read per spawn; the flag mapping
//  mirrors spawnMultiAgent.ts:236 — bypass is spelled
//  --dangerously-skip-permissions, 'default' restores the bare pre-fix boot).
//  worker-shell floor: unset ⇒ 'flow' (was the implement posture,
//  under which a `-p` child's every Bash ask terminal-denied — shell dead; the
//  party run-#2 stall generalized to the whole fleet). One-shots honor
//  spec.permissionMode + spec.allowedTools like the long-lived seam.
//
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-headless-permission-mode.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Fork-sim BEFORE any dynamic import (the build stamp reads MACRO.VERSION).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const savedMode = process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

const {
  buildStreamJsonInvocation,
  getHeadlessPermissionMode,
  headlessPermissionArgv,
  HEADLESS_PERMISSION_MODES,
  HEADLESS_PERMISSION_MODE_DEFAULT,
} = await import('../../src/daemon/headlessRun.js')
const { PERMISSION_MODES } = await import('../../src/types/permissions.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const SPEC = {
  model: 'claude-opus-4-8',
  effort: 'max',
  appendSystemPrompt: 'pack',
  role: 'MERCURY_CREW' as const,
  agentName: 'scout',
  agentId: 'scout-1',
}
const buildArgv = (): string[] => buildStreamJsonInvocation(SPEC).argv
const hasPair = (argv: string[], mode: string): boolean => {
  const i = argv.indexOf('--permission-mode')
  return i >= 0 && argv[i + 1] === mode
}

console.log('============================================================')
console.log(' daemon child permission posture — proof')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('default posture (env unset) — the fix itself')
{
  check(
    "default constant is 'flow' (the worker-shell floor: classifier-adjudicated shell for every daemon child)",
    HEADLESS_PERMISSION_MODE_DEFAULT === 'flow',
  )
  check('resolver: unset env ⇒ flow', getHeadlessPermissionMode() === 'flow')
  const argv = buildArgv()
  check('long-lived argv carries --permission-mode flow', hasPair(argv, 'flow'))
  check('no bypass flag by default', !argv.includes('--dangerously-skip-permissions'))
  check('argv still stream-json shaped', argv.includes('--input-format=stream-json'))
  check('argv still carries the floored --model', argv.includes('--model'))
}

// ───────────────────────────────────────────────────────────────────────────
section('operator overrides — live-read per spawn, no re-import')
{
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
  check("'implement' resolves (the earlier posture stays selectable)", getHeadlessPermissionMode() === 'implement')
  check("'implement' argv pair", hasPair(buildArgv(), 'implement'))

  // Retired spellings decode through the bounded alias at this env boundary
  // (an operator shell profile from before the mode-identity migration keeps
  // working) — and the argv the child sees carries ONLY the new id.
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'acceptEdits'
  check("retired 'acceptEdits' decodes to 'implement' (bounded alias at the env boundary)", getHeadlessPermissionMode() === 'implement')
  check("retired 'acceptEdits' argv pair carries the NEW id", hasPair(buildArgv(), 'implement'))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'auto'
  check("retired 'auto' decodes to 'flow'", getHeadlessPermissionMode() === 'flow' && hasPair(buildArgv(), 'flow'))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'bypassPermissions'
  check("retired 'bypassPermissions' decodes to 'sovereign' (spells the bypass arm)", buildArgv().includes('--dangerously-skip-permissions'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'dontAsk'
  check("'dontAsk' argv pair (live re-read between spawns)", hasPair(buildArgv(), 'dontAsk'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'sovereign'
  const bypass = buildArgv()
  check(
    "'sovereign' spells --dangerously-skip-permissions (spawnMultiAgent mapping)",
    bypass.includes('--dangerously-skip-permissions'),
  )
  check("'sovereign' never also emits --permission-mode", !bypass.includes('--permission-mode'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'default'
  const bare = buildArgv()
  check(
    "'default' restores the bare pre-fix boot (no posture words)",
    !bare.includes('--permission-mode') && !bare.includes('--dangerously-skip-permissions'),
  )
  // Structural equivalence: the unset-argv is EXACTLY the bare argv + the pair,
  // i.e. the posture is the only delta the fix introduces into the invocation.
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
  const withPair = buildArgv()
  const stripped = withPair.filter((w, i, a) => !(w === '--permission-mode' || a[i - 1] === '--permission-mode'))
  check(
    'posture pair is the ONLY argv delta vs the bare boot',
    JSON.stringify(stripped) === JSON.stringify(bare),
  )
}

// ───────────────────────────────────────────────────────────────────────────
section('hostile / invalid values fall back, never leak into argv')
{
  // 'plan' decodes through the bounded alias to 'strategy' — which is STILL
  // not a daemon posture, so even the alias cannot smuggle an interactive
  // mode into a headless child.
  for (const bad of ['plan', 'scribe', 'bubble', 'ACCEPTEDITS', 'yes', '--verbose']) {
    process.env.MERCURY_DAEMON_PERMISSION_MODE = bad
    const argv = buildArgv()
    check(
      `invalid '${bad}' ⇒ flow fallback (the daemon default)`,
      getHeadlessPermissionMode() === 'flow' && hasPair(argv, 'flow'),
    )
  }
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
}

// ───────────────────────────────────────────────────────────────────────────
section('cross-checks against the real CLI + the one-shot seam')
{
  // Every posture we emit as `--permission-mode X` must be a mode the CLI's
  // choices() actually accepts in the stamped build, or the child dies at parse.
  for (const m of HEADLESS_PERMISSION_MODES) {
    if (m === 'default' || m === 'sovereign') continue
    check(
      `CLI accepts --permission-mode ${m}`,
      (PERMISSION_MODES as readonly string[]).includes(m),
    )
  }
  // The cron one-shot seam (runTaskHeadless spawns a real node child — too
  // heavy to run here) is proven structurally: its spawn argv must thread the
  // SAME helper between '-p' and the prompt, honoring the spec fields the
  // long-lived seam honors (the one-shot was the last daemon
  // worker ignoring spec.permissionMode + spec.allowedTools).
  const src = readFileSync(join(import.meta.dir, '../../src/daemon/headlessRun.ts'), 'utf8')
  const oneShot = src.slice(src.indexOf('export function runTaskHeadless'))
  check(
    'runTaskHeadless spawn threads headlessPermissionArgv(spec.permissionMode)',
    oneShot.includes('...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode))'),
  )
  check(
    'runTaskHeadless spawn threads spec.allowedTools (the recon floor)',
    /spec\.allowedTools && spec\.allowedTools\.length > 0[\s\S]{0,120}'--allowedTools', \.\.\.spec\.allowedTools/.test(oneShot),
  )
  // The one-shot call site passes the recon floor — the "one recon env for
  // EVERY daemon worker" doctrine. (The legacy cron-fire site died with its
  // engine; SATURN fires ride session runners whose
  // posture is the seat's own.)
  const rosterSrc = readFileSync(join(import.meta.dir, '../../src/daemon/roster.ts'), 'utf8')
  check(
    'roster dispatch passes allowedTools: resolveWorkerReconAllow()',
    /runTaskHeadless\(\s*(?:\/\/[^\n]*\n\s*)*\{[\s\S]{0,300}allowedTools: resolveWorkerReconAllow\(\)/.test(rosterSrc),
  )
  // Registry honesty: the knob must be a registered flag (prove-flag-registry
  // enforces the same globally; this pins the row to the right consumer).
  const reg = readFileSync(join(import.meta.dir, '../../src/substrate/flagRegistry.ts'), 'utf8')
  check(
    'MERCURY_DAEMON_PERMISSION_MODE registered → headlessRun consumer',
    /MERCURY_DAEMON_PERMISSION_MODE'[^\n]*src\/daemon\/headlessRun\.ts/.test(reg),
  )
}

// Restore the operator's env.
if (savedMode === undefined) delete process.env.MERCURY_DAEMON_PERMISSION_MODE
else process.env.MERCURY_DAEMON_PERMISSION_MODE = savedMode

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — daemon children carry an explicit permission posture')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
