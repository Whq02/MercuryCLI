#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  role: 'MERCURY_IMPLEMENTER' as const,
  agentName: 'imp',
  agentId: 'imp-1',
}
const buildArgv = (): string[] => buildStreamJsonInvocation(SPEC).argv
const hasPair = (argv: string[], mode: string): boolean => {
  const i = argv.indexOf('--permission-mode')
  return i >= 0 && argv[i + 1] === mode
}

console.log('============================================================')
console.log(' daemon child permission posture — proof')
console.log('============================================================')

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

section('operator overrides — live-read per spawn, no re-import')
{
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
  check("'implement' resolves (the earlier posture stays selectable)", getHeadlessPermissionMode() === 'implement')
  check("'implement' argv pair", hasPair(buildArgv(), 'implement'))

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
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
  const withPair = buildArgv()
  const stripped = withPair.filter((w, i, a) => !(w === '--permission-mode' || a[i - 1] === '--permission-mode'))
  check(
    'posture pair is the ONLY argv delta vs the bare boot',
    JSON.stringify(stripped) === JSON.stringify(bare),
  )
}

section('hostile / invalid values fall back, never leak into argv')
{
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

section('cross-checks against the real CLI + the one-shot seam')
{
  for (const m of HEADLESS_PERMISSION_MODES) {
    if (m === 'default' || m === 'sovereign') continue
    check(
      `CLI accepts --permission-mode ${m}`,
      (PERMISSION_MODES as readonly string[]).includes(m),
    )
  }
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
  const rosterSrc = readFileSync(join(import.meta.dir, '../../src/daemon/roster.ts'), 'utf8')
  check(
    'roster dispatch passes allowedTools: resolveWorkerReconAllow()',
    /runTaskHeadless\(\s*(?:\/\/[^\n]*\n\s*)*\{[\s\S]{0,300}allowedTools: resolveWorkerReconAllow\(\)/.test(rosterSrc),
  )
  const reg = readFileSync(join(import.meta.dir, '../../src/substrate/flagRegistry.ts'), 'utf8')
  check(
    'MERCURY_DAEMON_PERMISSION_MODE registered → headlessRun consumer',
    /MERCURY_DAEMON_PERMISSION_MODE'[^\n]*src\/daemon\/headlessRun\.ts/.test(reg),
  )
}

if (savedMode === undefined) delete process.env.MERCURY_DAEMON_PERMISSION_MODE
else process.env.MERCURY_DAEMON_PERMISSION_MODE = savedMode

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — daemon children carry an explicit permission posture')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
