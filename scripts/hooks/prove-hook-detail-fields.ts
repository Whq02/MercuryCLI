#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-hook-detail-fields.ts — the /hooks detail card shows
//  the fields that DECIDE whether a hook runs (FC-082). The card rendered
//  event, matcher, type, source, command and spinner text — and none of
//  `if`, `timeout`, `shell`, `async`, `once`, so a hook gated to one
//  command read identically to one that fires on every call.
//
//  §1 THE REAL MOUNT: ViewHookMode under staticRender with a fully-adorned
//     command hook — all five gating rows present with their values.
//  §2 the bare-hook control: an unadorned hook's card carries NONE of the
//     five labels (unchanged).
//
//  Run: ~/.bun/bin/bun run scripts/hooks/prove-hook-detail-fields.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'hook-detail-prove-'))
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { ViewHookMode } = await import('../../src/components/hooks/ViewHookMode.js')

const mount = async (config: Record<string, unknown>): Promise<string> =>
  renderToString(
    React.createElement(ViewHookMode, {
      event: 'PostToolUse',
      matcher: 'Bash',
      supportsMatchers: true,
      hook: { config, source: 'projectSettings' },
      onBack: () => {},
    } as never),
    100,
  )

console.log('§1 the adorned hook — all five gating rows')
{
  const frame = await mount({
    type: 'command',
    command: 'echo done',
    if: 'Bash(git commit*)',
    timeout: 45,
    shell: 'powershell',
    async: true,
    once: true,
    statusMessage: 'linting',
  })
  check('If: renders with its permission-rule value', frame.includes('If:') && frame.includes('Bash(git commit*)'), frame.slice(0, 120))
  check('Timeout: renders in seconds', frame.includes('Timeout:') && frame.includes('45s'))
  check('Shell: renders', frame.includes('Shell:') && frame.includes('powershell'))
  check('Async: renders with the never-holds-the-turn fact', frame.includes('Async:') && frame.includes('never holds the turn'))
  check(
    'Once: renders the enforced promise (FC-108 re-true of the FC-082 deferral)',
    frame.includes('Once:') && frame.includes('runs once, then its entry is removed'),
  )
  check('the primary payload still renders (Command)', frame.includes('Command') && frame.includes('echo done'))
  check('the spinner text still renders separately', frame.includes('Status message:') && frame.includes('linting'))
}

console.log('§2 the bare hook — the card is unchanged')
{
  const frame = await mount({ type: 'command', command: 'echo plain' })
  check(
    'none of the five labels appear on an unadorned hook',
    !frame.includes('If:') && !frame.includes('Timeout:') && !frame.includes('Shell:') && !frame.includes('Async:') && !frame.includes('Once:'),
    frame.slice(0, 120),
  )
  check('the identifying rows still render', frame.includes('Event:') && frame.includes('PostToolUse') && frame.includes('echo plain'))
}

console.log(failures === 0 ? '\nprove-hook-detail-fields: all green' : `\nprove-hook-detail-fields: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
