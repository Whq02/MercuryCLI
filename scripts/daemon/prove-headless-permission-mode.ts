#!/usr/bin/env bun

(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const savedMode = process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

const {
  buildRunnerInvocation,
  getHeadlessPermissionMode,
  headlessPermissionArgv,
  HEADLESS_PERMISSION_MODES,
  HEADLESS_PERMISSION_MODE_DEFAULT,
} = await import('../../src/daemon/runner-link/headlessRun.js')
const { PERMISSION_MODES } = await import('../../src/permissions/rules/permissions.js')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.js')

let failures = 0
const WHERE_TO_LOOK = 'fix the posture words in src/daemon/runner-link/headlessRun.ts (getHeadlessPermissionMode, headlessPermissionArgv, buildRunnerInvocation, HEADLESS_PERMISSION_MODES) or the MERCURY_DAEMON_PERMISSION_MODE entry in FLAG_REGISTRY'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ` (${WHERE_TO_LOOK})`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const SPEC = {
  model: 'claude-opus-4-8',
  effort: 'max',
  appendSystemPrompt: 'pack',
  role: 'MERCURY_CONCOURSE_WORKER' as const,
  agentName: 'scout',
  agentId: 'scout-1',
}
const buildArgv = (): string[] => buildRunnerInvocation(SPEC).argv
const hasPair = (argv: string[], mode: string): boolean => {
  const i = argv.indexOf('--mode')
  return i >= 0 && argv[i + 1] === mode
}

console.log('============================================================')
console.log(' daemon child permission posture — proof')
console.log('============================================================')

section('default posture (env unset) — a child with no saved, carried or operator-set posture boots default')
{
  check(
    "default constant is 'default' (a daemon child with nothing saved boots the way a fresh session does)",
    HEADLESS_PERMISSION_MODE_DEFAULT === 'default',
  )
  check('resolver: unset env ⇒ default', getHeadlessPermissionMode() === 'default')
  const argv = buildArgv()
  check('long-lived argv carries no posture words (default supplies no flag)', !argv.includes('--mode'))
  check('no bypass flag by default', !argv.includes('--sovereign'))
  check('argv serves the runner door', argv[1] === 'runner' && !argv.includes('--input=rows'))
  check('argv still carries the floored --model', argv.includes('--model'))
  check('the row feed is complete on its own: argv carries no --verbose', !argv.includes('--verbose'))
}

section('operator overrides — live-read per spawn, no re-import')
{
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
  check("'implement' resolves (the earlier posture stays selectable)", getHeadlessPermissionMode() === 'implement')
  check("'implement' argv pair", hasPair(buildArgv(), 'implement'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'frobnicate'
  check("a word outside the mode list falls back to the default posture", getHeadlessPermissionMode() === 'default' && !buildArgv().includes('--mode'))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'flow'
  check("'flow' resolves and spells its pair (the flag's own value keeps its road)", getHeadlessPermissionMode() === 'flow' && hasPair(buildArgv(), 'flow'))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'sovereign'
  check("the mode reader selects the sovereign launch arm", buildArgv().includes('--sovereign'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'dontAsk'
  check("'dontAsk' argv pair (live re-read between spawns)", hasPair(buildArgv(), 'dontAsk'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'sovereign'
  const bypass = buildArgv()
  check(
    "'sovereign' spells --sovereign (spawnMultiAgent mapping)",
    bypass.includes('--sovereign'),
  )
  check("'sovereign' never also emits --mode", !bypass.includes('--mode'))

  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'default'
  const bare = buildArgv()
  check(
    "'default' is the bare boot (no posture words)",
    !bare.includes('--mode') && !bare.includes('--sovereign'),
  )
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
  const withPair = buildArgv()
  const stripped = withPair.filter((w, i, a) => !(w === '--mode' || a[i - 1] === '--mode'))
  check(
    'posture pair is the ONLY argv delta vs the bare boot',
    JSON.stringify(stripped) === JSON.stringify(bare),
  )
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
  check('unset env builds the bare boot byte for byte', JSON.stringify(buildArgv()) === JSON.stringify(bare))
}

section('the mode typed for this start — a typed default is spelled; a default nobody typed keeps the bare boot')
{
  const argvOf = (posture: Record<string, unknown>, respawn = false): string[] => buildRunnerInvocation({ ...SPEC, ...posture } as never, { respawn }).argv
  const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b)
  const bare = buildArgv()
  const typed = argvOf({ permissionMode: 'default', permissionModeTyped: true })
  check("a typed default spells --mode default (the runner's saved mode cannot take its place)", hasPair(typed, 'default'), JSON.stringify(typed.slice(1, 6)))
  check('…and that pair is the ONLY argv delta vs the bare boot', same(typed.filter((w, i, a) => !(w === '--mode' || a[i - 1] === '--mode')), bare))
  check('a respawn of that seat spells it again', hasPair(argvOf({ permissionMode: 'default', permissionModeTyped: true }, true), 'default'))
  check('a default nobody typed keeps the bare boot byte for byte', same(argvOf({ permissionMode: 'default' }), bare))
  const consented = argvOf({ permissionMode: 'default', permissionModeTyped: true, allowBypass: true })
  check('a typed default beside the launch consent spells both, never the bypass launch', hasPair(consented, 'default') && consented.includes('--allow-sovereign') && !consented.includes('--sovereign'))
  for (const mode of ['implement', 'flow', 'dontAsk', 'apollo', 'sovereign']) {
    check(`'${mode}' spells the same words typed or not (the typed word adds --mode default and nothing else)`, same(argvOf({ permissionMode: mode, permissionModeTyped: true }), argvOf({ permissionMode: mode })))
  }
  check('the speller itself: (default, typed) ⇒ [--mode, default] · (default) ⇒ []', same(headlessPermissionArgv('default', false, true), ['--mode', 'default']) && headlessPermissionArgv('default').length === 0)
  process.env.MERCURY_DAEMON_PERMISSION_MODE = 'flow'
  const overridden = argvOf({ permissionMode: 'default', permissionModeTyped: true })
  check("the operator's daemon env still wins over a typed default (its own pair, no second one)", hasPair(overridden, 'flow') && overridden.filter(w => w === '--mode').length === 1)
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
}

section('hostile / invalid values fall back, never leak into argv')
{
  for (const bad of ['plan', 'scribe', 'bubble', 'ACCEPTEDITS', 'yes', '--verbose']) {
    process.env.MERCURY_DAEMON_PERMISSION_MODE = bad
    const argv = buildArgv()
    check(
      `invalid '${bad}' ⇒ the default posture (no posture words)`,
      getHeadlessPermissionMode() === 'default' && !argv.includes('--mode') && !argv.includes('--sovereign'),
    )
  }
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
}

section('cross-checks against the real CLI + the one-shot seam')
{
  for (const m of HEADLESS_PERMISSION_MODES) {
    if (m === 'default' || m === 'sovereign') continue
    check(
      `CLI accepts --mode ${m}`,
      (PERMISSION_MODES as readonly string[]).includes(m),
    )
  }
  check(
    'MERCURY_DAEMON_PERMISSION_MODE registered → headlessRun consumer',
    getFlagSpec('MERCURY_DAEMON_PERMISSION_MODE')?.consumer.includes('src/daemon/runner-link/headlessRun.ts') === true,
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
