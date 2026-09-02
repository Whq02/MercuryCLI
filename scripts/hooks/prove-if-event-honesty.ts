#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-if-event-honesty.ts — an `if` condition on a
//  non-tool event is a NAMED dead gate, never a silent permanent disable
//  (FC-109). The condition validated clean, the hook was then never
//  spawned and never mentioned on any stream: the if gate evaluates
//  against a tool dimension that SessionStart-class events do not have.
//
//  The skip stays (fail closed — running the hook would ignore the
//  operator's own narrowing); what changes is that it is SAID:
//  §1 the one-truth predicate (eventSupportsIfConditions).
//  §2 the headless drive: the hook still does not run, and ONE stderr
//     line names the condition, the event and the skip.
//  §3 the hook-detail card names the dead gate on the If row; a tool
//     event's card stays clean.
//
//  Run: ~/.bun/bin/bun run scripts/hooks/prove-if-event-honesty.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'ifev-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'ifev-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const matching = (await import('../../src/utils/hooks/matching.js')) as unknown as {
  eventSupportsIfConditions?: (event: string) => boolean
}
// Base-tolerant: at the pre-fix tree the predicate does not exist.
const predicateExported = typeof matching.eventSupportsIfConditions === 'function'
const supports = matching.eventSupportsIfConditions ?? ((): boolean => false)

section('§1 THE PREDICATE')
{
  check('the predicate is exported (eventSupportsIfConditions)', predicateExported)
  for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
    check(`${ev} carries the tool dimension`, supports(ev) === true)
  }
  for (const ev of ['SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit']) {
    check(`${ev} does not`, supports(ev) === false)
  }
}

section('§2 THE HEADLESS DRIVE: SKIPPED, AND SAID')
{
  const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd } = await import(
    '../../src/bootstrap/state.js'
  )
  const { setCwd } = await import('../../src/utils/Shell.js')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  const { captureHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
  const { executeSessionStartHooks } = await import('../../src/utils/hooks/events.js')

  const MARK = join(PROJ, 'if-mark')
  writeFileSync(
    join(HOME, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `echo ran >> ${MARK}`, if: 'Bash' }] },
        ],
      },
    }),
  )
  setCwd(PROJ)
  setOriginalCwd(PROJ)
  setProjectRoot(PROJ)
  setIsInteractive(false)
  setSessionTrustAccepted(true)
  resetSettingsCache()
  captureHooksConfigSnapshot()

  const captured: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: never[]): boolean => {
    captured.push(String(chunk))
    return realWrite(String(chunk), ...(rest as []))
  }) as typeof process.stderr.write
  try {
    for await (const _ of executeSessionStartHooks('startup')) {
      void _
    }
  } finally {
    process.stderr.write = realWrite
  }

  check('the hook still does NOT run (fail closed — no marker file)', !existsSync(MARK))
  const named = captured.join('')
  check(
    'one stderr line names the dead condition, the event, and the skip',
    named.includes('can never evaluate on SessionStart') && named.includes('"Bash"') && named.includes('skipped'),
    named.trim().split('\n').find(l => l.includes('never evaluate')) ?? '(no line)',
  )
}

section('§3 THE HOOK-DETAIL CARD NAMES THE DEAD GATE')
{
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { ViewHookMode } = await import('../../src/components/hooks/ViewHookMode.js')
  const mount = async (event: string): Promise<string> =>
    renderToString(
      React.createElement(ViewHookMode, {
        event,
        matcher: '',
        supportsMatchers: false,
        hook: { config: { type: 'command', command: 'echo x', if: 'Bash' }, source: 'userSettings' },
        onBack: () => {},
      } as never),
      100,
    )
  const dead = await mount('SessionStart')
  check(
    "a SessionStart hook's If row says it is never evaluated and will not run",
    dead.includes('never evaluated') && dead.includes('no tool input') && dead.includes('will not run'),
    dead.split('\n').find(l => l.includes('If:')) ?? '(no If row)',
  )
  const live = await mount('PostToolUse')
  check("a PostToolUse hook's If row stays clean", live.includes('If:') && !live.includes('never evaluated'))
}

console.log(failures === 0 ? '\nprove-if-event-honesty: all green' : `\nprove-if-event-honesty: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
